import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Mesh } from "../../mesh/types.ts";
import { createTestMesh } from "../helpers/mesh.ts";
import { createFakeSdk } from "../helpers/sdk.ts";
import * as lobby from "../../crew/lobby.ts";
import * as registry from "../../crew/registry.ts";
import { setSdk } from "../../crew/sdk.ts";
import * as store from "../../crew/store.ts";
import { loadCrewConfig } from "../../crew/utils/config.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

describe("lobby workers", () => {
  let dirs: TempCrewDirs;
  let mesh: Mesh;
  let fake = createFakeSdk();
  beforeEach(() => {
    registry.killAll();
    dirs = createTempCrewDirs();
    mesh = createTestMesh(dirs.cwd).mesh;
    fake = createFakeSdk();
    setSdk(fake.sdk);
  });

  it("registers a named keep-alive subagent", () => {
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);

    expect(worker).not.toBeNull();
    expect(worker?.lobbyId).toBe(worker?.name);
    expect(worker?.taskId).toBe(`__lobby-${worker?.name}__`);
    expect(worker?.assignedTaskId).toBeNull();
    expect(fake.runSubprocess).toHaveBeenCalledWith(expect.objectContaining({
      id: worker?.name,
      keepAlive: true,
      enableIrc: false,
      parentAgentId: "Main",
    }));
  });

  it("counts only available workers for the requested cwd", () => {
    lobby.spawnLobbyWorker(dirs.cwd, mesh);
    lobby.spawnLobbyWorker(dirs.cwd, mesh);

    expect(lobby.getLobbyWorkerCount(dirs.cwd)).toBe(2);
    expect(lobby.getLobbyWorkerCount("/other/cwd")).toBe(0);
  });

  it("excludes assigned workers from availability", () => {
    const first = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    lobby.spawnLobbyWorker(dirs.cwd, mesh);
    if (!first) throw new Error("expected lobby worker");

    first.assignedTaskId = "task-1";

    expect(lobby.getAvailableLobbyWorkers(dirs.cwd)).toHaveLength(1);
  });

  it("assigns work through a follow-up turn on the same agent id", async () => {
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    if (!worker) throw new Error("expected lobby worker");
    await worker.run;

    const assigned = await lobby.assignTaskToLobbyWorker(worker, "task-3", "# Task 3", mesh);

    expect(assigned).toBe(true);
    expect(fake.runSubagentFollowUpTurn).toHaveBeenCalledWith(expect.objectContaining({
      id: worker.name,
      message: expect.stringMatching(/^# ⚡ TASK ASSIGNMENT/),
    }));
    expect(readdirSync(join(dirs.cwd, ".pi", "messenger", "inbox"))).toEqual([]);
  });

  it("rejects an already assigned worker", async () => {
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    if (!worker) throw new Error("expected lobby worker");
    worker.assignedTaskId = "task-1";

    const assigned = await lobby.assignTaskToLobbyWorker(worker, "task-2", "prompt", mesh);

    expect(assigned).toBe(false);
    expect(fake.runSubagentFollowUpTurn).not.toHaveBeenCalled();
  });

  it("resets an orphaned in-progress task after its follow-up settles", async () => {
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Test", "Do work");
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    if (!worker) throw new Error("expected lobby worker");
    await worker.run;
    store.updateTask(dirs.cwd, task.id, {
      status: "in_progress",
      assigned_to: worker.name,
      attempt_count: 1,
    });

    await lobby.assignTaskToLobbyWorker(worker, task.id, "task prompt", mesh);
    await worker.run;

    expect(store.getTask(dirs.cwd, task.id)?.status).toBe("todo");
    expect(store.getTask(dirs.cwd, task.id)?.assigned_to).toBeUndefined();
  });

  it("blocks an orphaned task at the maximum attempt count", async () => {
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const maxAttempts = loadCrewConfig(dirs.crewDir).work.maxAttemptsPerTask;
    const task = store.createTask(dirs.cwd, "Flaky", "Do work");
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    if (!worker) throw new Error("expected lobby worker");
    await worker.run;
    store.updateTask(dirs.cwd, task.id, {
      status: "in_progress",
      assigned_to: worker.name,
      attempt_count: maxAttempts,
    });

    await lobby.assignTaskToLobbyWorker(worker, task.id, "task prompt", mesh);
    await worker.run;

    expect(store.getTask(dirs.cwd, task.id)?.status).toBe("blocked");
    expect(store.getTask(dirs.cwd, task.id)?.blocked_reason).toContain("Max attempts");
  });

  it("does not reset work completed before the follow-up settles", async () => {
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Done", "Do work");
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    if (!worker) throw new Error("expected lobby worker");
    await worker.run;
    store.updateTask(dirs.cwd, task.id, {
      status: "done",
      assigned_to: worker.name,
      attempt_count: 1,
    });

    await lobby.assignTaskToLobbyWorker(worker, task.id, "task prompt", mesh);
    await worker.run;

    expect(store.getTask(dirs.cwd, task.id)?.status).toBe("done");
  });

  it("spawns a task worker and records its assignment", () => {
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Build something", "Do work");

    const worker = lobby.spawnWorkerForTask(dirs.cwd, task.id, "task prompt", mesh);

    expect(worker?.assignedTaskId).toBe(task.id);
    expect(store.getTask(dirs.cwd, task.id)).toEqual(expect.objectContaining({
      status: "in_progress",
      assigned_to: worker?.name,
      attempt_count: 1,
    }));
  });

  it("refuses a task that already has an active worker", () => {
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Active", "Do work");
    registry.registerWorker({
      type: "worker",
      name: "ExistingWorker",
      cwd: dirs.cwd,
      taskId: task.id,
      abort: new AbortController(),
      run: null,
      settled: false,
    });

    const worker = lobby.spawnWorkerForTask(dirs.cwd, task.id, "task prompt", mesh);

    expect(worker).toBeNull();
    expect(fake.runSubprocess).not.toHaveBeenCalled();
  });

  it("removes one idle worker by aborting its subagent run", () => {
    lobby.spawnLobbyWorker(dirs.cwd, mesh);
    lobby.spawnLobbyWorker(dirs.cwd, mesh);
    const firstOptions = fake.runSubprocess.mock.calls[0]?.[0];

    expect(lobby.removeLobbyWorkerByIndex(dirs.cwd)).toBe(true);
    expect(firstOptions?.signal?.aborted).toBe(true);
    expect(lobby.getLobbyWorkerCount(dirs.cwd)).toBe(1);
  });

  it("kills the lobby worker assigned to a task", () => {
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    if (!worker) throw new Error("expected lobby worker");
    worker.assignedTaskId = "task-9";

    const killed = lobby.killLobbyWorkerForTask(dirs.cwd, "task-9");

    expect(killed).toBe(true);
    expect(worker.abort.signal.aborted).toBe(true);
    expect(lobby.getLobbyWorkerCount(dirs.cwd)).toBe(0);
  });

  it("shuts down only lobby workers in the requested cwd", () => {
    const local = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    const otherDirs = createTempCrewDirs();
    const otherMesh = createTestMesh(otherDirs.cwd).mesh;
    lobby.spawnLobbyWorker(otherDirs.cwd, otherMesh);

    lobby.shutdownLobbyWorkers(dirs.cwd);

    expect(local?.abort.signal.aborted).toBe(true);
    expect(lobby.getLobbyWorkerCount(dirs.cwd)).toBe(0);
    expect(lobby.getLobbyWorkerCount(otherDirs.cwd)).toBe(1);
  });

  it("does not ask an already joined lobby worker to join again", () => {
    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    const options = fake.runSubprocess.mock.calls[0]?.[0];

    expect(options?.id).toBe(worker?.name);
    expect(options?.task).not.toContain('pi_messenger({ action: "join" })');
  });

  it("aborts exploration after the coordination token budget", async () => {
    fake.runSubprocess.mockImplementationOnce(async options => {
      fake.registry.set(options.id, { status: "running" });
      options.onProgress?.({
        index: options.index,
        id: options.id,
        agent: options.agent.name,
        agentSource: "user",
        status: "running",
        task: options.task,
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        requests: 1,
        tokens: lobby.LOBBY_TOKEN_BUDGETS.chatty + 1,
        cost: 0,
        durationMs: 1,
      });
      fake.registry.set(options.id, { status: "idle" });
      return {
        index: options.index,
        id: options.id,
        agent: options.agent.name,
        agentSource: "user",
        task: options.task,
        exitCode: 143,
        output: "",
        stderr: "",
        truncated: false,
        durationMs: 1,
        tokens: lobby.LOBBY_TOKEN_BUDGETS.chatty + 1,
        requests: 1,
        aborted: true,
      };
    });

    const worker = lobby.spawnLobbyWorker(dirs.cwd, mesh);
    await worker?.run;

    expect(worker?.abort.signal.aborted).toBe(true);
  });
});
