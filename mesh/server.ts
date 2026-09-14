// allow: SIZE_OK — Bun's WebSocket lifecycle is one protocol state machine over shared socket and topic state.
import { createHash, timingSafeEqual } from "node:crypto";
import { isValidAgentName, isValidChannelName } from "../lib.ts";
import type { AgentMailMessage, AgentRegistration, AllClaims } from "../lib.ts";
import { MESH_CLOSE, MESH_SUBPROTOCOL, parseFrame } from "./protocol.ts";
import type { ChannelSnapshot, ClientFrame, ReplyResult, ServerFrame } from "./protocol.ts";
import { openPersist } from "./persist.ts";
import type { Persist } from "./persist.ts";
import { createServerState } from "./server-state.ts";
import type { ServerState } from "./server-state.ts";

interface SocketData {
  name: string | null;
  channels: Set<string>;
  helloTimer: ReturnType<typeof setTimeout> | null;
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
  let stopped = false;

  const broadcastPeers = (channel: string): void => {
    if (stopped || peerTimers.has(channel)) return;
    peerTimers.set(channel, setTimeout(() => {
      peerTimers.delete(channel);
      const peers = [...(state.channels.get(channel)?.presence.values() ?? [])];
      server.publish(peersTopic(channel), JSON.stringify({ t: "peers", channel, peers } satisfies ServerFrame));
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
        data: { name: null, channels: new Set<string>(), helloTimer: null },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
      idleTimeout: 60,
      maxPayloadLength: 1_048_576,
      perMessageDeflate: false,
      sendPings: true,
      open(ws) {
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
          const requested = [...new Set(frame.channels)];
          const taken = requested.find((channel) => server.subscriberCount(inboxTopic(channel, name)) > 0);
          if (taken !== undefined) {
            sendFrame(ws, { t: "reject", error: "name_taken", channel: taken });
            return;
          }

          clearTimeout(ws.data.helloTimer);
          ws.data.helloTimer = null;
          ws.data.name = name;
          for (const channel of requested) {
            ws.data.channels.add(channel);
            ws.subscribe(peersTopic(channel));
            ws.subscribe(claimsTopic(channel));
            ws.subscribe(inboxTopic(channel, name));
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
            const taken = added.find((channel) => server.subscriberCount(inboxTopic(channel, name)) > 0);
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
              ws.unsubscribe(peersTopic(channel));
              ws.unsubscribe(claimsTopic(channel));
              ws.unsubscribe(inboxTopic(channel, name));
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
            const message: AgentMailMessage = { ...frame.message, channel: frame.channel };
            server.publish(topic, JSON.stringify({ t: "message", channel: frame.channel, message } satisfies ServerFrame));
            sendReply(ws, frame.id, { ok: true, message });
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
              if (server.subscriberCount(inboxTopic(channel, frame.name)) > 0) {
                sendReply(ws, frame.id, { success: false, error: "name_taken" });
                return;
              }
            }
            for (const channel of ws.data.channels) {
              ws.unsubscribe(inboxTopic(channel, name));
              ws.subscribe(inboxTopic(channel, frame.name));
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
        clearTimeout(ws.data.helloTimer);
        const { name, channels } = ws.data;
        if (name === null) return;
        for (const channel of channels) {
          state.dropAgent(channel, name);
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
