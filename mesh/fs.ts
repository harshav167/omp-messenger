/**
 * omp-messenger - File Storage Operations
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  type AgentMailMessage,
  type AgentRegistration,
  type AllClaims,
  type AllCompletions,
  type ClaimEntry,
  type CompletionEntry,
  type Dirs,
  LOCAL_HOST_ID,
  MAX_WATCHER_RETRIES,
  type MessengerState,
  type NameThemeConfig,
  type SpecClaims,
  generateMemorableName,
  isProcessAlive,
  isValidAgentName,
  normalizeAgentMailMessage,
  normalizeChannels,
} from "../lib.ts";
import { buildRegistration, normalizeCwd } from "./registration.ts";
import type {
  ClaimResult,
  CompleteResult,
  DeliverFn,
  Mesh,
  MeshPeer,
  RenameResult,
  SendError,
  SendOptions,
  UnclaimResult,
} from "./types.ts";

interface AgentsCache {
  allAgents: AgentRegistration[];
  filtered: Map<string, AgentRegistration[]>;
  timestamp: number;
}


interface FsRuntime {
  /** Agents cache per channel registry path. */
  agentsCache: Map<string, AgentsCache>;
  cacheGeneration: number;
  isProcessingMessages: boolean;
  /** Channels that asked for message processing while another run was active. */
  pendingProcess: Map<string, Dirs>;
  /** Inbox watchers per joined channel. */
  watches: Map<string, ChannelWatch>;
}

interface ChannelWatch {
  watcher: fs.FSWatcher | null;
  retries: number;
  retryTimer: Timer | null;
  debounceTimer: Timer | null;
}

const AGENTS_CACHE_TTL_MS = 1000;
let agentsCacheGeneration = 0;

export function invalidateAgentsCache(): void {
  agentsCacheGeneration++;
}

function refreshCacheGeneration(runtime: FsRuntime): void {
  if (runtime.cacheGeneration === agentsCacheGeneration) return;
  runtime.agentsCache.clear();
  runtime.cacheGeneration = agentsCacheGeneration;
}

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const LOCK_STALE_MS = 10000;

async function withSwarmLock<T>(baseDir: string, fn: () => T): Promise<T> {
  const lockPath = join(baseDir, "swarm.lock");
  const maxRetries = 50;
  const retryDelay = 100;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        try {
          const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
          if (!pid || !isProcessAlive(pid)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Lock doesn't exist
    }

    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (i === maxRetries - 1) {
          throw new Error("Failed to acquire swarm lock");
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, retryDelay);
        await promise;
        continue;
      }
      throw err;
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }
}

// =============================================================================
// Registry Operations
// =============================================================================

function getRegistrationPath(state: MessengerState, dirs: Dirs): string {
  return join(dirs.registry, `${state.agentName}.json`);
}

function readAliveAgents(registry: string): AgentRegistration[] {
  const allAgents: AgentRegistration[] = [];
  if (!fs.existsSync(registry)) return allAgents;

  let files: string[];
  try {
    files = fs.readdirSync(registry);
  } catch {
    return allAgents;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const content = fs.readFileSync(join(registry, file), "utf-8");
      const reg: AgentRegistration = JSON.parse(content);

      if (!isProcessAlive(reg.pid)) {
        try {
          fs.unlinkSync(join(registry, file));
        } catch {
          // Ignore cleanup errors
        }
        continue;
      }

      reg.hostId ??= LOCAL_HOST_ID;
      if (reg.session === undefined) {
        reg.session = { toolCalls: 0, tokens: 0, filesModified: [] };
      }
      if (reg.activity === undefined) {
        reg.activity = { lastActivityAt: reg.startedAt };
      }
      if (reg.isHuman === undefined) {
        reg.isHuman = false;
      }
      reg.cwd = normalizeCwd(reg.cwd);
      allAgents.push(reg);
    } catch {
      // Ignore malformed registrations
    }
  }
  return allAgents;
}

function getActiveAgents(state: MessengerState, dirs: Dirs, runtime: FsRuntime): AgentRegistration[] {
  refreshCacheGeneration(runtime);
  const now = Date.now();
  const excludeName = state.agentName;
  const myCwd = normalizeCwd(state.cwd);
  const scopeToFolder = state.scopeToFolder;
  const cacheKey = scopeToFolder ? `${excludeName}:${myCwd}` : excludeName;
  const cached = runtime.agentsCache.get(dirs.registry);

  if (cached && now - cached.timestamp < AGENTS_CACHE_TTL_MS) {
    const cachedFiltered = cached.filtered.get(cacheKey);
    if (cachedFiltered) return cachedFiltered;

    let filtered = cached.allAgents.filter(agent => agent.name !== excludeName);
    if (scopeToFolder) {
      filtered = filtered.filter(agent => agent.hostId === LOCAL_HOST_ID && agent.cwd === myCwd);
    }
    cached.filtered.set(cacheKey, filtered);
    return filtered;
  }

  const allAgents = readAliveAgents(dirs.registry);

  let filtered = allAgents.filter(agent => agent.name !== excludeName);
  if (scopeToFolder) {
    filtered = filtered.filter(agent => agent.hostId === LOCAL_HOST_ID && agent.cwd === myCwd);
  }
  const filteredMap = new Map<string, AgentRegistration[]>();
  filteredMap.set(cacheKey, filtered);
  runtime.agentsCache.set(dirs.registry, { allAgents, filtered: filteredMap, timestamp: now });

  return filtered;
}

/** An alive registration for `name` held by another pid in this channel's registry. */
function nameConflict(dirs: Dirs, name: string): boolean {
  const regPath = join(dirs.registry, `${name}.json`);
  if (!fs.existsSync(regPath)) return false;
  try {
    const existing: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    return isProcessAlive(existing.pid) && existing.pid !== process.pid;
  } catch {
    return false;
  }
}

/** First channel where `name` is taken by another live agent, or null. */
function nameConflictChannel(base: string, channels: readonly string[], name: string): string | null {
  for (const channel of channels) {
    if (nameConflict(channelDirs(base, channel), name)) return channel;
  }
  return null;
}

function findAvailableName(baseName: string, base: string, channels: readonly string[]): string | null {
  if (!nameConflictChannel(base, channels, baseName)) return baseName;

  for (let i = 2; i <= 99; i++) {
    const altName = `${baseName}${i}`;
    if (!nameConflictChannel(base, channels, altName)) return altName;
  }

  return null;
}

interface WriteRegistrationsResult {
  ok: boolean;
  reason?: "write_failed" | "verify_failed";
  detail?: string;
}

/** Write the same registration file into every channel, then verify each write. */
function writeRegistrationFiles(
  state: MessengerState,
  base: string,
  channels: readonly string[],
  registration: AgentRegistration,
): WriteRegistrationsResult {
  for (const channel of channels) {
    const dirs = channelDirs(base, channel);
    ensureDirSync(dirs.registry);
    ensureDirSync(getMyInbox(state, dirs));
    const regPath = getRegistrationPath(state, dirs);
    if (fs.existsSync(regPath)) {
      try {
        fs.unlinkSync(regPath);
      } catch {
        // Ignore
      }
    }
    try {
      fs.writeFileSync(regPath, JSON.stringify(registration, null, 2));
    } catch (err) {
      return { ok: false, reason: "write_failed", detail: err instanceof Error ? err.message : "unknown error" };
    }
  }

  for (const channel of channels) {
    const regPath = getRegistrationPath(state, channelDirs(base, channel));
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      if (written.pid !== process.pid) return { ok: false, reason: "verify_failed" };
    } catch {
      return { ok: false, reason: "verify_failed" };
    }
  }
  return { ok: true };
}

/** Remove registration files for `name` that still contain our pid (best-effort rollback). */
function rollbackRegistrations(base: string, channels: readonly string[], name: string): void {
  for (const channel of channels) {
    const regPath = join(channelDirs(base, channel).registry, `${name}.json`);
    try {
      const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      if (reg.pid === process.pid) fs.unlinkSync(regPath);
    } catch {
      // Missing or already overwritten by another agent
    }
  }
}

function register(
  state: MessengerState,
  base: string,
  channels: readonly string[],
  ctx: ExtensionContext,
  nameTheme?: NameThemeConfig,
): boolean {
  if (state.registered) return true;

  if (!state.agentName) {
    state.agentName = generateMemorableName(nameTheme);
  }

  const isExplicitName = state.explicitName;
  const maxAttempts = isExplicitName ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // The name must be free in EVERY channel before any file is written.
    if (isExplicitName) {
      if (!isValidAgentName(state.agentName)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`, "error");
        }
        return false;
      }
      const conflict = nameConflictChannel(base, channels, state.agentName);
      if (conflict) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Agent name "${state.agentName}" already in use in #${conflict}`, "error");
        }
        return false;
      }
    } else {
      const availableName = findAvailableName(state.agentName, base, channels);
      if (!availableName) {
        if (ctx.hasUI) {
          ctx.ui.notify("Could not find available agent name after 99 attempts", "error");
        }
        return false;
      }
      state.agentName = availableName;
    }

    const registration = buildRegistration(state, ctx, state.agentName);
    const written = writeRegistrationFiles(state, base, channels, registration);
    if (written.ok) {
      state.registered = true;
      state.model = registration.model;
      state.cwd = registration.cwd;
      state.gitBranch = registration.gitBranch;
      state.activity.lastActivityAt = registration.startedAt;
      invalidateAgentsCache();
      return true;
    }

    rollbackRegistrations(base, channels, state.agentName);

    if (written.reason === "write_failed") {
      if (ctx.hasUI) {
        ctx.ui.notify(`Failed to register: ${written.detail ?? "unknown error"}`, "error");
      }
      return false;
    }

    // Another agent claimed this name - retry with fresh lookup (auto-generated only)
    if (isExplicitName) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Agent name "${state.agentName}" was claimed by another agent`, "error");
      }
      return false;
    }
    invalidateAgentsCache();
  }

  // Exhausted retries
  if (ctx.hasUI) {
    ctx.ui.notify("Failed to register after multiple attempts due to name conflicts", "error");
  }
  return false;
}

function updateRegistration(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    const currentModel = ctx.model?.id ?? reg.model;
    reg.model = currentModel;
    state.model = currentModel;
    reg.cwd = state.cwd;
    reg.reservations = state.reservations.length > 0 ? state.reservations : undefined;
    if (state.spec) {
      reg.spec = state.spec;
    } else {
      delete reg.spec;
    }
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    reg.statusMessage = state.statusMessage;
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  } catch {
    // Ignore errors
  }
}


function unregisterChannel(state: MessengerState, dirs: Dirs): void {
  const regPath = getRegistrationPath(state, dirs);
  try {
    fs.unlinkSync(regPath);
  } catch (error) {
    if (fs.existsSync(regPath)) {
      throw error;
    }
  }
  invalidateAgentsCache();
}


function renameAgent(
  state: MessengerState,
  base: string,
  ctx: ExtensionContext,
  newName: string,
  deliver: DeliverFn,
  runtime: FsRuntime,
): RenameResult {
  if (!state.registered) {
    return { success: false, error: "not_registered" };
  }

  if (!isValidAgentName(newName)) {
    return { success: false, error: "invalid_name" };
  }

  if (newName === state.agentName) {
    return { success: false, error: "same_name" };
  }

  const channels = state.channels;
  if (nameConflictChannel(base, channels, newName)) {
    return { success: false, error: "name_taken" };
  }

  const oldName = state.agentName;

  for (const channel of channels) {
    processAllPendingMessages(state, channelDirs(base, channel), deliver, runtime, channel);
  }

  const registration = buildRegistration(state, ctx, newName);

  // Write the new registration in every channel before removing the old one.
  for (const channel of channels) {
    const dirs = channelDirs(base, channel);
    ensureDirSync(dirs.registry);
    const newRegPath = join(dirs.registry, `${newName}.json`);
    try {
      fs.writeFileSync(newRegPath, JSON.stringify(registration, null, 2));
    } catch {
      rollbackRegistrations(base, channels, newName);
      return { success: false, error: "invalid_name" };
    }
  }

  // Verify we own every new registration (guards against race condition)
  for (const channel of channels) {
    const newRegPath = join(channelDirs(base, channel).registry, `${newName}.json`);
    let ours = false;
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
      ours = written.pid === process.pid;
    } catch {
      // Not readable means not verifiably ours
    }
    if (!ours) {
      rollbackRegistrations(base, channels, newName);
      return { success: false, error: "race_lost" };
    }
  }

  for (const channel of channels) {
    const dirs = channelDirs(base, channel);
    try {
      fs.unlinkSync(join(dirs.registry, `${oldName}.json`));
    } catch {
      // Ignore - old file might already be gone
    }

    const newInbox = join(dirs.inbox, newName);
    if (fs.existsSync(newInbox)) {
      try {
        const staleFiles = fs.readdirSync(newInbox).filter(f => f.endsWith(".json"));
        for (const file of staleFiles) {
          try {
            fs.unlinkSync(join(newInbox, file));
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }
    ensureDirSync(newInbox);

    try {
      fs.rmdirSync(join(dirs.inbox, oldName));
    } catch {
      // Ignore - might have new messages or not exist
    }
  }

  state.agentName = newName;
  state.model = registration.model;
  state.cwd = registration.cwd;
  state.gitBranch = registration.gitBranch;
  state.sessionStartedAt = registration.startedAt;
  state.activity.lastActivityAt = registration.startedAt;
  invalidateAgentsCache();
  return { success: true, oldName, newName };
}


// =============================================================================
// Swarm Coordination
// =============================================================================

const CLAIMS_FILE = "claims.json";
const COMPLETIONS_FILE = "completions.json";

function readClaimsSync(dirs: Dirs): AllClaims {
  const path = join(dirs.base, CLAIMS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllClaims;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function readCompletionsSync(dirs: Dirs): AllCompletions {
  const path = join(dirs.base, COMPLETIONS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllCompletions;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function writeClaimsSync(dirs: Dirs, claims: AllClaims): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, CLAIMS_FILE);
  const temp = join(dirs.base, `${CLAIMS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(claims, null, 2));
  fs.renameSync(temp, target);
}

function writeCompletionsSync(dirs: Dirs, completions: AllCompletions): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, COMPLETIONS_FILE);
  const temp = join(dirs.base, `${COMPLETIONS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(completions, null, 2));
  fs.renameSync(temp, target);
}

function isClaimStale(claim: ClaimEntry, dirs: Dirs): boolean {
  if (!isProcessAlive(claim.pid)) return true;
  const regPath = join(dirs.registry, `${claim.agent}.json`);
  if (!fs.existsSync(regPath)) return true;
  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!isProcessAlive(reg.pid)) return true;
    if (reg.sessionId !== claim.sessionId) return true;
  } catch {
    return true;
  }
  return false;
}

function cleanupStaleClaims(claims: AllClaims, dirs: Dirs): number {
  let removed = 0;
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (isClaimStale(claim, dirs)) {
        delete tasks[taskId];
        removed++;
      }
    }
    if (Object.keys(tasks).length === 0) {
      delete claims[spec];
    }
  }
  return removed;
}

function filterStaleClaims(claims: AllClaims, dirs: Dirs): AllClaims {
  const filtered: AllClaims = {};
  for (const [spec, tasks] of Object.entries(claims)) {
    const filteredTasks: SpecClaims = {};
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (!isClaimStale(claim, dirs)) {
        filteredTasks[taskId] = claim;
      }
    }
    if (Object.keys(filteredTasks).length > 0) {
      filtered[spec] = filteredTasks;
    }
  }
  return filtered;
}

function findAgentClaim(claims: AllClaims, agent: string): { spec: string; taskId: string } | null {
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent === agent) {
        return { spec, taskId };
      }
    }
  }
  return null;
}

function getClaims(dirs: Dirs): AllClaims {
  const claims = readClaimsSync(dirs);
  return filterStaleClaims(claims, dirs);
}


function getCompletions(dirs: Dirs): AllCompletions {
  return readCompletionsSync(dirs);
}


async function claimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  sessionId: string,
  pid: number,
  reason?: string
): Promise<ClaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existing = findAgentClaim(claims, agent);
    if (existing) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_have_claim", existing };
    }

    const existingClaim = claims[specPath]?.[taskId];
    if (existingClaim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_claimed", conflict: existingClaim };
    }

    if (!claims[specPath]) claims[specPath] = {};
    const newClaim: ClaimEntry = {
      agent,
      sessionId,
      pid,
      claimedAt: new Date().toISOString(),
      reason
    };
    claims[specPath][taskId] = newClaim;
    writeClaimsSync(dirs, claims);
    return { success: true, claimedAt: newClaim.claimedAt };
  });
}


async function unclaimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string
): Promise<UnclaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }
    writeClaimsSync(dirs, claims);
    return { success: true };
  });
}


async function completeTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  notes?: string
): Promise<CompleteResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const completions = readCompletionsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existingCompletion = completions[specPath]?.[taskId];
    if (existingCompletion) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_completed", completion: existingCompletion };
    }

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }

    if (!completions[specPath]) completions[specPath] = {};
    const completion: CompletionEntry = {
      completedBy: agent,
      completedAt: new Date().toISOString(),
      notes
    };
    completions[specPath][taskId] = completion;

    // Write completions first - if claims write fails, we at least have the completion
    // recorded (the important part). The stale claim will be cleaned up eventually.
    writeCompletionsSync(dirs, completions);
    writeClaimsSync(dirs, claims);
    return { success: true, completedAt: completion.completedAt };
  });
}

// =============================================================================
// Messaging Operations
// =============================================================================

function getMyInbox(state: MessengerState, dirs: Dirs): string {
  return join(dirs.inbox, state.agentName);
}

function processAllPendingMessages(
  state: MessengerState,
  dirs: Dirs,
  deliver: DeliverFn,
  runtime: FsRuntime,
  channel: string,
): void {
  if (!state.registered) return;

  if (runtime.isProcessingMessages) {
    runtime.pendingProcess.set(channel, dirs);
    return;
  }

  runtime.isProcessingMessages = true;

  try {
    const inbox = getMyInbox(state, dirs);
    if (!fs.existsSync(inbox)) return;

    let files: string[];
    try {
      files = fs.readdirSync(inbox).filter(f => f.endsWith(".json")).sort();
    } catch {
      return;
    }

    for (const file of files) {
      const msgPath = join(inbox, file);
      try {
        const content = fs.readFileSync(msgPath, "utf-8");
        const msg = normalizeAgentMailMessage(JSON.parse(content), {
          id: file.endsWith(".json") ? file.slice(0, -5) : file,
          from: "unknown",
          to: state.agentName,
          timestamp: new Date().toISOString(),
        });
        msg.channel = channel;
        deliver(msg);
        fs.unlinkSync(msgPath);
      } catch {
        // On any failure (read, parse, deliver), delete to avoid infinite retry loops
        try {
          fs.unlinkSync(msgPath);
        } catch {
          // Already gone or can't delete
        }
      }
    }
  } finally {
    runtime.isProcessingMessages = false;

    if (runtime.pendingProcess.size > 0) {
      const pending = [...runtime.pendingProcess.entries()];
      runtime.pendingProcess.clear();
      for (const [pendingChannel, pendingDirs] of pending) {
        processAllPendingMessages(state, pendingDirs, deliver, runtime, pendingChannel);
      }
    }
  }
}

function sendMessageToAgent(
  dirs: Dirs,
  to: string,
  text: string,
  from: string,
  replyTo: string | null,
  gentle: boolean,
  channel: string,
): AgentMailMessage {
  const targetInbox = join(dirs.inbox, to);
  ensureDirSync(targetInbox);

  const msg: AgentMailMessage = {
    id: randomUUID(),
    from,
    to,
    text,
    timestamp: new Date().toISOString(),
    replyTo,
    channel,
    ...(gentle ? { gentle: true } : {}),
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = join(targetInbox, `${Date.now()}-${random}.json`);
  fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));

  return msg;
}

// =============================================================================
// Watcher
// =============================================================================

const WATCHER_DEBOUNCE_MS = 50;

function channelWatch(runtime: FsRuntime, channel: string): ChannelWatch {
  let watch = runtime.watches.get(channel);
  if (!watch) {
    watch = { watcher: null, retries: 0, retryTimer: null, debounceTimer: null };
    runtime.watches.set(channel, watch);
  }
  return watch;
}

function startWatcher(
  state: MessengerState,
  dirs: Dirs,
  deliver: DeliverFn,
  runtime: FsRuntime,
  channel: string,
): void {
  if (!state.registered) return;
  const watch = channelWatch(runtime, channel);
  if (watch.watcher) return;
  if (watch.retries >= MAX_WATCHER_RETRIES) return;

  const inbox = getMyInbox(state, dirs);
  ensureDirSync(inbox);

  processAllPendingMessages(state, dirs, deliver, runtime, channel);

  function scheduleRetry(): void {
    watch.retries++;
    if (watch.retries < MAX_WATCHER_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, watch.retries - 1), 30000);
      watch.retryTimer = setTimeout(() => {
        watch.retryTimer = null;
        startWatcher(state, dirs, deliver, runtime, channel);
      }, delay);
    }
  }

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(inbox, () => {
      // Debounce rapid events
      if (watch.debounceTimer) {
        clearTimeout(watch.debounceTimer);
      }
      watch.debounceTimer = setTimeout(() => {
        watch.debounceTimer = null;
        processAllPendingMessages(state, dirs, deliver, runtime, channel);
      }, WATCHER_DEBOUNCE_MS);
    });
  } catch {
    scheduleRetry();
    return;
  }
  watch.watcher = watcher;

  watcher.on("error", () => {
    stopWatcher(runtime, channel);
    scheduleRetry();
  });

  watch.retries = 0;
}

function stopWatcher(runtime: FsRuntime, channel: string): void {
  const watch = runtime.watches.get(channel);
  if (!watch) return;
  if (watch.debounceTimer) {
    clearTimeout(watch.debounceTimer);
    watch.debounceTimer = null;
  }
  if (watch.retryTimer) {
    clearTimeout(watch.retryTimer);
    watch.retryTimer = null;
  }
  if (watch.watcher) {
    watch.watcher.close();
    watch.watcher = null;
  }
}


// =============================================================================
// Target Validation
// =============================================================================

type TargetValidation =
  | { valid: true }
  | { valid: false; error: "invalid_name" | "not_found" | "not_active" | "invalid_registration" };

function validateTargetAgent(to: string, dirs: Dirs): TargetValidation {
  if (!isValidAgentName(to)) {
    return { valid: false, error: "invalid_name" };
  }

  const targetReg = join(dirs.registry, `${to}.json`);
  if (!fs.existsSync(targetReg)) {
    return { valid: false, error: "not_found" };
  }

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(targetReg, "utf-8"));
    if (!isProcessAlive(reg.pid)) {
      try {
        fs.unlinkSync(targetReg);
      } catch {
        // Ignore cleanup errors
      }
      return { valid: false, error: "not_active" };
    }
  } catch {
    return { valid: false, error: "invalid_registration" };
  }

  return { valid: true };
}

function channelDirs(base: string, channel: string): Dirs {
  const channelBase = channel === "main" ? base : join(base, "channels", channel);
  return {
    base: channelBase,
    registry: join(channelBase, "registry"),
    inbox: join(channelBase, "inbox"),
  };
}

function countAliveMembers(registry: string): number {
  if (!fs.existsSync(registry)) return 0;

  let members = 0;
  let files: string[];
  try {
    files = fs.readdirSync(registry);
  } catch {
    return 0;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const registration: AgentRegistration = JSON.parse(fs.readFileSync(join(registry, file), "utf-8"));
      if (isProcessAlive(registration.pid)) members++;
    } catch {
      // Ignore malformed registrations.
    }
  }
  return members;
}

function channelInfo(base: string, name: string): { name: string; members: number; createdAt: string } {
  const dirs = channelDirs(base, name);
  let createdAt = new Date(0).toISOString();
  try {
    createdAt = fs.statSync(dirs.base).birthtime.toISOString();
  } catch {
    // A missing main directory is still listed as an empty channel.
  }
  return { name, members: countAliveMembers(dirs.registry), createdAt };
}

export function createFsMesh(base: string, state: MessengerState, deliver: DeliverFn): Mesh {
  const runtime: FsRuntime = {
    agentsCache: new Map(),
    cacheGeneration: agentsCacheGeneration,
    isProcessingMessages: false,
    pendingProcess: new Map(),
    watches: new Map(),
  };

  function notifyInvalidChannels(ctx: ExtensionContext, err: unknown): void {
    if (ctx.hasUI) {
      ctx.ui.notify(err instanceof Error ? err.message : "Invalid channel name", "error");
    }
  }

  /** Dirs for a claim operation; the channel must be one we joined. */
  function joinedDirs(channel: string | undefined): Dirs {
    const name = channel ?? state.channels[0];
    if (name === undefined || !state.channels.includes(name)) {
      throw new Error(`not joined: ${name}`);
    }
    return channelDirs(base, name);
  }

  const mesh: Mesh = {
    kind: "fs",
    status: () => "local",
    channels: () => (state.registered ? [...state.channels] : []),

    async join(ctx, opts) {
      let channels: string[];
      try {
        channels = normalizeChannels(opts?.channels ?? state.channels);
      } catch (err) {
        notifyInvalidChannels(ctx, err);
        return false;
      }
      if (state.registered) {
        // Reconcile membership: join additions first so the set never empties mid-flight.
        const added = channels.filter(c => !state.channels.includes(c));
        const removed = state.channels.filter(c => !channels.includes(c));
        if (added.length > 0 && !(await mesh.joinChannels(ctx, added))) return false;
        if (removed.length > 0) await mesh.leaveChannels(removed);
        return true;
      }
      state.channels = channels;
      const joined = register(state, base, state.channels, ctx, opts?.nameTheme);
      if (joined) {
        for (const channel of state.channels) {
          startWatcher(state, channelDirs(base, channel), deliver, runtime, channel);
        }
      }
      return joined;
    },

    async joinChannels(ctx, chs) {
      let next: string[];
      try {
        next = normalizeChannels([...state.channels, ...chs]);
      } catch (err) {
        notifyInvalidChannels(ctx, err);
        return false;
      }
      if (!state.registered) {
        state.channels = next;
        return true;
      }
      const added = next.filter(c => !state.channels.includes(c));
      if (added.length === 0) {
        state.channels = next;
        return true;
      }
      const conflict = nameConflictChannel(base, added, state.agentName);
      if (conflict) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Agent name "${state.agentName}" already in use in #${conflict}`, "error");
        }
        return false;
      }
      const registration = buildRegistration(state, ctx, state.agentName);
      const written = writeRegistrationFiles(state, base, added, registration);
      if (!written.ok) {
        rollbackRegistrations(base, added, state.agentName);
        if (ctx.hasUI) {
          ctx.ui.notify(
            written.reason === "write_failed"
              ? `Failed to register: ${written.detail ?? "unknown error"}`
              : `Agent name "${state.agentName}" was claimed by another agent`,
            "error",
          );
        }
        return false;
      }
      state.channels = next;
      for (const channel of added) {
        startWatcher(state, channelDirs(base, channel), deliver, runtime, channel);
      }
      invalidateAgentsCache();
      return true;
    },

    async leaveChannels(chs) {
      for (const channel of chs) {
        if (!state.channels.includes(channel)) continue;
        stopWatcher(runtime, channel);
        runtime.watches.delete(channel);
        unregisterChannel(state, channelDirs(base, channel));
        state.channels = state.channels.filter(c => c !== channel);
      }
      if (state.channels.length === 0) state.registered = false;
    },

    async listChannels() {
      const channels = [channelInfo(base, "main")];
      const channelsDir = join(base, "channels");
      if (!fs.existsSync(channelsDir)) return channels;

      let names: string[];
      try {
        names = fs.readdirSync(channelsDir, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
          .sort();
      } catch {
        return channels;
      }
      for (const name of names) channels.push(channelInfo(base, name));
      return channels;
    },

    publish(ctx) {
      for (const channel of state.channels) {
        updateRegistration(state, channelDirs(base, channel), ctx);
      }
    },

    async leave() {
      await mesh.leaveChannels([...state.channels]);
    },

    async rename(ctx, newName) {
      for (const channel of state.channels) stopWatcher(runtime, channel);
      const result = renameAgent(state, base, ctx, newName, deliver, runtime);
      for (const channel of state.channels) {
        channelWatch(runtime, channel).retries = 0;
        startWatcher(state, channelDirs(base, channel), deliver, runtime, channel);
      }
      return result;
    },

    peers(): MeshPeer[] {
      const byName = new Map<string, MeshPeer>();
      for (const channel of state.channels) {
        for (const agent of getActiveAgents(state, channelDirs(base, channel), runtime)) {
          const existing = byName.get(agent.name);
          if (existing) {
            existing.channels.push(channel);
            Object.assign(existing, agent);
          } else {
            byName.set(agent.name, { ...agent, channels: [channel] });
          }
        }
      }
      return [...byName.values()];
    },

    evict(name) {
      for (const channel of state.channels) {
        const dirs = channelDirs(base, channel);
        try {
          fs.unlinkSync(join(dirs.registry, `${name}.json`));
        } catch {
          // The registration is already absent or cannot be removed.
        }
      }
      invalidateAgentsCache();
    },

    async send(to, text, opts?: SendOptions) {
      if (!isValidAgentName(to)) return { ok: false, error: "invalid_name" };

      let channel: string;
      if (opts?.channel !== undefined) {
        if (!state.channels.includes(opts.channel)) return { ok: false, error: "not_found" };
        const target = validateTargetAgent(to, channelDirs(base, opts.channel));
        if (target.valid === false) return { ok: false, error: target.error };
        channel = opts.channel;
      } else {
        const candidates: string[] = [];
        let firstError: SendError = "not_found";
        for (const joined of state.channels) {
          const target = validateTargetAgent(to, channelDirs(base, joined));
          if (target.valid === true) {
            candidates.push(joined);
          } else if (candidates.length === 0 && firstError === "not_found") {
            firstError = target.error;
          }
        }
        if (candidates.length === 0) return { ok: false, error: firstError };
        if (candidates.length > 1) return { ok: false, error: "ambiguous_channel" };
        channel = candidates[0];
      }

      try {
        const message = sendMessageToAgent(
          channelDirs(base, channel),
          to,
          text,
          opts?.from ?? state.agentName,
          opts?.replyTo ?? null,
          opts?.gentle === true,
          channel,
        );
        return { ok: true, message };
      } catch {
        return { ok: false, error: "write_failed" };
      }
    },

    recoverInbox() {
      if (!state.registered) return;
      for (const channel of state.channels) {
        const watch = channelWatch(runtime, channel);
        if (!watch.watcher && !watch.retryTimer) {
          watch.retries = 0;
          startWatcher(state, channelDirs(base, channel), deliver, runtime, channel);
        }
      }
    },

    drainInbox() {
      for (const channel of state.channels) {
        processAllPendingMessages(state, channelDirs(base, channel), deliver, runtime, channel);
      }
    },

    claims() {
      const merged: AllClaims = {};
      for (const channel of state.channels) {
        const claims = getClaims(channelDirs(base, channel));
        for (const [spec, tasks] of Object.entries(claims)) {
          merged[spec] = { ...merged[spec], ...tasks };
        }
      }
      return merged;
    },

    completions() {
      const merged: AllCompletions = {};
      for (const channel of state.channels) {
        const completions = getCompletions(channelDirs(base, channel));
        for (const [spec, tasks] of Object.entries(completions)) {
          merged[spec] = { ...merged[spec], ...tasks };
        }
      }
      return merged;
    },

    claim(ctx, spec, taskId, reason, channel) {
      return claimTask(
        joinedDirs(channel),
        spec,
        taskId,
        state.agentName,
        ctx.sessionManager.getSessionId(),
        process.pid,
        reason,
      );
    },

    unclaim(spec, taskId, channel) {
      return unclaimTask(joinedDirs(channel), spec, taskId, state.agentName);
    },

    complete(spec, taskId, notes, channel) {
      return completeTask(joinedDirs(channel), spec, taskId, state.agentName, notes);
    },

    close() {
      for (const channel of runtime.watches.keys()) {
        stopWatcher(runtime, channel);
      }
    },
  };

  return mesh;
}
