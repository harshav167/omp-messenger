// allow: SIZE_OK — Bun's WebSocket lifecycle is one protocol state machine over shared socket and topic state.
import { createHash, timingSafeEqual } from "node:crypto";
import { isValidAgentName, isValidChannelName } from "../lib.ts";
import type { AllClaims } from "../lib.ts";
import { MESH_CLOSE, MESH_SUBPROTOCOL, parseFrame } from "./protocol.ts";
import type { ClientFrame, ReplyResult, ServerFrame } from "./protocol.ts";
import { openPersist } from "./persist.ts";
import type { Persist } from "./persist.ts";
import { createServerState } from "./server-state.ts";
import type { ServerState } from "./server-state.ts";

interface SocketData {
  name: string | null;
  channel: string | null;
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
      server.publish(peersTopic(channel), JSON.stringify({ t: "peers", peers } satisfies ServerFrame));
    }, 50));
  };

  const broadcastClaims = (channel: string): void => {
    if (stopped || claimTimers.has(channel)) return;
    claimTimers.set(channel, setTimeout(() => {
      claimTimers.delete(channel);
      const claims: AllClaims = state.channels.get(channel)?.claims ?? {};
      server.publish(claimsTopic(channel), JSON.stringify({ t: "claims", claims } satisfies ServerFrame));
    }, 50));
  };

  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname,
    routes: { "/healthz": new Response("ok") },
    fetch(request, bunServer) {
      const offered = request.headers.get("sec-websocket-protocol");
      const acceptsProtocol = offered?.split(",").some((protocol) => protocol.trim() === MESH_SUBPROTOCOL) ?? false;
      if (!acceptsProtocol) {
        return new Response("pi-messenger-mesh: subprotocol pi-messenger.v1 required", { status: 426 });
      }
      const upgraded = bunServer.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": MESH_SUBPROTOCOL },
        data: { name: null, channel: null, helloTimer: null },
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

        if (ws.data.name === null || ws.data.channel === null) {
          if (frame.t !== "hello") {
            ws.close(MESH_CLOSE.BAD_FRAME);
            return;
          }
          if (!timingSafeEqual(expectedToken, tokenDigest(frame.token))) {
            sendFrame(ws, { t: "reject", error: "bad_token" });
            ws.close(MESH_CLOSE.BAD_TOKEN);
            return;
          }
          if (!isValidChannelName(frame.channel)) {
            sendFrame(ws, { t: "reject", error: "invalid_channel" });
            return;
          }
          const name = frame.agent.name;
          if (!isValidAgentName(name)) {
            sendFrame(ws, { t: "reject", error: "invalid_name" });
            return;
          }
          if (server.subscriberCount(inboxTopic(frame.channel, name)) > 0) {
            sendFrame(ws, { t: "reject", error: "name_taken" });
            return;
          }

          clearTimeout(ws.data.helloTimer);
          ws.data.helloTimer = null;
          ws.data.name = name;
          ws.data.channel = frame.channel;
          ws.subscribe(peersTopic(frame.channel));
          ws.subscribe(claimsTopic(frame.channel));
          ws.subscribe(inboxTopic(frame.channel, name));
          const channel = state.getOrCreate(frame.channel);
          channel.presence.set(name, frame.agent);
          let claimApplied = false;
          for (const assertion of frame.claims) {
            const result = state.claim(frame.channel, name, assertion.spec, assertion.taskId, assertion.reason);
            if (result.success) claimApplied = true;
          }
          sendFrame(ws, {
            t: "welcome",
            name,
            channel: frame.channel,
            peers: [...channel.presence.values()],
            claims: channel.claims,
            completions: channel.completions,
          });
          broadcastPeers(frame.channel);
          if (claimApplied) broadcastClaims(frame.channel);
          return;
        }

        const name = ws.data.name;
        const channelName = ws.data.channel;
        switch (frame.t) {
          case "publish": {
            const channel = state.getOrCreate(channelName);
            channel.presence.set(name, { ...frame.agent, name });
            broadcastPeers(channelName);
            return;
          }
          case "channels":
            sendReply(ws, frame.id, state.listChannels());
            return;
          case "send": {
            if (!isValidAgentName(frame.to)) {
              sendReply(ws, frame.id, { ok: false, error: "invalid_name" });
              return;
            }
            const topic = inboxTopic(channelName, frame.to);
            if (server.subscriberCount(topic) === 0) {
              sendReply(ws, frame.id, { ok: false, error: "not_found" });
              return;
            }
            server.publish(topic, JSON.stringify({ t: "message", message: frame.message } satisfies ServerFrame));
            sendReply(ws, frame.id, { ok: true, message: frame.message });
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
            if (server.subscriberCount(inboxTopic(channelName, frame.name)) > 0) {
              sendReply(ws, frame.id, { success: false, error: "name_taken" });
              return;
            }
            ws.unsubscribe(inboxTopic(channelName, name));
            ws.subscribe(inboxTopic(channelName, frame.name));
            state.renameAgent(channelName, name, frame.name);
            ws.data.name = frame.name;
            sendReply(ws, frame.id, { success: true, oldName: name, newName: frame.name });
            broadcastPeers(channelName);
            broadcastClaims(channelName);
            return;
          }
          case "claim": {
            const result = state.claim(channelName, name, frame.spec, frame.taskId, frame.reason);
            sendReply(ws, frame.id, result);
            broadcastClaims(channelName);
            return;
          }
          case "unclaim": {
            const result = state.unclaim(channelName, name, frame.spec, frame.taskId);
            sendReply(ws, frame.id, result);
            broadcastClaims(channelName);
            return;
          }
          case "complete": {
            const result = state.complete(channelName, name, frame.spec, frame.taskId, frame.notes);
            sendReply(ws, frame.id, result);
            broadcastClaims(channelName);
            if (result.success) {
              const completions = state.getOrCreate(channelName).completions;
              server.publish(claimsTopic(channelName), JSON.stringify({ t: "completions", completions } satisfies ServerFrame));
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
        const { name, channel } = ws.data;
        if (name === null || channel === null) return;
        state.dropAgent(channel, name);
        broadcastPeers(channel);
        broadcastClaims(channel);
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
    console.error("pi-messenger-mesh: --token or OMP_MESSENGER_MESH_TOKEN is required");
    process.exit(1);
  }
  const running = startMeshServer({ port, hostname, token, ...(dataDir ? { dataDir } : {}) });
  console.log(`pi-messenger-mesh listening on ws://${running.hostname}:${running.port}`);
  const terminate = async (): Promise<void> => {
    await running.stop();
    process.exit(0);
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
}
