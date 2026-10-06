#!/usr/bin/env bun
// allow: SIZE_OK — Bun's WebSocket lifecycle is one protocol state machine over shared socket and topic state.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isMentioned, isValidAgentName, isValidChannelName, parseMentions } from "../lib.ts";
import type { AgentMailMessage, AgentRegistration, AllClaims, HistoryEntry } from "../lib.ts";
import { HISTORY_PAGE_MAX, MESH_CLOSE, MESH_SUBPROTOCOL, parseFrame } from "./protocol.ts";
import type { ChannelSnapshot, ClientFrame, ReplyResult, ServerFrame } from "./protocol.ts";
import { openPersist } from "./persist.ts";
import type { Persist } from "./persist.ts";
import { createServerState } from "./server-state.ts";
import type { ServerState } from "./server-state.ts";

interface SocketData {
  name: string | null;
  channels: Set<string>;
  /** Channels observed with `watch` (log, presence and claims, without membership). */
  watching: Set<string>;
  helloTimer: Timer | null;
}

export interface MeshServer {
  readonly port: number;
  readonly hostname: string;
  stop(): Promise<void>;
}

export interface MeshServerOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly token: string;
  readonly dataDir?: string;
}

const peersTopic = (channel: string): string => `peers:${channel}`;
const claimsTopic = (channel: string): string => `claims:${channel}`;
const inboxTopic = (channel: string, name: string): string => `inbox:${channel}:${name}`;
const logTopic = (channel: string): string => `log:${channel}`;
/** Every authenticated socket subscribes: channel-list changes. */
const CHANNELS_TOPIC = "channels";

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function sendFrame(ws: Bun.ServerWebSocket<SocketData>, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}

function sendReply(ws: Bun.ServerWebSocket<SocketData>, id: string, result: ReplyResult): void {
  sendFrame(ws, { t: "reply", id, result });
}

export function startMeshServer(opts: MeshServerOptions): MeshServer {
  const hostname = opts.hostname ?? "127.0.0.1";
  const persist: Persist | undefined = opts.dataDir ? openPersist(opts.dataDir) : undefined;
  const state: ServerState = createServerState(persist);
  const expectedToken = tokenDigest(opts.token);
  const peerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const claimTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Authoritative inbox ownership: topic → the socket that registered it. subscriberCount
   *  alone cannot distinguish a live peer from a zombie socket mid-reap, which used to lock
   *  a reconnecting agent out with name_taken until manual rejoin. */
  const inboxOwners = new Map<string, Bun.ServerWebSocket<SocketData>>();
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();

  /** Release ownership held by `ws`, and drop presence for sockets that are gone. */
  const releaseInbox = (channel: string, name: string, ws: Bun.ServerWebSocket<SocketData>): void => {
    const topic = inboxTopic(channel, name);
    if (inboxOwners.get(topic) === ws) inboxOwners.delete(topic);
  };
  let stopped = false;
  let channelsTimer: Timer | null = null;
  let lastChannelList = "";

  /** Push the channel list to every socket when it changed: a channel created or emptied, or a member count moved. */
  const broadcastChannels = (): void => {
    if (stopped || channelsTimer) return;
    channelsTimer = setTimeout(() => {
      channelsTimer = null;
      const channels = state.listChannels();
      const json = JSON.stringify(channels);
      if (json === lastChannelList) return;
      lastChannelList = json;
      server.publish(CHANNELS_TOPIC, JSON.stringify({ t: "channel_list", channels } satisfies ServerFrame));
    }, 100);
  };

  const broadcastPeers = (channel: string): void => {
    if (stopped || peerTimers.has(channel)) return;
    peerTimers.set(channel, setTimeout(() => {
      peerTimers.delete(channel);
      const peers = [...(state.channels.get(channel)?.presence.values() ?? [])];
      server.publish(peersTopic(channel), JSON.stringify({ t: "peers", channel, peers } satisfies ServerFrame));
      // Every presence change (join, part, close) comes through here, so the channel list follows it.
      broadcastChannels();
    }, 50));
  };

  const broadcastClaims = (channel: string): void => {
    if (stopped || claimTimers.has(channel)) return;
    claimTimers.set(channel, setTimeout(() => {
      claimTimers.delete(channel);
      const claims: AllClaims = state.channels.get(channel)?.claims ?? {};
      server.publish(claimsTopic(channel), JSON.stringify({ t: "claims", channel, claims } satisfies ServerFrame));
    }, 50));
  };

  const snapshot = (channel: string): ChannelSnapshot => {
    const current = state.getOrCreate(channel);
    return {
      channel,
      peers: [...current.presence.values()],
      claims: current.claims,
      completions: current.completions,
    };
  };

  /** Log a delivered message and push it to the channel's watchers. */
  const record = (entry: Omit<HistoryEntry, "seq">): HistoryEntry => {
    const logged = state.appendLog(entry);
    server.publish(logTopic(entry.channel), JSON.stringify({ t: "log", channel: entry.channel, entry: logged } satisfies ServerFrame));
    return logged;
  };

  /**
   * Remove `member` (on `sock`) from `channel` and tell it with a `removed` frame. A member left
   * with no channel joins `main` so it stays reachable (unless another live socket holds its
   * name there). Returns whether it was moved to `main`.
   */
  const evict = (
    sock: Bun.ServerWebSocket<SocketData>,
    member: string,
    channel: string,
    by: string,
    registration: AgentRegistration,
  ): boolean => {
    sock.data.channels.delete(channel);
    sock.unsubscribe(inboxTopic(channel, member));
    releaseInbox(channel, member, sock);
    if (!sock.data.watching.has(channel)) {
      sock.unsubscribe(peersTopic(channel));
      sock.unsubscribe(claimsTopic(channel));
    }
    const added: ChannelSnapshot[] = [];
    if (sock.data.channels.size === 0) {
      const owner = inboxOwners.get(inboxTopic("main", member));
      if (owner === undefined || owner === sock || owner.readyState !== WebSocket.OPEN) {
        sock.data.channels.add("main");
        sock.subscribe(peersTopic("main"));
        sock.subscribe(claimsTopic("main"));
        sock.subscribe(inboxTopic("main", member));
        inboxOwners.set(inboxTopic("main", member), sock);
        state.getOrCreate("main").presence.set(member, { ...registration, name: member });
        added.push(snapshot("main"));
        broadcastPeers("main");
      }
    }
    sendFrame(sock, { t: "removed", channel, by, channels: [...sock.data.channels].sort(), added });
    return added.length > 0;
  };

  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname,
    routes: { "/healthz": new Response("ok") },
    fetch(request, bunServer) {
      const offered = request.headers.get("sec-websocket-protocol");
      const acceptsProtocol = offered?.split(",").some((protocol) => protocol.trim() === MESH_SUBPROTOCOL) ?? false;
      if (!acceptsProtocol) {
        return new Response("omp-messenger-mesh: subprotocol omp-messenger.v2 required", { status: 426 });
      }
      const upgraded = bunServer.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": MESH_SUBPROTOCOL },
        data: { name: null, channels: new Set<string>(), watching: new Set<string>(), helloTimer: null },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
      idleTimeout: 60,
      maxPayloadLength: 1_048_576,
      perMessageDeflate: false,
      sendPings: true,
      open(ws) {
        sockets.add(ws);
        ws.data.helloTimer = setTimeout(() => ws.close(MESH_CLOSE.HELLO_TIMEOUT, "hello timeout"), 5_000);
      },
      message(ws, raw) {
        const frame = parseFrame<ClientFrame>(raw);
        if (!frame) {
          ws.close(MESH_CLOSE.BAD_FRAME);
          return;
        }

        if (ws.data.name === null) {
          if (frame.t !== "hello") {
            ws.close(MESH_CLOSE.BAD_FRAME);
            return;
          }
          if (typeof frame.token !== "string" || !timingSafeEqual(expectedToken, tokenDigest(frame.token))) {
            sendFrame(ws, { t: "reject", error: "bad_token" });
            ws.close(MESH_CLOSE.BAD_TOKEN);
            return;
          }
          if (!Array.isArray(frame.channels) || frame.channels.length === 0) {
            sendFrame(ws, { t: "reject", error: "invalid_channel" });
            return;
          }
          const invalid = frame.channels.find((channel) => !isValidChannelName(channel));
          if (invalid !== undefined) {
            sendFrame(ws, { t: "reject", error: "invalid_channel", channel: invalid });
            return;
          }
          const name = frame.agent?.name;
          if (!isValidAgentName(name)) {
            sendFrame(ws, { t: "reject", error: "invalid_name" });
            return;
          }
          const deleted = [...new Set(frame.channels)].filter(channel => state.isDeleted(channel));
          const requested = [...new Set(frame.channels)].filter(channel => !state.isDeleted(channel));
          if (!requested.length) requested.push("main");
          // name_taken only when a DIFFERENT, still-open socket owns the inbox. A zombie
          // (partitioned, closing, heartbeat-reap pending) is evicted so a reconnecting
          // agent can reclaim its own name.
          let taken: string | undefined;
          for (const channel of requested) {
            const topic = inboxTopic(channel, name);
            const owner = inboxOwners.get(topic);
            if (owner === undefined || owner.readyState !== WebSocket.OPEN) {
              if (owner !== undefined && owner !== ws) {
                inboxOwners.delete(topic);
                state.dropAgent(channel, name);
                broadcastPeers(channel);
              }
              continue;
            }
            if (owner !== ws) taken = channel;
          }
          if (taken !== undefined) {
            sendFrame(ws, { t: "reject", error: "name_taken", channel: taken });
            return;
          }

          clearTimeout(ws.data.helloTimer);
          ws.data.helloTimer = null;
          ws.data.name = name;
          ws.subscribe(CHANNELS_TOPIC);
          for (const channel of requested) {
            ws.data.channels.add(channel);
            ws.subscribe(peersTopic(channel));
            ws.subscribe(claimsTopic(channel));
            ws.subscribe(inboxTopic(channel, name));
            inboxOwners.set(inboxTopic(channel, name), ws);
            state.getOrCreate(channel).presence.set(name, { ...frame.agent, name });
          }
          const claimChannels = new Set<string>();
          for (const assertion of Array.isArray(frame.claims) ? frame.claims : []) {
            const channel = assertion?.channel;
            if (typeof channel !== "string" || !ws.data.channels.has(channel)) continue;
            const result = state.claim(channel, name, assertion.spec, assertion.taskId, assertion.reason);
            if (result.success) claimChannels.add(channel);
          }
          sendFrame(ws, { t: "welcome", name, channels: requested.map(snapshot) });
          for (const channel of deleted) {
            sendFrame(ws, { t: "removed", channel, by: "server", channels: requested, added: [] });
            sendFrame(ws, {
              t: "message", channel: requested[0], message: {
                id: randomUUID(), from: "server", to: name, text: `#${channel} was deleted while you were disconnected. You have not rejoined it.`,
                channel: requested[0], timestamp: new Date().toISOString(), replyTo: null,
              }
            });
          }
          for (const channel of requested) broadcastPeers(channel);
          for (const channel of claimChannels) broadcastClaims(channel);
          return;
        }

        const name = ws.data.name;
        switch (frame.t) {
          case "publish": {
            for (const channel of ws.data.channels) {
              state.getOrCreate(channel).presence.set(name, { ...frame.agent, name });
              broadcastPeers(channel);
            }
            return;
          }
          case "join": {
            if (!Array.isArray(frame.channels)) {
              ws.close(MESH_CLOSE.BAD_FRAME);
              return;
            }
            const requested = [...new Set(frame.channels)];
            const invalid = requested.find((channel) => !isValidChannelName(channel));
            if (invalid !== undefined) {
              sendReply(ws, frame.id, { ok: false, error: "invalid_channel", channel: invalid });
              return;
            }
            const added = requested.filter((channel) => !ws.data.channels.has(channel));
            const taken = added.find((channel) => {
              const owner = inboxOwners.get(inboxTopic(channel, name));
              return owner !== undefined && owner !== ws && owner.readyState === WebSocket.OPEN;
            });
            if (taken !== undefined) {
              sendReply(ws, frame.id, { ok: false, error: "name_taken", channel: taken });
              return;
            }
            if (added.length > 0) {
              let agent: AgentRegistration | undefined;
              for (const channel of ws.data.channels) {
                agent = state.channels.get(channel)?.presence.get(name);
                if (agent) break;
              }
              if (!agent) {
                sendReply(ws, frame.id, { ok: false, error: "not_joined", channel: added[0] });
                return;
              }
              for (const channel of added) {
                ws.data.channels.add(channel);
                ws.subscribe(peersTopic(channel));
                ws.subscribe(claimsTopic(channel));
                ws.subscribe(inboxTopic(channel, name));
                inboxOwners.set(inboxTopic(channel, name), ws);
                state.getOrCreate(channel).presence.set(name, { ...agent, name });
              }
            }
            sendReply(ws, frame.id, { ok: true, channels: requested.map(snapshot) });
            for (const channel of added) broadcastPeers(channel);
            return;
          }
          case "part": {
            if (!Array.isArray(frame.channels)) {
              ws.close(MESH_CLOSE.BAD_FRAME);
              return;
            }
            for (const channel of new Set(frame.channels)) {
              if (!ws.data.channels.delete(channel)) continue;
              // A watched channel keeps its presence and claims feed after the socket leaves it.
              if (!ws.data.watching.has(channel)) {
                ws.unsubscribe(peersTopic(channel));
                ws.unsubscribe(claimsTopic(channel));
              }
              ws.unsubscribe(inboxTopic(channel, name));
              releaseInbox(channel, name, ws);
              state.dropAgent(channel, name);
              broadcastPeers(channel);
              broadcastClaims(channel);
            }
            sendReply(ws, frame.id, { ok: true, channels: [...ws.data.channels].sort() });
            if (ws.data.channels.size === 0) ws.close(1000);
            return;
          }
          case "channels":
            sendReply(ws, frame.id, state.listChannels());
            return;
          case "send": {
            if (!ws.data.channels.has(frame.channel)) {
              sendReply(ws, frame.id, { ok: false, error: "not_found" });
              return;
            }
            if (!isValidAgentName(frame.to)) {
              sendReply(ws, frame.id, { ok: false, error: "invalid_name" });
              return;
            }
            const topic = inboxTopic(frame.channel, frame.to);
            if (server.subscriberCount(topic) === 0) {
              sendReply(ws, frame.id, { ok: false, error: "not_found" });
              return;
            }
            // Stamp the authenticated identity: the token authorizes the connection, not
            // arbitrary sender names. `from`/`to` come from the handshake, never the frame.
            const message: AgentMailMessage = { ...frame.message, from: ws.data.name, to: frame.to, channel: frame.channel };
            server.publish(topic, JSON.stringify({ t: "message", channel: frame.channel, message } satisfies ServerFrame));
            record({
              id: typeof message.id === "string" ? message.id : randomUUID(),
              channel: frame.channel,
              kind: "dm",
              from: ws.data.name,
              to: frame.to,
              mentions: [],
              text: typeof message.text === "string" ? message.text : "",
              timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString(),
              replyTo: typeof message.replyTo === "string" ? message.replyTo : null,
            });
            sendReply(ws, frame.id, { ok: true, message });
            return;
          }
          case "post": {
            if (!isValidChannelName(frame.channel)) {
              sendReply(ws, frame.id, { ok: false, error: "invalid_channel" });
              return;
            }
            if (!ws.data.channels.has(frame.channel)) {
              sendReply(ws, frame.id, { ok: false, error: "not_joined" });
              return;
            }
            const text = typeof frame.text === "string" ? frame.text.trim() : "";
            if (text === "") {
              sendReply(ws, frame.id, { ok: false, error: "empty" });
              return;
            }
            const members = [...(state.channels.get(frame.channel)?.presence.keys() ?? [])];
            const entry = record({
              id: randomUUID(),
              channel: frame.channel,
              kind: "post",
              from: name,
              to: null,
              mentions: parseMentions(text, members),
              text,
              timestamp: new Date().toISOString(),
              replyTo: typeof frame.replyTo === "string" ? frame.replyTo : null,
            });
            const delivered: string[] = [];
            for (const member of members) {
              if (member === name) continue;
              const message: AgentMailMessage = {
                id: entry.id,
                from: name,
                to: member,
                text,
                timestamp: entry.timestamp,
                replyTo: entry.replyTo,
                channel: frame.channel,
                kind: "post",
                mentions: entry.mentions,
                ...(isMentioned(entry.mentions, member) ? {} : { gentle: true }),
              };
              server.publish(inboxTopic(frame.channel, member), JSON.stringify({ t: "message", channel: frame.channel, message } satisfies ServerFrame));
              delivered.push(member);
            }
            sendReply(ws, frame.id, { ok: true, entry, delivered });
            return;
          }
          case "history": {
            if (!isValidChannelName(frame.channel)) {
              sendReply(ws, frame.id, { ok: false, error: "invalid_channel" });
              return;
            }
            const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Number.isInteger(frame.limit) ? frame.limit! : 100));
            const before = Number.isInteger(frame.before) ? frame.before : undefined;
            const page = state.history(frame.channel, before, limit);
            sendReply(ws, frame.id, { ok: true, channel: frame.channel, entries: page.entries, hasMore: page.hasMore });
            return;
          }
          case "watch": {
            if (!Array.isArray(frame.channels)) {
              ws.close(MESH_CLOSE.BAD_FRAME);
              return;
            }
            const requested = [...new Set(frame.channels)];
            const invalid = requested.find((channel) => !isValidChannelName(channel));
            if (invalid !== undefined) {
              sendReply(ws, frame.id, { ok: false, error: "invalid_channel", channel: invalid });
              return;
            }
            const next = new Set(requested);
            for (const channel of ws.data.watching) {
              if (next.has(channel)) continue;
              ws.unsubscribe(logTopic(channel));
              if (!ws.data.channels.has(channel)) {
                ws.unsubscribe(peersTopic(channel));
                ws.unsubscribe(claimsTopic(channel));
              }
            }
            for (const channel of next) {
              if (ws.data.watching.has(channel)) continue;
              ws.subscribe(logTopic(channel));
              ws.subscribe(peersTopic(channel));
              ws.subscribe(claimsTopic(channel));
            }
            ws.data.watching = next;
            // Watching must not create channels (a stale watch list would resurrect a deleted one).
            const peek = (channel: string): ChannelSnapshot => state.channels.has(channel)
              ? snapshot(channel)
              : { channel, peers: [], claims: {}, completions: {} };
            sendReply(ws, frame.id, { ok: true, watching: requested.map(peek) });
            return;
          }
          case "delete_channel": {
            const channel = frame.channel;
            if (!isValidChannelName(channel)) {
              sendReply(ws, frame.id, { ok: false, error: "invalid_channel" });
              return;
            }
            if (channel === "main") {
              sendReply(ws, frame.id, { ok: false, error: "protected" });
              return;
            }
            const current = state.channels.get(channel);
            const members = [...(current?.presence.entries() ?? [])];
            try {
              if (members.some(([, registration]) => !inboxOwners.has(inboxTopic("main", registration.name)))) state.getOrCreate("main");
              state.deleteChannel(channel);
            } catch {
              sendReply(ws, frame.id, { ok: false, error: "storage_failed" });
              return;
            }
            clearTimeout(peerTimers.get(channel));
            clearTimeout(claimTimers.get(channel));
            peerTimers.delete(channel);
            claimTimers.delete(channel);
            const removed: string[] = [];
            for (const [member, registration] of members) {
              const sock = inboxOwners.get(inboxTopic(channel, member));
              if (!sock) continue;
              const rehomed = evict(sock, member, channel, name, registration);
              if (member === name) continue;
              removed.push(member);
              // Same path as a peer message: interrupts the agent's session so it knows why.
              const notice: AgentMailMessage = {
                id: randomUUID(),
                from: name,
                to: member,
                text: `#${channel} was deleted by ${name}. You're no longer in it${rehomed ? " — you've been moved to #main so you stay reachable" : ""}.`,
                timestamp: new Date().toISOString(),
                replyTo: null,
                channel: rehomed ? "main" : channel,
              };
              sendFrame(sock, { t: "message", channel: notice.channel ?? channel, message: notice });
            }
            for (const socket of sockets) {
              socket.data.watching.delete(channel);
              socket.unsubscribe(peersTopic(channel));
              socket.unsubscribe(claimsTopic(channel));
              socket.unsubscribe(logTopic(channel));
            }
            server.publish(CHANNELS_TOPIC, JSON.stringify({ t: "channel_deleted", channel, by: name } satisfies ServerFrame));
            broadcastChannels();
            sendReply(ws, frame.id, { ok: true, deleted: channel, removed });
            return;
          }
          case "rename": {
            if (!isValidAgentName(frame.name)) {
              sendReply(ws, frame.id, { success: false, error: "invalid_name" });
              return;
            }
            if (frame.name === name) {
              sendReply(ws, frame.id, { success: false, error: "same_name" });
              return;
            }
            for (const channel of ws.data.channels) {
              const owner = inboxOwners.get(inboxTopic(channel, frame.name));
              if (owner !== undefined && owner !== ws && owner.readyState === WebSocket.OPEN) {
                sendReply(ws, frame.id, { success: false, error: "name_taken" });
                return;
              }
            }
            for (const channel of ws.data.channels) {
              ws.unsubscribe(inboxTopic(channel, name));
              ws.subscribe(inboxTopic(channel, frame.name));
              inboxOwners.delete(inboxTopic(channel, name));
              inboxOwners.set(inboxTopic(channel, frame.name), ws);
              state.renameAgent(channel, name, frame.name);
            }
            ws.data.name = frame.name;
            sendReply(ws, frame.id, { success: true, oldName: name, newName: frame.name });
            for (const channel of ws.data.channels) {
              broadcastPeers(channel);
              broadcastClaims(channel);
            }
            return;
          }
          case "claim": {
            if (!ws.data.channels.has(frame.channel)) {
              ws.close(MESH_CLOSE.BAD_FRAME);
              return;
            }
            const result = state.claim(frame.channel, name, frame.spec, frame.taskId, frame.reason);
            sendReply(ws, frame.id, result);
            broadcastClaims(frame.channel);
            return;
          }
          case "unclaim": {
            if (!ws.data.channels.has(frame.channel)) {
              ws.close(MESH_CLOSE.BAD_FRAME);
              return;
            }
            const result = state.unclaim(frame.channel, name, frame.spec, frame.taskId);
            sendReply(ws, frame.id, result);
            broadcastClaims(frame.channel);
            return;
          }
          case "complete": {
            if (!ws.data.channels.has(frame.channel)) {
              ws.close(MESH_CLOSE.BAD_FRAME);
              return;
            }
            const result = state.complete(frame.channel, name, frame.spec, frame.taskId, frame.notes);
            sendReply(ws, frame.id, result);
            broadcastClaims(frame.channel);
            if (result.success) {
              const completions = state.getOrCreate(frame.channel).completions;
              server.publish(claimsTopic(frame.channel), JSON.stringify({ t: "completions", channel: frame.channel, completions } satisfies ServerFrame));
            }
            return;
          }
          case "ping":
            sendFrame(ws, { t: "pong" });
            return;
          case "bye":
            ws.close(1000);
            return;
          case "hello":
            ws.close(MESH_CLOSE.BAD_FRAME);
            return;
        }
      },
      close(ws) {
        sockets.delete(ws);
        clearTimeout(ws.data.helloTimer);
        const { name, channels } = ws.data;
        if (name === null) return;
        for (const channel of channels) {
          // Guarded by identity: a reclaimed name's new owner must survive the zombie's close.
          releaseInbox(channel, name, ws);
          if (!inboxOwners.has(inboxTopic(channel, name))) {
            state.dropAgent(channel, name);
          }
          broadcastPeers(channel);
          broadcastClaims(channel);
        }
      },
    },
  });

  return {
    port: server.port,
    hostname,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of peerTimers.values()) clearTimeout(timer);
      for (const timer of claimTimers.values()) clearTimeout(timer);
      clearTimeout(channelsTimer ?? undefined);
      peerTimers.clear();
      claimTimers.clear();
      await server.stop(true);
      persist?.close();
    },
  };
}

if (import.meta.main) {
  const option = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const port = Number(option("--port") ?? process.env.OMP_MESSENGER_MESH_PORT ?? "8765");
  const hostname = option("--host") ?? "0.0.0.0";
  const token = option("--token") ?? process.env.OMP_MESSENGER_MESH_TOKEN;
  const dataDir = option("--data-dir") ?? process.env.OMP_MESSENGER_MESH_DATA_DIR;
  if (!token) {
    console.error("omp-messenger-mesh: --token or OMP_MESSENGER_MESH_TOKEN is required");
    process.exit(1);
  }
  const running = startMeshServer({ port, hostname, token, ...(dataDir ? { dataDir } : {}) });
  console.log(`omp-messenger-mesh listening on ws://${running.hostname}:${running.port}`);
  const terminate = async (): Promise<void> => {
    await running.stop();
    process.exit(0);
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
}
