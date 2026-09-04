/**
 * Pi Messenger - Mesh transport contract
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
  | "unreachable";

export type SendResult =
  | { ok: true; message: AgentMailMessage }
  | { ok: false; error: SendError };

export interface SendOptions {
  replyTo?: string;
  /** Sender name override; defaults to the local agent name. */
  from?: string;
  /** Interrupting delivery on the receiver (steer) instead of a non-interrupting aside. */
  urgent?: boolean;
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
  channel?: string;
  nameTheme?: NameThemeConfig;
}

/**
 * The messenger's coordination layer. `state` (MessengerState) and `deliver`
 * are bound at construction; every method reads/mutates that state.
 */
export interface Mesh {
  readonly kind: "fs" | "mesh";
  status(): MeshStatus;
  /** Current channel name. */
  channel(): string;
  /** Register (name allocation + presence) and start inbox delivery. */
  join(ctx: ExtensionContext, opts?: JoinOptions): Promise<boolean>;
  /** Channels known to this mesh (current one included). */
  channels(): Promise<ChannelInfo[]>;
  /** Push the full registration (reservations, spec, session, activity, statusMessage). */
  publish(ctx: ExtensionContext): void;
  /** Unregister; throws when the registration could not be removed. */
  leave(): Promise<void>;
  rename(ctx: ExtensionContext, newName: string): Promise<RenameResult>;
  /** Synchronous peer snapshot; excludes self; applies `state.scopeToFolder`. */
  peers(): AgentRegistration[];
  /** Drop a dead local worker's registration eagerly. */
  evict(name: string): void;
  send(to: string, text: string, opts?: SendOptions): Promise<SendResult>;
  /** Idempotent: make sure inbox delivery is running. */
  recoverInbox(): void;
  /** Synchronous pull of anything pending (filesystem); no-op for the mesh client. */
  drainInbox(): void;
  claims(): AllClaims;
  completions(): AllCompletions;
  claim(ctx: ExtensionContext, spec: string, taskId: string, reason?: string): Promise<ClaimResult>;
  unclaim(spec: string, taskId: string): Promise<UnclaimResult>;
  complete(spec: string, taskId: string, notes?: string): Promise<CompleteResult>;
  /** Stop inbox delivery / close the socket; the instance stays reusable (join again). */
  close(): void;
}
