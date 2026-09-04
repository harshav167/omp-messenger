/**
 * Pi Messenger - Mesh server wire protocol (JSON text frames over WebSocket)
 *
 * Shared by mesh/client.ts and mesh/server.ts. Imports only types.
 */

import type { AgentMailMessage, AgentRegistration, AllClaims, AllCompletions } from "../lib.ts";
import type { ChannelInfo, ClaimResult, CompleteResult, RenameResult, SendResult, UnclaimResult } from "./types.ts";

export const MESH_SUBPROTOCOL = "pi-messenger.v1";

export const MESH_CLOSE = {
  HELLO_TIMEOUT: 4001,
  BAD_FRAME: 4002,
  BAD_TOKEN: 4003,
} as const;

export interface ClaimAssertion {
  spec: string;
  taskId: string;
  claimedAt: string;
  reason?: string;
}

export type ClientFrame =
  | { t: "hello"; token: string; channel: string; agent: AgentRegistration; claims: ClaimAssertion[] }
  | { t: "publish"; agent: AgentRegistration }
  | { t: "channels"; id: string }
  | { t: "send"; id: string; to: string; message: AgentMailMessage }
  | { t: "rename"; id: string; name: string }
  | { t: "claim"; id: string; spec: string; taskId: string; reason?: string }
  | { t: "unclaim"; id: string; spec: string; taskId: string }
  | { t: "complete"; id: string; spec: string; taskId: string; notes?: string }
  | { t: "ping" }
  | { t: "bye" };

export type RejectError = "bad_token" | "invalid_name" | "invalid_channel" | "name_taken";

export type ReplyResult = ChannelInfo[] | SendResult | RenameResult | ClaimResult | UnclaimResult | CompleteResult;

export type ServerFrame =
  | { t: "welcome"; name: string; channel: string; peers: AgentRegistration[]; claims: AllClaims; completions: AllCompletions }
  | { t: "reject"; error: RejectError }
  | { t: "peers"; peers: AgentRegistration[] }
  | { t: "message"; message: AgentMailMessage }
  | { t: "claims"; claims: AllClaims }
  | { t: "completions"; completions: AllCompletions }
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
