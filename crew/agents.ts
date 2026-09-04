/**
 * Crew - Agent Spawning
 *
 * Runs crew roles as in-process omp subagents with progress and artifacts.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentProgress as SdkProgress,
  SingleResult as SdkSingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { generateMemorableName } from "../lib.ts";
import type { Mesh } from "../mesh/types.ts";
import { removeLiveWorker, updateLiveWorker } from "./live-progress.ts";
import { type RegularWorker, killAll, registerWorker, unregisterWorker } from "./registry.ts";
import { getSdk } from "./sdk.ts";
import { autonomousState, waitForConcurrencyChange } from "./state.ts";
import type { AgentResult, AgentTask } from "./types.ts";
import { ensureArtifactsDir, writeMetadata } from "./utils/artifacts.ts";
import { loadCrewConfig, getTruncationForRole, type CrewConfig } from "./utils/config.ts";
import {
  discoverCrewAgents,
  toAgentDefinition,
  type CrewAgentConfig,
} from "./utils/discover.ts";
import { createProgress, type AgentProgress } from "./utils/progress.ts";
import { truncateOutput, type MaxOutputConfig } from "./utils/truncate.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "..");
export const EXTENSION_ENTRY = path.join(EXTENSION_DIR, "index.ts");

const THINKING_LEVELS: Readonly<Record<string, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
};

const SHUTDOWN_MESSAGE = `⚠️ SHUTDOWN REQUESTED: Please wrap up your current work.
1. Release any file reservations
2. If the task is not complete, leave it as in_progress (do NOT mark done)
3. Do NOT commit anything
4. Exit`;

export interface SpawnOptions {
  onProgress?: (results: AgentResult[]) => void;
  crewDir?: string;
  signal?: AbortSignal;
  mesh?: Mesh;
  localProtocolOptions?: unknown;
}

export function shutdownAllWorkers(): void {
  killAll();
}

export function resolveModel(
  taskModel?: string,
  paramModel?: string,
  roleModel?: string,
  configModel?: string,
  sessionModel?: string,
  agentModel?: string,
): string | undefined {
  return taskModel ?? paramModel ?? roleModel ?? configModel ?? sessionModel ?? agentModel;
}

export function resolveThinking(configThinking?: string, agentThinking?: string): string | undefined {
  const resolved = configThinking ?? agentThinking;
  return !resolved || resolved === "off" ? undefined : resolved;
}

export function modelHasThinkingSuffix(model: string | undefined): boolean {
  if (!model) return false;
  const separator = model.lastIndexOf(":");
  return separator !== -1 && THINKING_LEVELS[model.slice(separator + 1)] === true;
}

export function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  const race = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => race.resolve(false), ms);
  promise.then(
    () => {
      clearTimeout(timer);
      race.resolve(true);
    },
    () => {
      clearTimeout(timer);
      race.resolve(false);
    },
  );
  return race.promise;
}

export function allocateWorkerName(mesh?: Mesh): string {
  const peerNames = new Set(mesh?.peers().map(peer => peer.name) ?? []);
  let candidate = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    candidate = generateMemorableName();
    if (!peerNames.has(candidate) && getSdk().AgentRegistry.global().get(candidate) === undefined) {
      return candidate;
    }
  }
  return `${candidate}-${randomUUID().replaceAll("-", "").slice(0, 4)}`;
}

export function applySdkProgress(target: AgentProgress, progress: SdkProgress): void {
  target.status = progress.status === "aborted" ? "failed" : progress.status;
  target.currentTool = progress.currentTool;
  target.currentToolArgs = progress.currentToolArgs;
  target.currentToolStartMs = progress.currentToolStartMs;
  target.recentTools = progress.recentTools.map(tool => ({
    tool: tool.tool,
    args: tool.args,
    startMs: tool.endMs,
    endMs: tool.endMs,
  }));
  target.toolCallCount = progress.toolCount;
  target.tokens = progress.tokens;
  target.durationMs = progress.durationMs;
  target.error = progress.retryFailure?.errorMessage;
}

export function toAgentResult(
  agentName: string,
  result: SdkSingleResult,
  progress: AgentProgress,
  context: {
    name: string;
    artifactsDir: string;
    maxOutput: MaxOutputConfig;
    taskId?: string;
    config?: CrewAgentConfig;
    wasGracefullyShutdown?: boolean;
  },
): AgentResult {
  const truncation = truncateOutput(result.output, context.maxOutput);
  return {
    agent: agentName,
    exitCode: result.aborted ? 143 : result.exitCode,
    output: truncation.text,
    truncated: result.truncated || truncation.truncated,
    progress,
    config: context.config,
    taskId: context.taskId,
    wasGracefullyShutdown: context.wasGracefullyShutdown,
    error: result.error ?? result.retryFailure?.errorMessage,
    artifactPaths: {
      output: result.outputPath,
      transcript: path.join(context.artifactsDir, `${context.name}.jsonl`),
      meta: path.join(context.artifactsDir, `${context.name}_meta.json`),
    },
  };
}

export async function spawnAgents(
  tasks: AgentTask[],
  cwd: string,
  options: SpawnOptions = {},
): Promise<AgentResult[]> {
  const crewDir = options.crewDir ?? path.join(cwd, ".omp", "messenger", "crew");
  const config = loadCrewConfig(crewDir);
  const agents = discoverCrewAgents(cwd);
  const runId = randomUUID().slice(0, 8);
  const artifactsDir = path.join(crewDir, "artifacts");
  ensureArtifactsDir(artifactsDir, config.artifacts.enabled ? config.artifacts.cleanupDays : undefined);

  const results: AgentResult[] = [];
  const queue = tasks.map((task, index) => ({ task, index }));
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    if (options.signal?.aborted && running.length === 0) break;
    while (running.length < autonomousState.concurrency && queue.length > 0) {
      if (options.signal?.aborted) break;
      const queued = queue.shift();
      if (!queued) break;
      const promise = runAgent(queued.task, queued.index, cwd, agents, config, runId, artifactsDir, options)
        .then(result => {
          results.push(result);
          options.onProgress?.(results);
        })
        .finally(() => {
          const runningIndex = running.indexOf(promise);
          if (runningIndex !== -1) running.splice(runningIndex, 1);
        });
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race([...running, waitForConcurrencyChange()]);
    }
  }

  return results;
}

async function runAgent(
  task: AgentTask,
  index: number,
  cwd: string,
  agents: CrewAgentConfig[],
  config: CrewConfig,
  runId: string,
  artifactsDir: string,
  options: SpawnOptions,
): Promise<AgentResult> {
  const agentConfig = agents.find(agent => agent.name === task.agent);
  const progress = createProgress(task.agent);
  const startTime = Date.now();
  if (!agentConfig) {
    progress.status = "failed";
    progress.error = `Agent definition not found: ${task.agent}`;
    return {
      agent: task.agent,
      exitCode: 1,
      output: "",
      truncated: false,
      progress,
      taskId: task.taskId,
      error: progress.error,
    };
  }

  const role = agentConfig.crewRole ?? "worker";
  const maxOutput = task.maxOutput ?? agentConfig.maxOutput ?? getTruncationForRole(config, role);
  const modelOverride = task.modelOverride ?? config.models?.[role];
  const resolvedModel = modelOverride ?? agentConfig.model;
  const resolvedThinking = resolveThinking(config.thinking?.[role], agentConfig.thinking);
  const definition = toAgentDefinition(
    agentConfig,
    modelHasThinkingSuffix(resolvedModel) ? undefined : resolvedThinking,
  );
  const name = role === "worker" ? allocateWorkerName(options.mesh) : `${task.agent}-${runId}-${index}`;
  const abort = new AbortController();
  let gracefulShutdownRequested = false;
  const worker: RegularWorker | undefined = task.taskId
    ? { type: "worker", name, cwd, taskId: task.taskId, abort, run: null, settled: false }
    : undefined;
  if (worker) registerWorker(worker);

  const sdk = getSdk();
  const runPromise = sdk.runSubprocess({
    cwd,
    agent: definition,
    task: task.task,
    index,
    id: name,
    modelOverride,
    parentAgentId: sdk.MAIN_AGENT_ID,
    taskDepth: 1,
    artifactsDir,
    persistArtifacts: true,
    preloadedExtensionPaths: [EXTENSION_ENTRY],
    enableIrc: false,
    keepAlive: false,
    signal: abort.signal,
    localProtocolOptions: options.localProtocolOptions as never,
    onProgress: sdkProgress => {
      applySdkProgress(progress, sdkProgress);
      if (task.taskId) {
        updateLiveWorker(cwd, task.taskId, {
          taskId: task.taskId,
          agent: task.agent,
          name,
          progress: {
            ...progress,
            recentTools: progress.recentTools.map(tool => ({ ...tool })),
          },
          startedAt: startTime,
        });
      }
      if (sdkProgress.retryFailure) abort.abort();
    },
  });

  const gracefulShutdown = async (): Promise<void> => {
    gracefulShutdownRequested = true;
    if (options.mesh && role === "worker") {
      const sent = await options.mesh.send(name, SHUTDOWN_MESSAGE, {
        from: "crew-orchestrator",
        urgent: true,
      });
      if (sent.ok && await raceTimeout(
        runPromise.then(() => {}),
        config.work.shutdownGracePeriodMs ?? 30_000,
      )) return;
    }
    abort.abort();
  };
  const requestGracefulShutdown = (): void => {
    void gracefulShutdown().catch(() => abort.abort());
  };
  if (options.signal?.aborted) requestGracefulShutdown();
  else options.signal?.addEventListener("abort", requestGracefulShutdown, { once: true });

  const resultPromise = runPromise.then(result => {
    progress.status = result.aborted || result.exitCode !== 0 ? "failed" : "completed";
    progress.durationMs = result.durationMs;
    progress.error = result.error ?? result.retryFailure?.errorMessage ?? progress.error;
    const mapped = toAgentResult(task.agent, result, progress, {
      name,
      artifactsDir,
      maxOutput,
      taskId: task.taskId,
      config: agentConfig,
      wasGracefullyShutdown: gracefulShutdownRequested,
    });
    writeMetadata(path.join(artifactsDir, `${name}_meta.json`), {
      runId,
      agent: task.agent,
      name,
      index,
      exitCode: mapped.exitCode,
      durationMs: mapped.progress.durationMs,
      tokens: mapped.progress.tokens,
      truncated: mapped.truncated,
      error: mapped.error,
    });
    return mapped;
  }).finally(() => {
    options.signal?.removeEventListener("abort", requestGracefulShutdown);
    if (worker) worker.settled = true;
    if (role === "worker") options.mesh?.evict(name);
    if (task.taskId) {
      unregisterWorker(cwd, task.taskId);
      removeLiveWorker(cwd, task.taskId);
    }
  });
  if (worker) worker.run = resultPromise;
  return resultPromise;
}
