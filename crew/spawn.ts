/**
 * Crew - Worker Spawning Helpers
 *
 * Shared logic for spawning workers and assigning tasks,
 * used by both the overlay and the work handler.
 */

import type { Mesh } from "../mesh/types.ts";
import * as store from "./store.ts";
import { loadCrewConfig } from "./utils/config.ts";
import { discoverCrewSkills } from "./utils/discover.ts";
import { buildWorkerPrompt } from "./prompt.ts";
import * as teamStore from "./team/store.ts";
import { logFeedEvent } from "../feed.ts";
import {
  spawnWorkerForTask,
  getAvailableLobbyWorkers,
  assignTaskToLobbyWorker,
} from "./lobby.ts";

export interface SpawnResult {
  assigned: number;
  firstWorkerName: string | null;
}

export async function spawnWorkersForReadyTasks(
  cwd: string,
  maxWorkers: number,
  mesh: Mesh,
  sessionModel?: string,
): Promise<SpawnResult> {
  const plan = store.getPlan(cwd);
  if (!plan) return { assigned: 0, firstWorkerName: null };

  const crewDir = store.getCrewDir(cwd);
  const config = loadCrewConfig(crewDir);
  const workerCap = Math.min(maxWorkers, config.concurrency.max);
  const prdLabel = store.getPlanLabel(plan);
  const skills = discoverCrewSkills(cwd);

  let assigned = 0;
  let firstWorkerName: string | null = null;

  const lobby = getAvailableLobbyWorkers(cwd);
  for (const lw of lobby) {
    if (assigned >= workerCap) break;
    const fresh = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" }).filter(t => !teamStore.taskNeedsApproval(cwd, t));
    if (fresh.length === 0) break;

    const task = fresh[0];
    const others = fresh.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, teamStore.buildTeamPromptContext(cwd, task));

    store.updateTask(cwd, task.id, {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: store.getBaseCommit(cwd),
      assigned_to: lw.name,
      attempt_count: task.attempt_count + 1,
    });

    if (!await assignTaskToLobbyWorker(lw, task.id, prompt, mesh)) {
      store.updateTask(cwd, task.id, { status: "todo", assigned_to: undefined });
      continue;
    }

    store.appendTaskProgress(cwd, task.id, "system", `Assigned to lobby worker ${lw.name} (attempt ${task.attempt_count + 1})`);
    logFeedEvent(cwd, lw.name, "task.start", task.id, task.title);
    if (!firstWorkerName) firstWorkerName = lw.name;
    assigned++;
  }

  while (assigned < workerCap) {
    const fresh = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" }).filter(t => !teamStore.taskNeedsApproval(cwd, t));
    if (fresh.length === 0) break;

    const task = fresh[0];
    const others = fresh.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, teamStore.buildTeamPromptContext(cwd, task));
    const worker = spawnWorkerForTask(cwd, task.id, prompt, mesh, sessionModel);
    if (!worker) break;

    if (!firstWorkerName) firstWorkerName = worker.name;
    assigned++;
  }

  return { assigned, firstWorkerName };
}

export function spawnSingleWorker(
  cwd: string,
  taskId: string,
  mesh: Mesh,
  sessionModel?: string,
): { name: string } | null {
  const plan = store.getPlan(cwd);
  if (!plan) return null;

  const task = store.getTask(cwd, taskId);
  if (!task) return null;

  const crewDir = store.getCrewDir(cwd);
  const config = loadCrewConfig(crewDir);
  const prdLabel = store.getPlanLabel(plan);
  const skills = discoverCrewSkills(cwd);
  if (teamStore.taskNeedsApproval(cwd, task)) return null;
  const readyTasks = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" }).filter(t => !teamStore.taskNeedsApproval(cwd, t));
  const others = readyTasks.filter(t => t.id !== task.id);
  const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, teamStore.buildTeamPromptContext(cwd, task));
  const worker = spawnWorkerForTask(cwd, taskId, prompt, mesh, sessionModel);
  return worker ? { name: worker.name } : null;
}
