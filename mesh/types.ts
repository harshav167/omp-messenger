/**
 * omp-messenger - Mesh transport contract
 *
 * A Mesh is the coordination layer behind the messenger: presence, reservations,
 * messages, and swarm claims scoped to one channel. Two implementations exist:
 * the filesystem mesh (default, single host) and the mesh-server client.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
  AgentMailMessage,
  AgentRegistration,
  AllClaims,
  AllCompletions,
  ClaimEntry,
  CompletionEntry,
  NameThemeConfig,
} from "../lib.ts";

export type MeshStatus = "local" | "connected" | "reconnecting" | "disconnected";

export type SendError =
  | "invalid_name"
  | "not_found"
  | "not_active"
  | "invalid_registration"
  | "write_failed"
  | "unreachable"
  | "ambiguous_channel";

export type SendResult =
  | { ok: true; message: AgentMailMessage }
  | { ok: false; error: SendError };

export interface SendOptions {
  replyTo?: string;
  /** Sender name override; defaults to the local agent name. */
  from?: string;
  /** Non-interrupting delivery (aside) instead of the default interrupting steer. */
  gentle?: boolean;
  /**
   * Channel to route through. Required when the recipient name exists in more
   * than one of this agent's channels; otherwise resolved automatically.
   */
  channel?: string;
}

export type DeliverFn = (msg: AgentMailMessage) => void;

export interface ChannelInfo {
  name: string;
  members: number;
  createdAt: string;
}

export type RenameResult =
  | { success: true; oldName: string; newName: string }
  | { success: false; error: "not_registered" | "invalid_name" | "name_taken" | "same_name" | "race_lost" };

export type ClaimResult =
  | { success: true; claimedAt: string }
  | { success: false; error: "already_claimed"; conflict: ClaimEntry }
  | { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } };

export function isClaimSuccess(r: ClaimResult): r is { success: true; claimedAt: string } {
  return r.success === true;
}
export function isClaimAlreadyClaimed(r: ClaimResult): r is { success: false; error: "already_claimed"; conflict: ClaimEntry } {
  return "error" in r && r.error === "already_claimed";
}
export function isClaimAlreadyHaveClaim(r: ClaimResult): r is { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } } {
  return "error" in r && r.error === "already_have_claim";
}

export type UnclaimResult =
  | { success: true }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string };

export function isUnclaimSuccess(r: UnclaimResult): r is { success: true } {
  return r.success === true;
}
export function isUnclaimNotYours(r: UnclaimResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export type CompleteResult =
  | { success: true; completedAt: string }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string }
  | { success: false; error: "already_completed"; completion: CompletionEntry };

export function isCompleteSuccess(r: CompleteResult): r is { success: true; completedAt: string } {
  return r.success === true;
}
export function isCompleteAlreadyCompleted(r: CompleteResult): r is { success: false; error: "already_completed"; completion: CompletionEntry } {
  return "error" in r && r.error === "already_completed";
}
export function isCompleteNotYours(r: CompleteResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export interface JoinOptions {
  /** Channels to join (replaces the current set). Defaults to `state.channels`. */
  channels?: string[];
  nameTheme?: NameThemeConfig;
}

/** A peer as seen from this agent: its registration plus the joined channels it shares with us. */
export interface MeshPeer extends AgentRegistration {
  channels: string[];
}

/**
 * The messenger's coordination layer. `state` (MessengerState) and `deliver`
 * are bound at construction; every method reads/mutates that state.
 *
 * One identity, N channels: the agent is registered under the same name in
 * every channel of `state.channels`; peers, claims, and completions are the
 * union across those channels, each tagged with its channel.
 */
export interface Mesh {
  readonly kind: "fs" | "mesh";
  status(): MeshStatus;
  /** Channels this agent is registered in (sorted; empty when not joined). */
  channels(): string[];
  /** Register (name allocation + presence) in every channel and start inbox delivery. */
  join(ctx: ExtensionContext, opts?: JoinOptions): Promise<boolean>;
  /** Add channels to the current membership (idempotent). */
  joinChannels(ctx: ExtensionContext, channels: string[]): Promise<boolean>;
  /** Leave a subset of channels; leaving the last one unregisters entirely. */
  leaveChannels(channels: string[]): Promise<void>;
  /** Channels known to the mesh (joined or not). */
  listChannels(): Promise<ChannelInfo[]>;
  /** Push the full registration to every joined channel. */
  publish(ctx: ExtensionContext): void;
  /** Unregister from every channel; throws when a registration could not be removed. */
  leave(): Promise<void>;
  rename(ctx: ExtensionContext, newName: string): Promise<RenameResult>;
  /**
   * Synchronous peer snapshot: union across joined channels, excluding self,
   * `state.scopeToFolder` applied. `channels` lists every joined channel the
   * peer shares with us.
   */
  peers(): MeshPeer[];
  /** Drop a dead local worker's registration eagerly (every joined channel). */
  evict(name: string): void;
  send(to: string, text: string, opts?: SendOptions): Promise<SendResult>;
  /** Idempotent: make sure inbox delivery is running. */
  recoverInbox(): void;
  /** Synchronous pull of anything pending (filesystem); no-op for the mesh client. */
  drainInbox(): void;
  /** Merged claims across joined channels (a spec/task claimed in any channel counts). */
  claims(): AllClaims;
  completions(): AllCompletions;
  /** Claim in `channel` (default: the first joined channel). */
  claim(ctx: ExtensionContext, spec: string, taskId: string, reason?: string, channel?: string): Promise<ClaimResult>;
  unclaim(spec: string, taskId: string, channel?: string): Promise<UnclaimResult>;
  complete(spec: string, taskId: string, notes?: string, channel?: string): Promise<CompleteResult>;
  /** Stop inbox delivery / close the socket; the instance stays reusable (join again). */
  close(): void;
}
