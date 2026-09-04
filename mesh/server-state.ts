import { findAgentClaim } from "../lib.ts";
import type { AgentRegistration, AllClaims, AllCompletions, ClaimEntry, CompletionEntry } from "../lib.ts";
import type { Persist } from "./persist.ts";
import type { ChannelInfo, ClaimResult, CompleteResult, UnclaimResult } from "./types.ts";

export interface ChannelState {
  readonly createdAt: string;
  readonly presence: Map<string, AgentRegistration>;
  readonly claims: AllClaims;
  readonly completions: AllCompletions;
}

export interface ServerState {
  readonly channels: Map<string, ChannelState>;
  getOrCreate(channel: string): ChannelState;
  claim(channel: string, agent: string, spec: string, taskId: string, reason?: string): ClaimResult;
  unclaim(channel: string, agent: string, spec: string, taskId: string): UnclaimResult;
  complete(channel: string, agent: string, spec: string, taskId: string, notes?: string): CompleteResult;
  dropAgent(channel: string, name: string): void;
  renameAgent(channel: string, oldName: string, newName: string): void;
  listChannels(): ChannelInfo[];
}

class MissingPresenceError extends Error {
  constructor(agent: string) {
    super(`Agent ${agent} has no channel presence`);
    this.name = "MissingPresenceError";
  }
}

function purgeStaleClaims(channel: ChannelState): void {
  for (const [spec, tasks] of Object.entries(channel.claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (!channel.presence.has(claim.agent)) delete tasks[taskId];
    }
    if (Object.keys(tasks).length === 0) delete channel.claims[spec];
  }
}

export function createServerState(persist?: Persist): ServerState {
  const channels = new Map<string, ChannelState>();
  for (const saved of persist?.loadChannels() ?? []) {
    channels.set(saved.name, {
      createdAt: saved.createdAt,
      presence: new Map(),
      claims: {},
      completions: persist?.loadCompletions(saved.name) ?? {},
    });
  }

  const getOrCreate = (channel: string): ChannelState => {
    const existing = channels.get(channel);
    if (existing) return existing;
    const createdAt = new Date().toISOString();
    const created: ChannelState = {
      createdAt,
      presence: new Map(),
      claims: {},
      completions: persist?.loadCompletions(channel) ?? {},
    };
    channels.set(channel, created);
    persist?.saveChannel(channel, createdAt);
    return created;
  };

  return {
    channels,
    getOrCreate,
    claim(channel, agent, spec, taskId, reason) {
      const current = getOrCreate(channel);
      purgeStaleClaims(current);
      const agentClaim = findAgentClaim(current.claims, agent);
      if (agentClaim) {
        return { success: false, error: "already_have_claim", existing: { spec: agentClaim.spec, taskId: agentClaim.taskId } };
      }
      const conflict = current.claims[spec]?.[taskId];
      if (conflict) return { success: false, error: "already_claimed", conflict };
      const registration = current.presence.get(agent);
      if (!registration) throw new MissingPresenceError(agent);
      const claimedAt = new Date().toISOString();
      const entry: ClaimEntry = {
        agent,
        sessionId: registration.sessionId,
        pid: registration.pid,
        claimedAt,
        ...(reason === undefined ? {} : { reason }),
      };
      const claimsForSpec = current.claims[spec] ?? {};
      claimsForSpec[taskId] = entry;
      current.claims[spec] = claimsForSpec;
      return { success: true, claimedAt };
    },
    unclaim(channel, agent, spec, taskId) {
      const current = getOrCreate(channel);
      purgeStaleClaims(current);
      const claim = current.claims[spec]?.[taskId];
      if (!claim) return { success: false, error: "not_claimed" };
      if (claim.agent !== agent) return { success: false, error: "not_your_claim", claimedBy: claim.agent };
      delete current.claims[spec]?.[taskId];
      if (Object.keys(current.claims[spec] ?? {}).length === 0) delete current.claims[spec];
      return { success: true };
    },
    complete(channel, agent, spec, taskId, notes) {
      const current = getOrCreate(channel);
      purgeStaleClaims(current);
      const existing = current.completions[spec]?.[taskId];
      if (existing) return { success: false, error: "already_completed", completion: existing };
      const claim = current.claims[spec]?.[taskId];
      if (!claim) return { success: false, error: "not_claimed" };
      if (claim.agent !== agent) return { success: false, error: "not_your_claim", claimedBy: claim.agent };
      delete current.claims[spec]?.[taskId];
      if (Object.keys(current.claims[spec] ?? {}).length === 0) delete current.claims[spec];
      const completion: CompletionEntry = {
        completedBy: agent,
        completedAt: new Date().toISOString(),
        ...(notes === undefined ? {} : { notes }),
      };
      const completionsForSpec = current.completions[spec] ?? {};
      completionsForSpec[taskId] = completion;
      current.completions[spec] = completionsForSpec;
      persist?.saveCompletion(channel, spec, taskId, completion);
      return { success: true, completedAt: completion.completedAt };
    },
    dropAgent(channel, name) {
      const current = channels.get(channel);
      if (!current) return;
      current.presence.delete(name);
      purgeStaleClaims(current);
      if (channel !== "main" && current.presence.size === 0 && Object.keys(current.claims).length === 0) {
        channels.delete(channel);
      }
    },
    renameAgent(channel, oldName, newName) {
      const current = channels.get(channel);
      if (!current) return;
      const registration = current.presence.get(oldName);
      if (!registration) return;
      purgeStaleClaims(current);
      current.presence.delete(oldName);
      registration.name = newName;
      current.presence.set(newName, registration);
      for (const tasks of Object.values(current.claims)) {
        for (const claim of Object.values(tasks)) {
          if (claim.agent === oldName) claim.agent = newName;
        }
      }
    },
    listChannels() {
      return [...channels.entries()]
        .map(([name, channel]) => ({ name, members: channel.presence.size, createdAt: channel.createdAt }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.name.localeCompare(right.name));
    },
  };
}
