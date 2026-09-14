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
} from "../lib.ts";
import { buildRegistration, normalizeCwd } from "./registration.ts";
import type {
  ClaimResult,
  CompleteResult,
  DeliverFn,
  Mesh,
  RenameResult,
  SendOptions,
  UnclaimResult,
} from "./types.ts";

interface AgentsCache {
  allAgents: AgentRegistration[];
  filtered: Map<string, AgentRegistration[]>;
  timestamp: number;
  registryPath: string;
}

interface PendingProcessArgs {
  state: MessengerState;
  dirs: Dirs;
  deliver: DeliverFn;
}

interface FsRuntime {
  agentsCache: AgentsCache | null;
  cacheGeneration: number;
  isProcessingMessages: boolean;
  pendingProcessArgs: PendingProcessArgs | null;
}

const AGENTS_CACHE_TTL_MS = 1000;
let agentsCacheGeneration = 0;

export function invalidateAgentsCache(): void {
  agentsCacheGeneration++;
}

function refreshCacheGeneration(runtime: FsRuntime): void {
  if (runtime.cacheGeneration === agentsCacheGeneration) return;
  runtime.agentsCache = null;
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
        await new Promise(resolve => setTimeout(resolve, retryDelay));
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

function getActiveAgents(state: MessengerState, dirs: Dirs, runtime: FsRuntime): AgentRegistration[] {
  refreshCacheGeneration(runtime);
  const now = Date.now();
  const excludeName = state.agentName;
  const myCwd = normalizeCwd(state.cwd);
  const scopeToFolder = state.scopeToFolder;
  const cacheKey = scopeToFolder ? `${excludeName}:${myCwd}` : excludeName;
  const cached = runtime.agentsCache;

  if (
    cached &&
    cached.registryPath === dirs.registry &&
    now - cached.timestamp < AGENTS_CACHE_TTL_MS
  ) {
    const cachedFiltered = cached.filtered.get(cacheKey);
    if (cachedFiltered) return cachedFiltered;

    let filtered = cached.allAgents.filter(agent => agent.name !== excludeName);
    if (scopeToFolder) {
      filtered = filtered.filter(agent => agent.hostId === LOCAL_HOST_ID && agent.cwd === myCwd);
    }
    cached.filtered.set(cacheKey, filtered);
    return filtered;
  }

  const allAgents: AgentRegistration[] = [];
  if (!fs.existsSync(dirs.registry)) {
    runtime.agentsCache = { allAgents, filtered: new Map(), timestamp: now, registryPath: dirs.registry };
    return allAgents;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dirs.registry);
  } catch {
    return allAgents;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const content = fs.readFileSync(join(dirs.registry, file), "utf-8");
      const reg: AgentRegistration = JSON.parse(content);

      if (!isProcessAlive(reg.pid)) {
        try {
          fs.unlinkSync(join(dirs.registry, file));
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

  let filtered = allAgents.filter(agent => agent.name !== excludeName);
  if (scopeToFolder) {
    filtered = filtered.filter(agent => agent.hostId === LOCAL_HOST_ID && agent.cwd === myCwd);
  }
  const filteredMap = new Map<string, AgentRegistration[]>();
  filteredMap.set(cacheKey, filtered);
  runtime.agentsCache = { allAgents, filtered: filteredMap, timestamp: now, registryPath: dirs.registry };

  return filtered;
}

function findAvailableName(baseName: string, dirs: Dirs): string | null {
  const basePath = join(dirs.registry, `${baseName}.json`);
  if (!fs.existsSync(basePath)) return baseName;

  try {
    const existing: AgentRegistration = JSON.parse(fs.readFileSync(basePath, "utf-8"));
    if (!isProcessAlive(existing.pid) || existing.pid === process.pid) {
      return baseName;
    }
  } catch {
    return baseName;
  }

  for (let i = 2; i <= 99; i++) {
    const altName = `${baseName}${i}`;
    const altPath = join(dirs.registry, `${altName}.json`);

    if (!fs.existsSync(altPath)) return altName;

    try {
      const altReg: AgentRegistration = JSON.parse(fs.readFileSync(altPath, "utf-8"));
      if (!isProcessAlive(altReg.pid)) return altName;
    } catch {
      return altName;
    }
  }

  return null;
}

function register(state: MessengerState, dirs: Dirs, ctx: ExtensionContext, nameTheme?: NameThemeConfig): boolean {
  if (state.registered) return true;

  ensureDirSync(dirs.registry);

  if (!state.agentName) {
    state.agentName = generateMemorableName(nameTheme);
  }

  const isExplicitName = state.explicitName;
  const maxAttempts = isExplicitName ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Validate and find available name
    if (isExplicitName) {
      if (!isValidAgentName(state.agentName)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`, "error");
        }
        return false;
      }
      const regPath = join(dirs.registry, `${state.agentName}.json`);
      if (fs.existsSync(regPath)) {
        try {
          const existing: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
          if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
            if (ctx.hasUI) {
              ctx.ui.notify(`Agent name "${state.agentName}" already in use (PID ${existing.pid})`, "error");
            }
            return false;
          }
        } catch {
          // Malformed, proceed to overwrite
        }
      }
    } else {
      const availableName = findAvailableName(state.agentName, dirs);
      if (!availableName) {
        if (ctx.hasUI) {
          ctx.ui.notify("Could not find available agent name after 99 attempts", "error");
        }
        return false;
      }
      state.agentName = availableName;
    }

    const regPath = getRegistrationPath(state, dirs);
    if (fs.existsSync(regPath)) {
      try {
        fs.unlinkSync(regPath);
      } catch {
        // Ignore
      }
    }

    ensureDirSync(getMyInbox(state, dirs));

    const registration = buildRegistration(state, ctx, state.agentName);

    try {
      fs.writeFileSync(regPath, JSON.stringify(registration, null, 2));
    } catch (err) {
      if (ctx.hasUI) {
        const msg = err instanceof Error ? err.message : "unknown error";
        ctx.ui.notify(`Failed to register: ${msg}`, "error");
      }
      return false;
    }

    let verified = false;
    let verifyError = false;
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      verified = written.pid === process.pid;
    } catch {
      verifyError = true;
    }

    if (verified) {
      state.registered = true;
      state.model = registration.model;
      state.cwd = registration.cwd;
      state.gitBranch = registration.gitBranch;
      state.activity.lastActivityAt = registration.startedAt;
      invalidateAgentsCache();
      return true;
    }

    // Verification failed - clean up our write attempt if file still contains our data
    // (handles I/O error case where we wrote successfully but couldn't read back)
    if (verifyError) {
      try {
        const checkContent = fs.readFileSync(regPath, "utf-8");
        const checkReg: AgentRegistration = JSON.parse(checkContent);
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(regPath);
        }
      } catch {
        // Best effort cleanup
      }
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


function unregister(state: MessengerState, dirs: Dirs): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  try {
    fs.unlinkSync(regPath);
  } catch (error) {
    if (fs.existsSync(regPath)) {
      throw error;
    }
  }

  state.registered = false;
  invalidateAgentsCache();
}


function renameAgent(
  state: MessengerState,
  dirs: Dirs,
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

  const newRegPath = join(dirs.registry, `${newName}.json`);
  if (fs.existsSync(newRegPath)) {
    try {
      const existing: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
      if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        return { success: false, error: "name_taken" };
      }
    } catch {
      // Malformed file, we can overwrite
    }
  }

  const oldName = state.agentName;
  const oldRegPath = getRegistrationPath(state, dirs);
  const oldInbox = getMyInbox(state, dirs);
  const newInbox = join(dirs.inbox, newName);

  processAllPendingMessages(state, dirs, deliver, runtime);

  const registration = buildRegistration(state, ctx, newName);

  ensureDirSync(dirs.registry);
  
  try {
    fs.writeFileSync(join(dirs.registry, `${newName}.json`), JSON.stringify(registration, null, 2));
  } catch {
    return { success: false, error: "invalid_name" };
  }

  // Verify we own the new registration (guards against race condition)
  let verified = false;
  let verifyError = false;
  try {
    const written: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
    verified = written.pid === process.pid;
  } catch {
    verifyError = true;
  }

  if (!verified) {
    // Clean up our write attempt if file still contains our data (I/O error case)
    if (verifyError) {
      try {
        const checkReg: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(newRegPath);
        }
      } catch {
        // Best effort cleanup
      }
    }
    return { success: false, error: "race_lost" };
  }

  try {
    fs.unlinkSync(oldRegPath);
  } catch {
    // Ignore - old file might already be gone
  }

  state.agentName = newName;

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
    fs.rmdirSync(oldInbox);
  } catch {
    // Ignore - might have new messages or not exist
  }

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
): void {
  if (!state.registered) return;

  if (runtime.isProcessingMessages) {
    runtime.pendingProcessArgs = { state, dirs, deliver };
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

    if (runtime.pendingProcessArgs) {
      const args = runtime.pendingProcessArgs;
      runtime.pendingProcessArgs = null;
      processAllPendingMessages(args.state, args.dirs, args.deliver, runtime);
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

function startWatcher(
  state: MessengerState,
  dirs: Dirs,
  deliver: DeliverFn,
  runtime: FsRuntime,
): void {
  if (!state.registered) return;
  if (state.watcher) return;
  if (state.watcherRetries >= MAX_WATCHER_RETRIES) return;

  const inbox = getMyInbox(state, dirs);
  ensureDirSync(inbox);

  processAllPendingMessages(state, dirs, deliver, runtime);

  function scheduleRetry(): void {
    state.watcherRetries++;
    if (state.watcherRetries < MAX_WATCHER_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, state.watcherRetries - 1), 30000);
      state.watcherRetryTimer = setTimeout(() => {
        state.watcherRetryTimer = null;
        startWatcher(state, dirs, deliver, runtime);
      }, delay);
    }
  }

  try {
    state.watcher = fs.watch(inbox, () => {
      // Fix 2: Debounce rapid events
      if (state.watcherDebounceTimer) {
        clearTimeout(state.watcherDebounceTimer);
      }
      state.watcherDebounceTimer = setTimeout(() => {
        state.watcherDebounceTimer = null;
        processAllPendingMessages(state, dirs, deliver, runtime);
      }, WATCHER_DEBOUNCE_MS);
    });
  } catch {
    scheduleRetry();
    return;
  }

  state.watcher.on("error", () => {
    stopWatcher(state);
    scheduleRetry();
  });

  state.watcherRetries = 0;
}

function stopWatcher(state: MessengerState): void {
  if (state.watcherDebounceTimer) {
    clearTimeout(state.watcherDebounceTimer);
    state.watcherDebounceTimer = null;
  }
  if (state.watcherRetryTimer) {
    clearTimeout(state.watcherRetryTimer);
    state.watcherRetryTimer = null;
  }
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
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
    agentsCache: null,
    cacheGeneration: agentsCacheGeneration,
    isProcessingMessages: false,
    pendingProcessArgs: null,
  };

  return {
    kind: "fs",
    status: () => "local",
    channel: () => state.channel,
    async join(ctx, opts) {
      if (opts?.channel) state.channel = opts.channel;
      const dirs = channelDirs(base, state.channel);
      const joined = register(state, dirs, ctx, opts?.nameTheme);
      if (joined) startWatcher(state, dirs, deliver, runtime);
      return joined;
    },
    async channels() {
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
      const dirs = channelDirs(base, state.channel);
      updateRegistration(state, dirs, ctx);
    },
    async leave() {
      const dirs = channelDirs(base, state.channel);
      unregister(state, dirs);
    },
    async rename(ctx, newName) {
      const dirs = channelDirs(base, state.channel);
      stopWatcher(state);
      const result = renameAgent(state, dirs, ctx, newName, deliver, runtime);
      state.watcherRetries = 0;
      startWatcher(state, dirs, deliver, runtime);
      return result;
    },
    peers() {
      const dirs = channelDirs(base, state.channel);
      return getActiveAgents(state, dirs, runtime);
    },
    evict(name) {
      const dirs = channelDirs(base, state.channel);
      try {
        fs.unlinkSync(join(dirs.registry, `${name}.json`));
      } catch {
        // The registration is already absent or cannot be removed.
      }
      invalidateAgentsCache();
    },
    async send(to, text, opts?: SendOptions) {
      const dirs = channelDirs(base, state.channel);
      const target = validateTargetAgent(to, dirs);
      if (target.valid === false) return { ok: false, error: target.error };

      try {
        const message = sendMessageToAgent(
          dirs,
          to,
          text,
          opts?.from ?? state.agentName,
          opts?.replyTo ?? null,
          opts?.gentle === true,
        );
        return { ok: true, message };
      } catch {
        return { ok: false, error: "write_failed" };
      }
    },
    recoverInbox() {
      const dirs = channelDirs(base, state.channel);
      if (state.registered && !state.watcher && !state.watcherRetryTimer) {
        state.watcherRetries = 0;
        startWatcher(state, dirs, deliver, runtime);
      }
    },
    drainInbox() {
      const dirs = channelDirs(base, state.channel);
      processAllPendingMessages(state, dirs, deliver, runtime);
    },
    claims() {
      const dirs = channelDirs(base, state.channel);
      return getClaims(dirs);
    },
    completions() {
      const dirs = channelDirs(base, state.channel);
      return getCompletions(dirs);
    },
    claim(ctx, spec, taskId, reason) {
      const dirs = channelDirs(base, state.channel);
      return claimTask(
        dirs,
        spec,
        taskId,
        state.agentName,
        ctx.sessionManager.getSessionId(),
        process.pid,
        reason,
      );
    },
    unclaim(spec, taskId) {
      const dirs = channelDirs(base, state.channel);
      return unclaimTask(dirs, spec, taskId, state.agentName);
    },
    complete(spec, taskId, notes) {
      const dirs = channelDirs(base, state.channel);
      return completeTask(dirs, spec, taskId, state.agentName, notes);
    },
    close() {
      stopWatcher(state);
    },
  };
}
