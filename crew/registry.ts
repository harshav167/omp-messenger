/**
 * Crew - Unified Worker Registry
 *
 * Single registry for both regular workers and lobby workers. Workers are
 * in-process omp subagent runs; an entry owns the AbortController that ends
 * the run and the promise of its result.
 */

import type { CoordinationLevel } from "./utils/config.ts";
import type { AgentResult } from "./types.ts";
import { getSdk } from "./sdk.ts";

interface BaseWorkerEntry {
  name: string;
  cwd: string;
  taskId: string;
  abort: AbortController;
  run: Promise<AgentResult> | null;
  settled: boolean;
}

export interface RegularWorker extends BaseWorkerEntry {
  type: "worker";
}

export interface LobbyWorkerEntry extends BaseWorkerEntry {
  type: "lobby";
  lobbyId: string;
  assignedTaskId: string | null;
  coordination: CoordinationLevel;
  startedAt: number;
}

export type WorkerEntry = RegularWorker | LobbyWorkerEntry;

const workers = new Map<string, WorkerEntry>();

function makeKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
}

/** A subagent id still known to omp's registry and not hard-aborted. */
export function registryAlive(name: string): boolean {
  const ref = getSdk().AgentRegistry.global().get(name);
  return ref !== undefined && ref.status !== "aborted";
}

export function registerWorker(entry: WorkerEntry): void {
  workers.set(makeKey(entry.cwd, entry.taskId), entry);
}

export function unregisterWorker(cwd: string, taskId: string): void {
  workers.delete(makeKey(cwd, taskId));
}

export function findWorkerByTask(cwd: string, taskId: string): WorkerEntry | null {
  const direct = workers.get(makeKey(cwd, taskId));
  if (direct) return direct;
  for (const entry of workers.values()) {
    if (entry.cwd !== cwd) continue;
    if (entry.type === "lobby" && entry.assignedTaskId === taskId) return entry;
  }
  return null;
}

export function hasActiveWorker(cwd: string, taskId: string): boolean {
  const entry = findWorkerByTask(cwd, taskId);
  return entry !== null && !entry.settled;
}

/** Abort the run for `taskId`; true when it was still unsettled. */
export function killWorkerByTask(cwd: string, taskId: string): boolean {
  const entry = findWorkerByTask(cwd, taskId);
  if (!entry || entry.settled) return false;
  entry.abort.abort();
  return true;
}

export function killAll(cwd?: string): void {
  for (const [key, entry] of workers.entries()) {
    if (cwd && entry.cwd !== cwd) continue;
    if (!entry.settled) entry.abort.abort();
    workers.delete(key);
  }
}

export function getLobbyWorkers(cwd: string): LobbyWorkerEntry[] {
  const result: LobbyWorkerEntry[] = [];
  for (const entry of workers.values()) {
    if (entry.cwd === cwd && entry.type === "lobby") result.push(entry);
  }
  return result;
}

export function getAvailableLobbyWorkers(cwd: string): LobbyWorkerEntry[] {
  const result: LobbyWorkerEntry[] = [];
  for (const entry of workers.values()) {
    if (entry.cwd !== cwd || entry.type !== "lobby") continue;
    if (entry.assignedTaskId || entry.settled) continue;
    if (!registryAlive(entry.name)) continue;
    result.push(entry);
  }
  return result;
}

export function getLobbyWorkerCount(cwd: string): number {
  return getAvailableLobbyWorkers(cwd).length;
}
