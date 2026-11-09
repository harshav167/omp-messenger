/**
 * The Tern messenger's own connection to the mesh server: a human member of every
 * channel it watches. It joins with `isHuman: true` so agents see it in their peer
 * lists and can direct-message it, posts with `post`, and follows every watched
 * channel's log (posts and the direct messages between agents) with `watch`.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AgentMailMessage, AgentRegistration, HistoryEntry } from "../../lib.ts";
import {
  HISTORY_PAGE_MAX,
  MESH_SUBPROTOCOL,
  parseFrame,
  type ChannelSnapshot,
  type ClientFrame,
  type HistoryPage,
  type JoinReply,
  type PostResult,
  type ReplyResult,
  type ServerFrame,
  type WatchReply,
} from "../../mesh/protocol.ts";
import type { DeleteChannelReply } from "../../mesh/protocol.ts";
import type { ChannelInfo, SendResult } from "../../mesh/types.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "rejected";

export interface MeshClientEvents {
  state(state: ConnectionState, detail?: string): void;
  /** Membership is (re)established; `channels` holds each joined channel's snapshot. */
  welcome(name: string, channels: ChannelSnapshot[]): void;
  peers(channel: string, peers: AgentRegistration[]): void;
  /** A message logged in a watched channel. */
  log(entry: HistoryEntry): void;
  /** A direct message to this member (an agent replying to the human). */
  direct(message: AgentMailMessage): void;
  /** The mesh's channel list changed. */
  channels(channels: ChannelInfo[]): void;
  /** This member was removed from `channel` (deleted by `by`); `channels` is the membership now. */
  removed(channel: string, by: string, channels: string[], added: ChannelSnapshot[]): void;
  deleted(channel: string, by: string): void;
}

export interface MeshClientOptions {
  url: string;
  token: string;
  name: string;
  channels: string[];
  cwd: string;
  /** This machine's secret (`messengerIdentityKey()`): lets the server tell your other windows from someone taking your name. */
  identityKey: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const STALE_CONNECTION_MS = 45_000;
const NAME_RETRY_LIMIT = 5;
type UnconfirmedFrame = Extract<ClientFrame, { t: "send" | "post" }>;

function registration(name: string, cwd: string): AgentRegistration {
  const now = new Date().toISOString();
  return {
    name,
    pid: process.pid,
    hostId: hostname(),
    sessionId: `tern-${randomUUID()}`,
    cwd,
    model: "human",
    startedAt: now,
    isHuman: true,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now, currentActivity: "in Tern" },
    statusMessage: "watching in Tern",
  };
}

export class MessengerMesh {
  #ws: WebSocket | null = null;
  #channels: string[];
  /** Channels watched beyond the joined ones (every channel the mesh lists). */
  #watched: string[] = [];
  #agent: AgentRegistration;
  #pending = new Map<string, { resolve: (result: ReplyResult | null) => void; timer: Timer }>();
  #unconfirmed = new Map<string, UnconfirmedFrame>();
  #backoff = 1000;
  #retryTimer: Timer | undefined;
  #heartbeat: Timer | undefined;
  #welcomeTimer: Timer | undefined;
  #lastFrameAt = 0;
  #closed = false;
  #nameRetries = 0;

  constructor(
    private readonly opts: MeshClientOptions,
    private readonly on: MeshClientEvents,
  ) {
    this.#channels = [...opts.channels];
    this.#agent = registration(opts.name, opts.cwd);
  }

  get name(): string {
    return this.#agent.name;
  }

  get channels(): string[] {
    return [...this.#channels];
  }
  reconfigure(url: string, token: string, channels: string[]): void {
    this.close();
    this.opts.url = url;
    this.opts.token = token;
    this.#channels = [...channels];
    this.#watched = [];
    this.#closed = false;
    this.#backoff = 1000;
    this.#nameRetries = 0;
    this.connect();
  }

  activity(): void {
    this.#agent.activity.lastActivityAt = new Date().toISOString();
    this.#send({ t: "publish", agent: this.#agent });
  }

  connect(): void {
    if (this.#closed || this.#ws) return;
    this.on.state(this.#backoff === 1000 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url, [MESH_SUBPROTOCOL]);
    } catch (error) {
      this.#scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    this.#ws = ws;
    this.#welcomeTimer = setTimeout(
      () => this.#disconnect(ws, "welcome timeout"),
      REQUEST_TIMEOUT_MS,
    );
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      this.#send({
        t: "hello",
        token: this.opts.token,
        channels: this.#channels,
        agent: this.#agent,
        claims: [],
        identityKey: this.opts.identityKey,
      });
    });
    ws.addEventListener("message", (event) => {
      if (this.#ws !== ws) return;
      const frame = parseFrame<ServerFrame>(event.data);
      if (frame) {
        this.#lastFrameAt = Date.now();
        this.#handle(frame);
      }
    });
    ws.addEventListener("close", () => {
      this.#disconnect(ws, "connection closed");
    });
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#welcomeTimer);
    clearInterval(this.#heartbeat);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.#pending.clear();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) this.#send({ t: "bye" }, ws);
      try {
        ws.close(1000);
      } catch {
        /* Already closed or unavailable. */
      }
    }
  }

  /** Post to a channel's group chat. */
  async post(channel: string, text: string): Promise<PostResult | null> {
    const route = `post\0${channel}`;
    const previous = this.#unconfirmed.get(route);
    const frame: Extract<ClientFrame, { t: "post" }> =
      previous?.t === "post" && previous.text === text
        ? previous
        : { t: "post", id: randomUUID(), channel, text, messageId: randomUUID() };
    this.#unconfirmed.set(route, frame);
    const result = await this.#request(
      frame,
      (r): r is PostResult =>
        !Array.isArray(r) &&
        "ok" in r &&
        (r.ok ? "entry" in r && "delivered" in r : "error" in r && !("channel" in r)),
    );
    if (result !== null && this.#unconfirmed.get(route) === frame) {
      this.#unconfirmed.delete(route);
    }
    return result;
  }

  async send(channel: string, to: string, text: string): Promise<SendResult | null> {
    const route = `send\0${channel}\0${to}`;
    const previous = this.#unconfirmed.get(route);
    const frame: Extract<ClientFrame, { t: "send" }> =
      previous?.t === "send" && previous.message.text === text
        ? previous
        : {
            t: "send",
            id: randomUUID(),
            channel,
            to,
            message: {
              id: randomUUID(),
              from: this.name,
              to,
              text,
              channel,
              timestamp: new Date().toISOString(),
              replyTo: null,
            },
          };
    this.#unconfirmed.set(route, frame);
    const result = await this.#request(
      frame,
      (reply): reply is SendResult =>
        !Array.isArray(reply) &&
        "ok" in reply &&
        (reply.ok ? "message" in reply : "error" in reply),
    );
    if (result !== null && this.#unconfirmed.get(route) === frame) {
      this.#unconfirmed.delete(route);
    }
    return result;
  }

  /** A page of a channel's log, older than `before` (newest when omitted). */
  async history(channel: string, before?: number, limit = 200): Promise<HistoryPage | null> {
    return this.#request(
      {
        t: "history",
        id: randomUUID(),
        channel,
        limit,
        ...(before === undefined ? {} : { before }),
      },
      (r): r is HistoryPage =>
        !Array.isArray(r) &&
        "ok" in r &&
        (r.ok ? "entries" in r && Array.isArray(r.entries) : "error" in r),
    );
  }

  /** Every entry of a channel's log, oldest first, read page by page from the newest back. */
  async allHistory(
    channel: string,
    pageSize = HISTORY_PAGE_MAX,
  ): Promise<{ ok: true; entries: HistoryEntry[] } | { ok: false; error: string }> {
    const pages: HistoryEntry[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = await this.history(channel, before, pageSize);
      if (!page) return { ok: false, error: "the mesh did not answer" };
      if (page.ok === false) return { ok: false, error: page.error };
      pages.unshift(page.entries);
      if (!page.hasMore || page.entries.length === 0) return { ok: true, entries: pages.flat() };
      before = page.entries[0]!.seq;
    }
  }

  /** Every channel the mesh knows, joined or not. */
  async listChannels(): Promise<ChannelInfo[] | null> {
    return this.#request({ t: "channels", id: randomUUID() }, (r): r is ChannelInfo[] =>
      Array.isArray(r),
    );
  }

  /** Delete a channel and its history; its members are removed and told. Refused for main. */
  async deleteChannel(channel: string): Promise<DeleteChannelReply | null> {
    return this.#request(
      { t: "delete_channel", id: randomUUID(), channel },
      (r): r is DeleteChannelReply =>
        !Array.isArray(r) &&
        "ok" in r &&
        (r.ok ? "deleted" in r && "removed" in r : "error" in r && !("channel" in r)),
    );
  }

  /** Join `channel` as a member (and watch it); returns its snapshot or why it failed. */
  async join(channel: string): Promise<ChannelSnapshot | string> {
    const reply = await this.#request(
      { t: "join", id: randomUUID(), channels: [channel] },
      (r): r is JoinReply =>
        !Array.isArray(r) &&
        "ok" in r &&
        (r.ok ? "channels" in r && r.channels.every((c) => typeof c === "object") : "channel" in r),
    );
    if (!reply) return "mesh unreachable";
    if (reply.ok === false)
      return reply.error === "name_taken"
        ? `name ${this.name} is taken in #${reply.channel}`
        : `${reply.error} (#${reply.channel})`;
    if (!this.#channels.includes(channel)) this.#channels = [...this.#channels, channel].sort();
    await this.#watch();
    return (
      reply.channels.find((snapshot) => snapshot.channel === channel) ??
      `#${channel} missing from the reply`
    );
  }

  /**
   * Watch every channel known to the app (joined or not), so other channels' messages,
   * members and unread counts stay live. Re-sent only when the set changes.
   */
  watch(names: readonly string[]): void {
    const next = [...new Set([...this.#channels, ...names])].sort();
    if (next.join("\n") === this.#watched.join("\n")) return;
    this.#watched = next;
    void this.#watch().catch((error) => console.error("Messenger watch failed:", error));
  }

  async #watch(): Promise<void> {
    const channels = [...new Set([...this.#channels, ...this.#watched])].sort();
    const reply = await this.#request(
      { t: "watch", id: randomUUID(), channels },
      (r): r is WatchReply =>
        !Array.isArray(r) && "ok" in r && (r.ok ? "watching" in r : "channel" in r),
    );
    if (reply?.ok)
      for (const snapshot of reply.watching) this.on.peers(snapshot.channel, snapshot.peers);
  }

  #handle(frame: ServerFrame): void {
    switch (frame.t) {
      case "welcome":
        clearTimeout(this.#welcomeTimer);
        this.#lastFrameAt = Date.now();
        this.#agent = { ...this.#agent, name: frame.name };
        this.#channels = frame.channels.map((snapshot) => snapshot.channel).sort();
        this.#backoff = 1000;
        this.#nameRetries = 0;
        clearInterval(this.#heartbeat);
        this.#heartbeat = setInterval(() => {
          const ws = this.#ws;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - this.#lastFrameAt > STALE_CONNECTION_MS)
            this.#disconnect(ws, "connection stale");
          else this.#send({ t: "ping" }, ws);
        }, HEARTBEAT_MS);
        this.on.state("connected");
        this.on.welcome(frame.name, frame.channels);
        void this.#watch().catch((error) => console.error("Messenger watch failed:", error));
        return;
      case "reject":
        if (frame.error === "name_taken" && this.#nameRetries < NAME_RETRY_LIMIT) {
          // Usually our own previous socket, still being reaped server-side.
          this.#nameRetries++;
          this.#ws?.close();
          return;
        }
        this.#closed = true;
        this.on.state(
          "rejected",
          frame.error === "bad_token"
            ? "the mesh rejected the token"
            : `${frame.error}${frame.channel ? ` (#${frame.channel})` : ""}`,
        );
        this.#ws?.close();
        return;
      case "peers":
        this.on.peers(frame.channel, frame.peers);
        return;
      case "log":
        this.on.log(frame.entry);
        return;
      case "message":
        // Channel posts are already in the log; only a direct message to us is new here.
        if (frame.message.kind !== "post") this.on.direct(frame.message);
        return;
      case "reply": {
        const pending = this.#pending.get(frame.id);
        if (!pending) return;
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame.result);
        return;
      }
      case "claims":
      case "completions":
      case "pong":
        return;
      case "channel_list":
        this.on.channels(frame.channels);
        return;
      case "channel_deleted":
        this.#watched = this.#watched.filter((channel) => channel !== frame.channel);
        this.on.deleted(frame.channel, frame.by);
        return;
      case "removed":
        this.#channels = [...frame.channels].sort();
        this.#watched = this.#watched.filter((c) => c !== frame.channel);
        this.on.removed(frame.channel, frame.by, frame.channels, frame.added);
        return;
    }
  }

  /** Send a request; resolves with the reply when `accept` recognizes its shape, else null (also on timeout or disconnect). */
  async #request<T extends ReplyResult>(
    frame: Extract<ClientFrame, { id: string }>,
    accept: (result: ReplyResult) => result is T,
  ): Promise<T | null> {
    const { promise, resolve } = Promise.withResolvers<ReplyResult | null>();
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return null;
    const timer = setTimeout(() => {
      this.#pending.delete(frame.id);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    this.#pending.set(frame.id, { resolve, timer });
    this.#send(frame);
    const result = await promise;
    return result !== null && accept(result) ? result : null;
  }

  #send(frame: ClientFrame, ws = this.#ws): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      this.#disconnect(ws, "connection send failed");
    }
  }

  #disconnect(ws: WebSocket, detail: string): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    clearTimeout(this.#welcomeTimer);
    clearInterval(this.#heartbeat);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.#pending.clear();
    try {
      ws.close();
    } catch {
      /* Already closed or unavailable. */
    }
    this.#scheduleReconnect(detail);
  }

  #scheduleReconnect(detail: string): void {
    if (this.#closed) return;
    this.on.state("reconnecting", detail);
    const delay = Math.round(this.#backoff * (0.8 + Math.random() * 0.4));
    this.#backoff = Math.min(this.#backoff * 2, 30_000);
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => this.connect(), delay);
  }
}
