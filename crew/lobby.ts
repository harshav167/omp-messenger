/**
 * Crew - Lobby Workers
 *
 * Runs idle workers as keep-alive omp subagents. An idle worker explores the
 * project, then receives its task as a follow-up turn on the same agent id.
 */
// allow: SIZE_OK — lobby lifecycle and its single agent prompt are one cohesive runtime boundary.

import { join } from "node:path";
import type { Mesh } from "../mesh/types.ts";
import { logFeedEvent } from "../feed.ts";
import {
  allocateWorkerName,
  applySdkProgress,
  EXTENSION_ENTRY,
  modelHasThinkingSuffix,
  resolveModel,
  resolveThinking,
  toAgentResult,
} from "./agents.ts";
import { removeLiveWorker, updateLiveWorker } from "./live-progress.ts";
import {
  getAvailableLobbyWorkers as registryGetAvailableLobbyWorkers,
  getLobbyWorkerCount as registryGetLobbyWorkerCount,
  getLobbyWorkers as registryGetLobbyWorkers,
  hasActiveWorker,
  registerWorker,
  registryAlive,
  unregisterWorker,
  type LobbyWorkerEntry,
} from "./registry.ts";
import { getSdk } from "./sdk.ts";
import * as store from "./store.ts";
import {
  getTruncationForRole,
  loadCrewConfig,
  type CoordinationLevel,
  type CrewConfig,
} from "./utils/config.ts";
import { discoverCrewAgents, toAgentDefinition } from "./utils/discover.ts";
import { createProgress } from "./utils/progress.ts";

export const LOBBY_TOKEN_BUDGETS: Record<CoordinationLevel, number> = {
  none: 10_000,
  minimal: 20_000,
  moderate: 50_000,
  chatty: 100_000,
};

export type LobbyWorker = LobbyWorkerEntry;

function onLobbyRunSettled(worker: LobbyWorker, mesh: Mesh): void {
  if (worker.settled) return;

  const taskId = worker.assignedTaskId;
  if (taskId) {
    const task = store.getTask(worker.cwd, taskId);
    if (task?.status === "in_progress" && task.assigned_to === worker.name) {
      const config = loadCrewConfig(store.getCrewDir(worker.cwd));
      if (task.attempt_count >= config.work.maxAttemptsPerTask) {
        store.updateTask(worker.cwd, taskId, {
          status: "blocked",
          blocked_reason: `Max attempts (${config.work.maxAttemptsPerTask}) reached`,
          assigned_to: undefined,
        });
        logFeedEvent(worker.cwd, worker.name, "task.block", taskId, "Max attempts reached");
      } else {
        store.updateTask(worker.cwd, taskId, { status: "todo", assigned_to: undefined });
        store.appendTaskProgress(
          worker.cwd,
          taskId,
          "system",
          `Lobby worker ${worker.name} exited, reset to todo`,
        );
        logFeedEvent(worker.cwd, worker.name, "task.reset", taskId, "worker exited");
      }
    }
  }

  worker.settled = true;
  unregisterWorker(worker.cwd, worker.taskId);
  removeLiveWorker(worker.cwd, taskId ?? worker.taskId);
  mesh.evict(worker.name);
}

export function spawnLobbyWorker(
  cwd: string,
  mesh: Mesh,
  promptOverride?: string,
  sessionModel?: string,
): LobbyWorker | null {
  const agents = discoverCrewAgents(cwd);
  const workerConfig = agents.find(agent => agent.name === "crew-worker");
  if (!workerConfig) return null;

  const crewDir = store.getCrewDir(cwd);
  const config = loadCrewConfig(crewDir);
  const name = allocateWorkerName(mesh);
  const modelOverride = resolveModel(
    undefined,
    undefined,
    undefined,
    config.models?.worker,
    sessionModel,
    workerConfig.model,
  );
  const thinking = resolveThinking(config.thinking?.worker, workerConfig.thinking);
  const def = toAgentDefinition(
    workerConfig,
    modelHasThinkingSuffix(modelOverride) ? undefined : thinking,
  );
  const prompt = promptOverride ?? buildLobbyPrompt(cwd, config, name);
  const maxOutput = workerConfig.maxOutput ?? getTruncationForRole(config, "worker");
  const artifactsDir = join(crewDir, "artifacts");
  const progress = createProgress("crew-worker");
  const sdk = getSdk();
  const entry: LobbyWorkerEntry = {
    type: "lobby",
    lobbyId: name,
    name,
    cwd,
    taskId: `__lobby-${name}__`,
    abort: new AbortController(),
    run: null,
    settled: false,
    assignedTaskId: null,
    coordination: config.coordination ?? "chatty",
    startedAt: Date.now(),
  };
  registerWorker(entry);

  entry.run = sdk.runSubprocess({
    cwd,
    agent: def,
    task: prompt,
    index: 0,
    id: name,
    modelOverride,
    parentAgentId: sdk.MAIN_AGENT_ID,
    taskDepth: 1,
    artifactsDir,
    persistArtifacts: true,
    preloadedExtensionPaths: [EXTENSION_ENTRY],
    enableIrc: false,
    keepAlive: true,
    signal: entry.abort.signal,
    onProgress: sdkProgress => {
      applySdkProgress(progress, sdkProgress);
      const displayId = entry.assignedTaskId ?? entry.taskId;
      updateLiveWorker(cwd, displayId, {
        taskId: displayId,
        agent: "crew-worker",
        name,
        progress: { ...progress, recentTools: progress.recentTools.map(tool => ({ ...tool })) },
        startedAt: entry.startedAt,
      });
      const currentConfig = loadCrewConfig(crewDir);
      const budget = LOBBY_TOKEN_BUDGETS[currentConfig.coordination ?? "chatty"];
      if (!entry.assignedTaskId && progress.tokens > budget) entry.abort.abort();
    },
  }).then(result => toAgentResult("crew-worker", result, progress, {
    name,
    artifactsDir,
    maxOutput,
  })).then(result => {
    removeLiveWorker(cwd, entry.taskId);
    if (result.exitCode !== 0 && !entry.assignedTaskId) {
      entry.settled = true;
      unregisterWorker(cwd, entry.taskId);
      mesh.evict(name);
      logFeedEvent(cwd, name, "leave", undefined, "Lobby worker exited");
    }
    return result;
  });

  updateLiveWorker(cwd, entry.taskId, {
    taskId: entry.taskId,
    agent: "crew-worker",
    name,
    progress: { ...progress, recentTools: [] },
    startedAt: entry.startedAt,
  });

  return entry;
}

export function getLobbyWorkerCount(cwd: string): number {
  return registryGetLobbyWorkerCount(cwd);
}

export function getAvailableLobbyWorkers(cwd: string): LobbyWorker[] {
  return registryGetAvailableLobbyWorkers(cwd);
}

export async function assignTaskToLobbyWorker(
  worker: LobbyWorker,
  taskId: string,
  taskPrompt: string,
  mesh: Mesh,
): Promise<boolean> {
  if (worker.assignedTaskId || worker.settled || !registryAlive(worker.name)) return false;

  const workerConfig = discoverCrewAgents(worker.cwd).find(agent => agent.name === "crew-worker");
  if (!workerConfig) return false;

  const crewDir = store.getCrewDir(worker.cwd);
  const config = loadCrewConfig(crewDir);
  const model = config.models?.worker ?? workerConfig.model;
  const thinking = resolveThinking(config.thinking?.worker, workerConfig.thinking);
  const def = toAgentDefinition(
    workerConfig,
    modelHasThinkingSuffix(model) ? undefined : thinking,
  );
  const artifactsDir = join(crewDir, "artifacts");
  const maxOutput = workerConfig.maxOutput ?? getTruncationForRole(config, "worker");
  const progress = createProgress("crew-worker");
  const sdk = getSdk();
  const assignmentText = `# ⚡ TASK ASSIGNMENT — SWITCH TO WORK MODE

Drop your current activity and work on this task immediately.

**IMPORTANT:** This task is already claimed and started for you — do NOT call \`task.start\`. Follow the assignment below, including any Team role or read-only instructions, then mark complete with \`task.done\`.

${taskPrompt}`;

  worker.assignedTaskId = taskId;
  removeLiveWorker(worker.cwd, worker.taskId);
  worker.run = sdk.runSubagentFollowUpTurn({
    id: worker.name,
    agent: def,
    message: assignmentText,
    index: 0,
    artifactsDir,
    signal: worker.abort.signal,
    onProgress: sdkProgress => {
      applySdkProgress(progress, sdkProgress);
      updateLiveWorker(worker.cwd, taskId, {
        taskId,
        agent: "crew-worker",
        name: worker.name,
        progress: { ...progress, recentTools: progress.recentTools.map(tool => ({ ...tool })) },
        startedAt: worker.startedAt,
      });
    },
  }).then(result => toAgentResult("crew-worker", result, progress, {
    name: worker.name,
    artifactsDir,
    maxOutput,
    taskId,
  })).finally(() => onLobbyRunSettled(worker, mesh));
  return true;
}

export function killLobbyWorkerForTask(cwd: string, taskId: string): boolean {
  const worker = registryGetLobbyWorkers(cwd).find(candidate => candidate.assignedTaskId === taskId);
  if (!worker) return false;

  worker.abort.abort();
  unregisterWorker(cwd, worker.taskId);
  removeLiveWorker(cwd, taskId);
  return true;
}

export function shutdownLobbyWorkers(cwd: string): void {
  for (const worker of registryGetLobbyWorkers(cwd)) {
    worker.abort.abort();
    unregisterWorker(cwd, worker.taskId);
    removeLiveWorker(cwd, worker.assignedTaskId ?? worker.taskId);
  }
}

export function spawnWorkerForTask(
  cwd: string,
  taskId: string,
  taskPrompt: string,
  mesh: Mesh,
  sessionModel?: string,
): LobbyWorker | null {
  const task = store.getTask(cwd, taskId);
  if (!task || task.status !== "todo") return null;
  if (hasActiveWorker(cwd, taskId)) return null;

  const worker = spawnLobbyWorker(cwd, mesh, taskPrompt, sessionModel);
  if (!worker) return null;

  removeLiveWorker(cwd, worker.taskId);
  worker.assignedTaskId = taskId;
  store.updateTask(cwd, taskId, {
    status: "in_progress",
    started_at: new Date().toISOString(),
    base_commit: store.getBaseCommit(cwd),
    assigned_to: worker.name,
    attempt_count: task.attempt_count + 1,
  });
  store.appendTaskProgress(
    cwd,
    taskId,
    "system",
    `Assigned to worker ${worker.name} (attempt ${task.attempt_count + 1})`,
  );
  logFeedEvent(cwd, worker.name, "task.start", taskId, task.title);
  if (worker.run) worker.run = worker.run.finally(() => onLobbyRunSettled(worker, mesh));

  return worker;
}

export function removeLobbyWorkerByIndex(cwd: string): boolean {
  const worker = registryGetAvailableLobbyWorkers(cwd)[0];
  if (!worker) return false;

  worker.abort.abort();
  removeLiveWorker(cwd, worker.taskId);
  unregisterWorker(cwd, worker.taskId);
  return true;
}

function buildLobbyPrompt(cwd: string, config: CrewConfig, name: string): string {
  const plan = store.getPlan(cwd);
  const prdPath = plan?.prd;
  const level = config.coordination ?? "chatty";

  let prompt = `# Crew Lobby

You're a crew worker waiting for the team's plan to be finalized. There's no task for you yet — hang tight.

You are already joined to the mesh as \`${name}\`.

## Get Familiar

`;

  if (level === "none") {
    prompt += `Skip this step — you'll get full context when your task arrives.

`;
  } else if (prdPath) {
    prompt += `Read the PRD to understand what the team is building:

\`\`\`typescript
read("${prdPath}")
\`\`\`

`;
  }

  if (level === "chatty" || level === "moderate") {
    prompt += `Briefly explore the project structure to get oriented. Don't go deep — save your budget for the actual task.

`;
  }

  if (level === "chatty") {
    prompt += `## Share Your Findings

Post updates to the team feed while you wait — the user watches it live. Other workers will see your broadcasts when they receive their task assignment.

- **Introduce yourself** — broadcast a greeting when you join
- **Share observations** — broadcast anything interesting you notice about the PRD
- **Respond to DMs** — if someone messages you directly, reply briefly

**Hard limit: send at most 5 messages total (broadcasts + DMs combined).** After that, stop messaging and wait quietly. Save your context for the actual task.

\`\`\`typescript
omp_messenger({ action: "broadcast", message: "Hey team! Just joined. Reading the PRD now..." })
\`\`\`

After sending your messages, wait for a **TASK ASSIGNMENT** message.
`;
  } else if (level === "moderate") {
    prompt += `## Brief Check-in

Announce yourself, then wait:

\`\`\`typescript
omp_messenger({ action: "broadcast", message: "Joined the lobby. Reading the PRD..." })
\`\`\`

**Hard limit: send at most 2 messages total.** You may reply once if someone DMs you. Then stop messaging and wait.

Wait for a **TASK ASSIGNMENT** message to begin work.
`;
  } else if (level === "minimal") {
    prompt += `## Wait for Assignment

Announce your presence with one broadcast, then wait:

\`\`\`typescript
omp_messenger({ action: "broadcast", message: "Standing by for task assignment." })
\`\`\`

**Do NOT send any other messages.** Wait for a **TASK ASSIGNMENT** message to begin work.
`;
  } else {
    prompt += `## Wait

**Do NOT send any messages, do NOT explore the codebase.** Wait for a **TASK ASSIGNMENT** message.
`;
  }

  prompt += `
## When You Receive a Task Assignment

You will receive a message with the header **⚡ TASK ASSIGNMENT**. When you get it:

1. Read the task details carefully — the assignment message has specific instructions
2. Reserve files you'll modify
3. Implement the feature following the spec
4. Run tests to verify
5. Commit your changes
6. Release reservations and mark complete

The task will already be claimed and started for you — do NOT call \`task.start\`. Switch to full work mode immediately — no more lobby chat.
`;

  return prompt;
}
