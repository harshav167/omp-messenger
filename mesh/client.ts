// allow: SIZE_OK — the WebSocket lifecycle is one transport state machine shared by every Mesh operation.
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  type AgentRegistration,
  type AllClaims,
  type AllCompletions,
  type MessengerState,
  LOCAL_HOST_ID,
  generateMemorableName,
  isValidAgentName,
  normalizeAgentMailMessage,
  normalizeChannels,
} from "../lib.ts";
import { buildRegistration, getGitBranch, normalizeCwd } from "./registration.ts";
import {
  MESH_SUBPROTOCOL,
  parseFrame,
  type ChannelSnapshot,
  type JoinReply,
  type PartReply,
  type ClaimAssertion,
  type ClientFrame,
  type ReplyResult,
  type ServerFrame,
} from "./protocol.ts";
import type {
  ChannelInfo,
  ClaimResult,
  CompleteResult,
  DeliverFn,
  Mesh,
  MeshPeer,
  MeshStatus,
  RenameResult,
  SendOptions,
  SendResult,
  UnclaimResult,
} from "./types.ts";

interface MeshClientOptions {
  readonly url: string;
  readonly token: string;
  readonly state: MessengerState;
  readonly deliver: DeliverFn;
  readonly onStatusChange?: () => void;
  readonly reconnectBaseMs?: number;
}

interface PendingReply {
  readonly resolve: (result: ReplyResult) => void;
  readonly disconnect: () => void;
  readonly timer: Timer;
}

interface ChannelReplica {
  peers: AgentRegistration[];
  claims: AllClaims;
  completions: AllCompletions;
}
function isJoinReply(result: ReplyResult): result is JoinReply {
  if (Array.isArray(result) || !("ok" in result)) return false;
  if (result.ok === true) return "channels" in result;
  return "channel" in result;
}

function isPartReply(result: ReplyResult): result is PartReply {
  return !Array.isArray(result) && "ok" in result && result.ok === true
    && "channels" in result && result.channels.every(c => typeof c === "string");
}

function isSendResult(result: ReplyResult): result is SendResult {
  if (Array.isArray(result) || !("ok" in result)) return false;
  if (result.ok === true) return "message" in result;
  return "error" in result && !("channel" in result);
}


type RequestFrame = Extract<ClientFrame, { id: string }>;
type WelcomeFrame = Extract<ServerFrame, { t: "welcome" }>;
type RejectFrame = Extract<ServerFrame, { t: "reject" }>;
type HandshakeOutcome =
  | { kind: "welcome" }
  | { kind: "reject"; error: RejectFrame["error"]; channel?: string }
  | { kind: "failure"; reason: string };

const REQUEST_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const STALE_CONNECTION_MS = 45_000;
const STALE_PEERS_MS = 30_000;

export function createMeshClient(opts: MeshClientOptions): Mesh {
  const { state, deliver } = opts;
  const reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
  const replica = new Map<string, ChannelReplica>();
  const pendingReplies = new Map<string, PendingReply>();
  const myClaims = new Map<string, ClaimAssertion>();

  let ws: WebSocket | null = null;
  let meshStatus: MeshStatus = "disconnected";
  let wantConnected = false;
  let backoffMs = reconnectBaseMs;
  let staleTimer: Timer | undefined;
  let heartbeatTimer: Timer | undefined;
  let reconnectTimer: Timer | undefined;
  let lastFrameAt = 0;
  let lastCtx: ExtensionContext | null = null;

  function notify(ctx: ExtensionContext, message: string): void {
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  }

  function clearHeartbeat(): void {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function channelReplica(channel: string): ChannelReplica {
    let entry = replica.get(channel);
    if (!entry) {
      entry = { peers: [], claims: {}, completions: {} };
      replica.set(channel, entry);
    }
    return entry;
  }

  function applySnapshots(snapshots: ChannelSnapshot[]): void {
    for (const snapshot of snapshots) {
      replica.set(snapshot.channel, {
        peers: snapshot.peers,
        claims: snapshot.claims,
        completions: snapshot.completions,
      });
    }
  }

  function sendFrame(socket: WebSocket, frame: ClientFrame): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }

  function settlePendingReplies(): void {
    for (const pending of pendingReplies.values()) {
      clearTimeout(pending.timer);
      pending.disconnect();
    }
    pendingReplies.clear();
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      const socket = ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastFrameAt > STALE_CONNECTION_MS) {
        socket.close();
        return;
      }
      sendFrame(socket, { t: "ping" });
    }, HEARTBEAT_MS);
  }

  function acceptWelcome(frame: WelcomeFrame, ctx: ExtensionContext, initial: boolean): void {
    const now = new Date().toISOString();
    state.agentName = frame.name;
    state.channels = frame.channels.map(snapshot => snapshot.channel).sort();
    state.registered = true;
    if (initial) {
      state.cwd = normalizeCwd(ctx.cwd);
      state.gitBranch = getGitBranch(state.cwd);
      state.model = ctx.model?.id ?? "unknown";
      state.activity.lastActivityAt = now;
      state.sessionStartedAt = now;
    }
    replica.clear();
    applySnapshots(frame.channels);
    clearTimeout(staleTimer);
    staleTimer = undefined;
    backoffMs = reconnectBaseMs;
    lastFrameAt = Date.now();
    wantConnected = true;
    meshStatus = "connected";
    startHeartbeat();
    opts.onStatusChange?.();
  }

  function handleServerFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case "welcome":
        replica.clear();
        applySnapshots(frame.channels);
        opts.onStatusChange?.();
        return;
      case "peers":
        channelReplica(frame.channel).peers = frame.peers;
        opts.onStatusChange?.();
        return;
      case "claims":
        channelReplica(frame.channel).claims = frame.claims;
        opts.onStatusChange?.();
        return;
      case "completions":
        channelReplica(frame.channel).completions = frame.completions;
        opts.onStatusChange?.();
        return;
      case "message": {
        const message = normalizeAgentMailMessage(frame.message, {
          id: randomUUID(),
          from: "unknown",
          to: state.agentName,
          timestamp: new Date().toISOString(),
        });
        message.channel ??= frame.channel;
        deliver(message);
        return;
      }
      case "reply": {
        const pending = pendingReplies.get(frame.id);
        if (!pending) return;
        pendingReplies.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame.result);
        return;
      }
      case "pong":
      case "reject":
        return;
      default: {
        const exhaustive: never = frame;
        return exhaustive;
      }
    }
  }

  function scheduleReconnect(): void {
    if (!wantConnected || reconnectTimer) return;
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(backoffMs * jitter);
    backoffMs = Math.min(backoffMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnect();
    }, delay);
  }

  function handleSocketClose(socket: WebSocket): void {
    if (ws !== socket) return;
    ws = null;
    clearHeartbeat();
    settlePendingReplies();
    if (!wantConnected) {
      meshStatus = "disconnected";
      opts.onStatusChange?.();
      return;
    }
    meshStatus = "reconnecting";
    opts.onStatusChange?.();
    if (!staleTimer) {
      staleTimer = setTimeout(() => {
        staleTimer = null;
        for (const entry of replica.values()) entry.peers = [];
        opts.onStatusChange?.();
      }, STALE_PEERS_MS);
    }
    scheduleReconnect();
  }

  function performHandshake(
    ctx: ExtensionContext,
    candidates: readonly string[],
    initial: boolean,
  ): Promise<HandshakeOutcome> {
    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.url, [MESH_SUBPROTOCOL]);
    } catch (error) {
      if (error instanceof Error) return Promise.resolve({ kind: "failure", reason: error.message });
      throw error;
    }
    ws = socket;

    const { promise, resolve } = Promise.withResolvers<HandshakeOutcome>();
    let candidateIndex = 0;
    let accepted = false;
    let settled = false;
    const timer = setTimeout(() => {
      finish({ kind: "failure", reason: "welcome timeout" });
      socket.close();
    }, REQUEST_TIMEOUT_MS);

    function finish(outcome: HandshakeOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.kind !== "welcome" && ws === socket) ws = null;
      resolve(outcome);
    }

    function sendHello(): void {
      const name = candidates[candidateIndex];
      if (!name || !sendFrame(socket, {
        t: "hello",
        token: opts.token,
        channels: state.channels,
        agent: buildRegistration(state, ctx, name),
        claims: [...myClaims.values()],
      })) {
        finish({ kind: "failure", reason: "connection closed" });
      }
    }

    socket.addEventListener("open", sendHello);
    socket.addEventListener("message", (event) => {
      const frame = parseFrame<ServerFrame>(event.data);
      if (!frame) return;
      lastFrameAt = Date.now();
      if (!settled && frame.t === "reject") {
        if (initial && frame.error === "name_taken" && candidateIndex + 1 < candidates.length) {
          candidateIndex++;
          sendHello();
          return;
        }
        finish({ kind: "reject", error: frame.error, ...(frame.channel ? { channel: frame.channel } : {}) });
        socket.close();
        return;
      }
      if (!settled && frame.t === "welcome") {
        accepted = true;
        acceptWelcome(frame, ctx, initial);
        finish({ kind: "welcome" });
        return;
      }
      if (settled && accepted) handleServerFrame(frame);
    });
    socket.addEventListener("error", (event) => {
      const detail = (event as { message?: unknown; error?: { message?: unknown } });
      const message = typeof detail.message === "string" ? detail.message
        : typeof detail.error?.message === "string" ? detail.error.message
        : "connection error";
      if (!settled) finish({ kind: "failure", reason: message });
    });
    socket.addEventListener("close", (event) => {
      if (!settled) {
        finish({
          kind: "failure",
          reason: event.reason || `connection closed (${event.code})`,
        });
        return;
      }
      if (accepted) handleSocketClose(socket);
    });
    return promise;
  }

  function leaveAfterReject(ctx: ExtensionContext, error: RejectFrame["error"], channel?: string): void {
    state.registered = false;
    wantConnected = false;
    meshStatus = "disconnected";
    replica.clear();
    switch (error) {
      case "name_taken":
        notify(ctx, `Mesh: agent name ${state.agentName} was taken${channel ? ` in #${channel}` : ""} while reconnecting; left the mesh`);
        break;
      case "invalid_name":
        notify(ctx, "Mesh rejected agent name");
        break;
      case "invalid_channel":
        notify(ctx, `Invalid mesh channel: ${channel ?? "unknown"}`);
        break;
      case "bad_token":
        notify(ctx, "Mesh rejected the token");
        break;
      default: {
        const exhaustive: never = error;
        return exhaustive;
      }
    }
    opts.onStatusChange?.();
  }

  async function reconnect(): Promise<void> {
    if (!wantConnected || ws || !lastCtx) return;
    const outcome = await performHandshake(lastCtx, [state.agentName], false);
    switch (outcome.kind) {
      case "welcome":
        return;
      case "reject":
        leaveAfterReject(lastCtx, outcome.error, outcome.channel);
        return;
      case "failure":
        if (wantConnected) {
          meshStatus = "reconnecting";
          opts.onStatusChange?.();
          scheduleReconnect();
        }
        return;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  function request<T>(
    frame: RequestFrame,
    decode: (result: ReplyResult) => T,
    disconnected: () => T,
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const finishDisconnected = (): void => {
      try {
        resolve(disconnected());
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      pendingReplies.delete(frame.id);
      finishDisconnected();
    }, REQUEST_TIMEOUT_MS);
    pendingReplies.set(frame.id, {
      timer,
      disconnect: finishDisconnected,
      resolve: (result) => {
        try {
          resolve(decode(result));
        } catch (error) {
          reject(error);
        }
      },
    });
    const socket = ws;
    if (!socket || !sendFrame(socket, frame)) {
      pendingReplies.delete(frame.id);
      clearTimeout(timer);
      finishDisconnected();
    }
    return promise;
  }

  /** Channel for a claim operation; must be one we joined. */
  function joinedChannel(channel: string | undefined): string {
    const name = channel ?? state.channels[0];
    if (name === undefined || !state.channels.includes(name)) {
      throw new Error(`not joined: ${name}`);
    }
    return name;
  }

  const mesh: Mesh = {
    kind: "mesh",
    status: () => meshStatus,
    channels: () => (state.registered ? [...state.channels] : []),

    async join(ctx, joinOptions): Promise<boolean> {
      let channels: string[];
      try {
        channels = normalizeChannels(joinOptions?.channels ?? state.channels);
      } catch (err) {
        notify(ctx, err instanceof Error ? err.message : "Invalid channel name");
        return false;
      }
      if (state.registered) {
        const added = channels.filter(c => !state.channels.includes(c));
        const removed = state.channels.filter(c => !channels.includes(c));
        if (added.length > 0 && !(await mesh.joinChannels(ctx, added))) return false;
        if (removed.length > 0) await mesh.leaveChannels(removed);
        return true;
      }
      state.channels = channels;
      lastCtx = ctx;
      if (!/^wss?:\/\//.test(opts.url)) {
        notify(ctx, `Invalid mesh url: ${opts.url}`);
        return false;
      }
      if (!opts.token) {
        notify(ctx, "Mesh token missing (mesh.token / OMP_MESSENGER_MESH_TOKEN)");
        return false;
      }
      if (state.explicitName && !isValidAgentName(state.agentName)) {
        notify(ctx, `Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`);
        return false;
      }

      const base = state.agentName || generateMemorableName(joinOptions?.nameTheme);
      const candidates = state.explicitName
        ? [state.agentName]
        : [base, ...Array.from({ length: 98 }, (_, index) => `${base}${index + 2}`)];
      const outcome = await performHandshake(ctx, candidates, true);
      switch (outcome.kind) {
        case "welcome":
          return true;
        case "failure":
          notify(ctx, `Cannot reach mesh at ${opts.url}: ${outcome.reason}`);
          return false;
        case "reject":
          switch (outcome.error) {
            case "name_taken":
              notify(ctx, state.explicitName
                ? `Mesh rejected agent name: name is already taken${outcome.channel ? ` in #${outcome.channel}` : ""}`
                : "Could not find available agent name after 99 attempts");
              return false;
            case "invalid_name":
              notify(ctx, "Mesh rejected agent name");
              return false;
            case "invalid_channel":
              notify(ctx, `Invalid mesh channel: ${outcome.channel ?? "unknown"}`);
              return false;
            case "bad_token":
              notify(ctx, "Mesh rejected the token");
              return false;
            default: {
              const exhaustive: never = outcome.error;
              return exhaustive;
            }
          }
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    },

    async joinChannels(ctx, chs): Promise<boolean> {
      let next: string[];
      try {
        next = normalizeChannels([...state.channels, ...chs]);
      } catch (err) {
        notify(ctx, err instanceof Error ? err.message : "Invalid channel name");
        return false;
      }
      const added = next.filter(c => !state.channels.includes(c));
      if (added.length === 0) {
        state.channels = next;
        return true;
      }
      if (!state.registered) {
        state.channels = next;
        return true;
      }
      if (meshStatus !== "connected") {
        notify(ctx, "Mesh unreachable");
        return false;
      }
      const id = randomUUID();
      const reply = await request<JoinReply | null>(
        { t: "join", id, channels: added },
        (result) => (isJoinReply(result) ? result : null),
        () => null,
      );
      if (!reply) {
        notify(ctx, "Mesh unreachable");
        return false;
      }
      if (reply.ok === false) {
        notify(ctx, reply.error === "name_taken"
          ? `Agent name "${state.agentName}" already in use in #${reply.channel}`
          : `Mesh rejected channel ${reply.channel}: ${reply.error}`);
        return false;
      }
      applySnapshots(reply.channels);
      state.channels = next;
      return true;
    },

    async leaveChannels(chs): Promise<void> {
      const leaving = chs.filter(c => state.channels.includes(c));
      if (leaving.length === 0) return;
      const id = randomUUID();
      const reply = await request<PartReply | null>(
        { t: "part", id, channels: leaving },
        (result) => (isPartReply(result) ? result : null),
        () => null,
      );
      const remaining = reply ? reply.channels : state.channels.filter(c => !leaving.includes(c));
      for (const channel of leaving) replica.delete(channel);
      for (const key of myClaims.keys()) {
        if (leaving.includes(key.split("\u0000")[0] ?? "")) myClaims.delete(key);
      }
      state.channels = [...remaining].sort();
      if (state.channels.length === 0) {
        state.registered = false;
        wantConnected = false;
        replica.clear();
        // The server closes the socket after the part reply; handleSocketClose
        // sees wantConnected=false and settles as "disconnected".
      }
    },

    async listChannels(): Promise<ChannelInfo[]> {
      if (meshStatus !== "connected") return [];
      const id = randomUUID();
      return request({ t: "channels", id },
        (result) => Array.isArray(result) ? result : [],
        () => []);
    },

    publish(ctx): void {
      lastCtx = ctx;
      const socket = ws;
      if (meshStatus === "connected" && socket) {
        sendFrame(socket, { t: "publish", agent: buildRegistration(state, ctx, state.agentName) });
      }
    },

    async leave(): Promise<void> {
      wantConnected = false;
      clearTimeout(reconnectTimer);
      clearTimeout(staleTimer);
      reconnectTimer = undefined;
      staleTimer = undefined;
      clearHeartbeat();
      const socket = ws;
      ws = null;
      if (socket) {
        if (socket.readyState === WebSocket.OPEN) sendFrame(socket, { t: "bye" });
        socket.close(1000);
      }
      settlePendingReplies();
      state.registered = false;
      replica.clear();
      meshStatus = "disconnected";
      opts.onStatusChange?.();
    },

    async rename(_ctx, newName): Promise<RenameResult> {
      if (!state.registered) return { success: false, error: "not_registered" };
      if (!isValidAgentName(newName)) return { success: false, error: "invalid_name" };
      if (newName === state.agentName) return { success: false, error: "same_name" };
      if (meshStatus !== "connected") return { success: false, error: "race_lost" };
      const id = randomUUID();
      const result = await request<RenameResult>({ t: "rename", id, name: newName },
        (reply) => {
          if (!Array.isArray(reply) && "success" in reply) {
            if (reply.success && "newName" in reply) return reply;
            if (!reply.success && "error" in reply && (
              reply.error === "not_registered" || reply.error === "invalid_name" ||
              reply.error === "name_taken" || reply.error === "same_name" || reply.error === "race_lost"
            )) return reply;
          }
          throw new Error("mesh unreachable");
        },
        () => { throw new Error("mesh unreachable"); });
      if (result.success) {
        state.agentName = newName;
        state.sessionStartedAt = new Date().toISOString();
      }
      return result;
    },

    peers(): MeshPeer[] {
      const byName = new Map<string, MeshPeer>();
      for (const channel of state.channels) {
        const entry = replica.get(channel);
        if (!entry) continue;
        for (const peer of entry.peers) {
          if (peer.name === state.agentName) continue;
          if (state.scopeToFolder && !(peer.hostId === LOCAL_HOST_ID && peer.cwd === normalizeCwd(state.cwd))) continue;
          const existing = byName.get(peer.name);
          if (existing) {
            existing.channels.push(channel);
            Object.assign(existing, peer);
          } else {
            byName.set(peer.name, { ...peer, channels: [channel] });
          }
        }
      }
      return [...byName.values()];
    },
    evict: () => {},

    async send(to, text, sendOptions?: SendOptions): Promise<SendResult> {
      if (!isValidAgentName(to)) return { ok: false, error: "invalid_name" };
      if (meshStatus !== "connected") return { ok: false, error: "unreachable" };

      let channel: string;
      if (sendOptions?.channel !== undefined) {
        if (!state.channels.includes(sendOptions.channel)) return { ok: false, error: "not_found" };
        channel = sendOptions.channel;
      } else {
        const candidates = state.channels.filter(c =>
          (replica.get(c)?.peers ?? []).some(peer => peer.name === to));
        if (candidates.length === 0) return { ok: false, error: "not_found" };
        if (candidates.length > 1) return { ok: false, error: "ambiguous_channel" };
        channel = candidates[0];
      }

      const id = randomUUID();
      const message = {
        id: randomUUID(),
        from: sendOptions?.from ?? state.agentName,
        to,
        text,
        timestamp: new Date().toISOString(),
        replyTo: sendOptions?.replyTo ?? null,
        channel,
        ...(sendOptions?.gentle ? { gentle: true } : {}),
      };
      return request<SendResult>({ t: "send", id, channel, to, message },
        (reply) => isSendResult(reply)
          ? reply
          : { ok: false, error: "unreachable" },
        () => ({ ok: false, error: "unreachable" }));
    },

    recoverInbox(): void {
      if (!wantConnected || ws) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      backoffMs = reconnectBaseMs;
      void reconnect();
    },
    drainInbox: () => {},

    claims(): AllClaims {
      const merged: AllClaims = {};
      for (const channel of [...state.channels].sort()) {
        const claims = replica.get(channel)?.claims;
        if (!claims) continue;
        for (const [spec, tasks] of Object.entries(claims)) {
          merged[spec] = { ...merged[spec], ...tasks };
        }
      }
      return merged;
    },

    completions(): AllCompletions {
      const merged: AllCompletions = {};
      for (const channel of [...state.channels].sort()) {
        const completions = replica.get(channel)?.completions;
        if (!completions) continue;
        for (const [spec, tasks] of Object.entries(completions)) {
          merged[spec] = { ...merged[spec], ...tasks };
        }
      }
      return merged;
    },

    async claim(_ctx, spec, taskId, reason, channel): Promise<ClaimResult> {
      const target = joinedChannel(channel);
      if (meshStatus !== "connected") throw new Error("mesh unreachable");
      const id = randomUUID();
      const result = await request<ClaimResult>(
        { t: "claim", id, channel: target, spec, taskId, ...(reason ? { reason } : {}) },
        (reply) => {
          if (!Array.isArray(reply) && "success" in reply) {
            if (reply.success && "claimedAt" in reply) return reply;
            if (!reply.success && "error" in reply && (
              reply.error === "already_claimed" || reply.error === "already_have_claim"
            )) return reply;
          }
          throw new Error("mesh unreachable");
        },
        () => { throw new Error("mesh unreachable"); },
      );
      if (result.success) {
        myClaims.set(`${target}\u0000${spec}\u0000${taskId}`, {
          channel: target,
          spec,
          taskId,
          claimedAt: result.claimedAt,
          ...(reason ? { reason } : {}),
        });
      }
      return result;
    },

    async unclaim(spec, taskId, channel): Promise<UnclaimResult> {
      const target = joinedChannel(channel);
      if (meshStatus !== "connected") throw new Error("mesh unreachable");
      const id = randomUUID();
      const result = await request<UnclaimResult>({ t: "unclaim", id, channel: target, spec, taskId },
        (reply) => {
          if (!Array.isArray(reply) && "success" in reply) {
            if (reply.success) return { success: true };
            if ("error" in reply && reply.error === "not_claimed") {
              return { success: false, error: "not_claimed" };
            }
            if ("error" in reply && reply.error === "not_your_claim" && "claimedBy" in reply) {
              return { success: false, error: "not_your_claim", claimedBy: reply.claimedBy };
            }
          }
          throw new Error("mesh unreachable");
        },
        () => { throw new Error("mesh unreachable"); });
      if (result.success) myClaims.delete(`${target}\u0000${spec}\u0000${taskId}`);
      return result;
    },

    async complete(spec, taskId, notes, channel): Promise<CompleteResult> {
      const target = joinedChannel(channel);
      if (meshStatus !== "connected") throw new Error("mesh unreachable");
      const id = randomUUID();
      const result = await request<CompleteResult>(
        { t: "complete", id, channel: target, spec, taskId, ...(notes ? { notes } : {}) },
        (reply) => {
          if (!Array.isArray(reply) && "success" in reply) {
            if (reply.success && "completedAt" in reply) return reply;
            if (!reply.success && "error" in reply) {
              if (reply.error === "not_claimed") return { success: false, error: "not_claimed" };
              if (reply.error === "not_your_claim" && "claimedBy" in reply) {
                return { success: false, error: "not_your_claim", claimedBy: reply.claimedBy };
              }
              if (reply.error === "already_completed" && "completion" in reply) return reply;
            }
          }
          throw new Error("mesh unreachable");
        },
        () => { throw new Error("mesh unreachable"); },
      );
      if (result.success) myClaims.delete(`${target}\u0000${spec}\u0000${taskId}`);
      return result;
    },

    close(): void {
      wantConnected = false;
      clearTimeout(reconnectTimer);
      clearTimeout(staleTimer);
      reconnectTimer = undefined;
      staleTimer = undefined;
      clearHeartbeat();
      settlePendingReplies();
      const socket = ws;
      ws = null;
      if (socket) socket.close(1000);
      meshStatus = "disconnected";
    },
  };

  return mesh;
}
