/**
 * omp-messenger - Mesh server wire protocol (JSON text frames over WebSocket)
 *
 * Shared by mesh/client.ts and mesh/server.ts. Imports only types.
 *
 * One socket = one agent identity registered in one or more channels. The
 * agent's name is unique per channel; channel-scoped frames carry `channel`.
 */

import type { AgentMailMessage, AgentRegistration, AllClaims, AllCompletions } from "../lib.ts";
import type { ChannelInfo, ClaimResult, CompleteResult, RenameResult, SendResult, UnclaimResult } from "./types.ts";

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
  | { t: "hello"; token: string; channels: string[]; agent: AgentRegistration; claims: ClaimAssertion[] }
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
  | PartReply;

export type ServerFrame =
  | { t: "welcome"; name: string; channels: ChannelSnapshot[] }
  /** `channel` is set when the rejection concerns one channel of a multi-channel hello. */
  | { t: "reject"; error: RejectError; channel?: string }
  | { t: "peers"; channel: string; peers: AgentRegistration[] }
  | { t: "message"; channel: string; message: AgentMailMessage }
  | { t: "claims"; channel: string; claims: AllClaims }
  | { t: "completions"; channel: string; completions: AllCompletions }
  | { t: "reply"; id: string; result: ReplyResult }
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
