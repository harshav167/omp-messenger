/**
 * omp-messenger - Mesh server wire protocol (JSON text frames over WebSocket)
 *
 * Shared by mesh/client.ts and mesh/server.ts. Imports only types.
 *
 * One socket = one agent identity registered in one or more channels. The
 * agent's name is unique per channel; channel-scoped frames carry `channel`.
 */

import type { AgentMailMessage, AgentRegistration, AllClaims, AllCompletions, HistoryEntry } from "../lib.ts";
import type { ChannelInfo, ClaimResult, CompleteResult, DeleteChannelResult, RenameResult, SendResult, UnclaimResult } from "./types.ts";

export const MESH_SUBPROTOCOL = "omp-messenger.v2";

export const MESH_CLOSE = {
  HELLO_TIMEOUT: 4001,
  BAD_FRAME: 4002,
  BAD_TOKEN: 4003,
} as const;

export interface ClaimAssertion {
  channel: string;
  spec: string;
  taskId: string;
  claimedAt: string;
  reason?: string;
}

export type ClientFrame =
  /** `identityKey` is a per-machine secret (never broadcast) that lets one person's windows share a human name. */
  | { t: "hello"; token: string; channels: string[]; agent: AgentRegistration; claims: ClaimAssertion[]; identityKey?: string }
  | { t: "publish"; agent: AgentRegistration }
  /** Add channels to this socket's membership (idempotent). */
  | { t: "join"; id: string; channels: string[] }
  /** Remove channels from this socket's membership. Removing every channel closes the socket (1000). */
  | { t: "part"; id: string; channels: string[] }
  | { t: "channels"; id: string }
  | { t: "send"; id: string; channel: string; to: string; message: AgentMailMessage }
  | { t: "rename"; id: string; name: string }
  | { t: "claim"; id: string; channel: string; spec: string; taskId: string; reason?: string }
  | { t: "unclaim"; id: string; channel: string; spec: string; taskId: string }
  | { t: "complete"; id: string; channel: string; spec: string; taskId: string; notes?: string }
  /**
   * A channel message: logged, then delivered to every other member of the channel. Members
   * the text mentions (`@name`, `@all`) get an interrupting delivery; the rest a gentle one.
   */
  | { t: "post"; id: string; channel: string; text: string; replyTo?: string }
  /** A page of the channel's log, newest last: entries with `seq < before` (default: the newest). */
  | { t: "history"; id: string; channel: string; before?: number; limit?: number }
  /**
   * Observe channels (replaces the watched set): every logged message (posts and the direct
   * messages between members) arrives as a `log` frame, and presence/claims as for members.
   * Watching doesn't make the socket a member: it can't post there or be messaged there.
   */
  | { t: "watch"; id: string; channels: string[] }
  /**
   * Delete a channel with its history (refused for `main`). Every member is removed from it,
   * gets a `removed` frame and a message saying who deleted it; a member left without any
   * channel is moved to `main` so it stays reachable.
   */
  | { t: "delete_channel"; id: string; channel: string }
  | { t: "ping" }
  | { t: "bye" };

export type RejectError = "bad_token" | "invalid_name" | "invalid_channel" | "name_taken";

/** Per-channel snapshot pushed in `welcome` and in successful `join` replies. */
export interface ChannelSnapshot {
  channel: string;
  peers: AgentRegistration[];
  claims: AllClaims;
  completions: AllCompletions;
}

export type JoinReply =
  | { ok: true; channels: ChannelSnapshot[] }
  | { ok: false; error: "invalid_channel" | "name_taken" | "not_joined"; channel: string };

export type PartReply = { ok: true; channels: string[] };

export type ReplyResult =
  | ChannelInfo[]
  | SendResult
  | RenameResult
  | ClaimResult
  | UnclaimResult
  | CompleteResult
  | JoinReply
  | PartReply
  | PostResult
  | HistoryPage
  | WatchReply
  | DeleteChannelReply;

export type DeleteChannelReply = DeleteChannelResult;

export type PostResult =
  | { ok: true; entry: HistoryEntry; delivered: string[] }
  | { ok: false; error: "not_joined" | "empty" | "invalid_channel" };

export type HistoryPage =
  | { ok: true; channel: string; entries: HistoryEntry[]; hasMore: boolean }
  | { ok: false; error: "invalid_channel" };

export type WatchReply =
  | { ok: true; watching: ChannelSnapshot[] }
  | { ok: false; error: "invalid_channel"; channel: string };

/** Largest page a `history` request returns. */
export const HISTORY_PAGE_MAX = 500;

export type ServerFrame =
  | { t: "welcome"; name: string; channels: ChannelSnapshot[] }
  /** `channel` is set when the rejection concerns one channel of a multi-channel hello. */
  | { t: "reject"; error: RejectError; channel?: string }
  | { t: "peers"; channel: string; peers: AgentRegistration[] }
  | { t: "message"; channel: string; message: AgentMailMessage }
  | { t: "claims"; channel: string; claims: AllClaims }
  | { t: "completions"; channel: string; completions: AllCompletions }
  | { t: "reply"; id: string; result: ReplyResult }
  /** A message logged in a watched channel. */
  | { t: "log"; channel: string; entry: HistoryEntry }
  /** The mesh's channels changed (one created, emptied, or a member count moved). Sent to every member. */
  | { t: "channel_list"; channels: ChannelInfo[] }
  | { t: "channel_deleted"; channel: string; by: string }
  /**
   * This socket was removed from `channel` (it was deleted by `by`). `channels` is the
   * membership now; `added` snapshots channels joined on its behalf (`main` when none was left).
   */
  | { t: "removed"; channel: string; by: string; channels: string[]; added: ChannelSnapshot[] }
  | { t: "pong" };

export function parseFrame<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.t !== "string") return null;
    return parsed as T;
  } catch {
    return null;
  }
}
