import * as fs from "node:fs";
import * as path from "node:path";
import type { SingleResult as SdkSingleResult } from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { raceTimeout, spawnAgents } from "../../crew/agents.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { setSdk } from "../../crew/sdk.ts";
import { createTestMesh } from "../helpers/mesh.ts";
import { createFakeSdk } from "../helpers/sdk.ts";

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".omp", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a worker.
`);
}

describe("crew/graceful shutdown", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raceTimeout returns true when promise resolves before timeout and false on timeout", async () => {
    vi.useFakeTimers();
    const fastRun = Promise.withResolvers<void>();
    const fast = raceTimeout(fastRun.promise, 100);
    fastRun.resolve();
    await expect(fast).resolves.toBe(true);

    const slowRun = Promise.withResolvers<void>();
    const slow = raceTimeout(slowRun.promise, 5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(slow).resolves.toBe(false);
  });

  it("sends an urgent shutdown message and evicts the settled worker", async () => {
    const fake = createFakeSdk();
    setSdk(fake.sdk);
    writeWorkerAgent(dirs.cwd);

    const testMesh = createTestMesh(dirs.cwd);
    const registryDir = path.join(testMesh.base, "registry");
    fs.mkdirSync(registryDir, { recursive: true });
    let finishRun: ((result: SdkSingleResult) => void) | undefined;
    let workerName = "";

    fake.runSubprocess.mockImplementation(options => {
      const run = Promise.withResolvers<SdkSingleResult>();
      workerName = options.id;
      fs.writeFileSync(path.join(registryDir, `${workerName}.json`), "{}");
      const finish = (aborted: boolean): void => run.resolve({
        index: options.index,
        id: options.id,
        agent: options.agent.name,
        agentSource: "user",
        task: options.task,
        exitCode: aborted ? 143 : 0,
        output: "",
        stderr: "",
        truncated: false,
        durationMs: 1,
        tokens: 0,
        requests: 1,
        aborted,
      });
      finishRun = run.resolve;
      options.signal?.addEventListener("abort", () => finish(true), { once: true });
      return run.promise;
    });

    const sendSpy = vi.spyOn(testMesh.mesh, "send").mockImplementation(async (to, text, options) => {
      finishRun?.({
        index: 0,
        id: to,
        agent: "crew-worker",
        agentSource: "user",
        task: "execute task",
        exitCode: 0,
        output: "",
        stderr: "",
        truncated: false,
        durationMs: 1,
        tokens: 0,
        requests: 1,
      });
      return {
        ok: true,
        message: {
          id: "shutdown",
          from: options?.from ?? "crew-orchestrator",
          to,
          text,
          timestamp: new Date().toISOString(),
          replyTo: null,
          urgent: options?.urgent,
        },
      };
    });

    const controller = new AbortController();
    const resultPromise = spawnAgents([{
      agent: "crew-worker",
      task: "execute task",
      taskId: "task-1",
    }], dirs.cwd, {
      signal: controller.signal,
      mesh: testMesh.mesh,
    });
    controller.abort();
    const [result] = await resultPromise;

    expect(sendSpy).toHaveBeenCalledWith(
      workerName,
      expect.stringContaining("SHUTDOWN REQUESTED"),
      { from: "crew-orchestrator", urgent: true },
    );
    expect(result?.wasGracefullyShutdown).toBe(true);
    expect(fs.existsSync(path.join(registryDir, `${workerName}.json`))).toBe(false);
  });

  it("result processing uses taskId and graceful shutdown branches correctly", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      store.updateTask(dirs.cwd, task.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 0,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "running" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: task.id,
        wasGracefullyShutdown: true,
      }];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(response.details.failed).toEqual([task.id]);
    expect(response.details.blocked).toEqual([]);
  });

  it("graceful non-zero exit with done task is credited as success; crash blocks in autonomous mode", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    let call = 0;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      call++;
      if (call === 1) {
        store.updateTask(dirs.cwd, t1.id, { status: "done" });
        return [{
          agent: "crew-worker",
          exitCode: 1,
          output: "",
          truncated: false,
          progress: {
            agent: "crew-worker",
            status: "failed" as const,
            recentTools: [],
            toolCallCount: 0,
            tokens: 0,
            durationMs: 0,
          },
          taskId: t1.id,
          wasGracefullyShutdown: true,
          error: "terminated",
        }];
      }

      store.updateTask(dirs.cwd, t2.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t2.id,
        wasGracefullyShutdown: false,
        error: "crash",
      }];
    });

    const first = await workHandler.execute(
      { action: "work", concurrency: 1 },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );
    expect(first.details.succeeded).toEqual([t1.id]);

    const second = await workHandler.execute(
      { action: "work", autonomous: true, concurrency: 1 },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );
    expect(second.details.blocked).toEqual([t2.id]);
    expect(store.getTask(dirs.cwd, t2.id)?.status).toBe("blocked");
  });

  it("autonomous mode stops with manual reason when signal is aborted", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    const state = await import("../../crew/state.ts");

    state.autonomousState.active = false;
    state.autonomousState.cwd = null;
    state.autonomousState.waveNumber = 0;
    state.autonomousState.waveHistory = [];
    state.autonomousState.startedAt = null;
    state.autonomousState.stoppedAt = null;
    state.autonomousState.stopReason = null;
    state.autonomousState.concurrency = 2;
    state.autonomousState.autoOverlayPending = false;
    state.autonomousState.pid = null;

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      store.updateTask(dirs.cwd, task.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: task.id,
        wasGracefullyShutdown: true,
      }];
    });

    const controller = new AbortController();
    controller.abort();

    const appendEntry = vi.fn();
    const response = await workHandler.execute(
      { action: "work", autonomous: true, concurrency: 1 },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      appendEntry,
      controller.signal,
    );

    expect(state.autonomousState.active).toBe(false);
    expect(state.autonomousState.stopReason).toBe("manual");
    expect(appendEntry).toHaveBeenCalledWith("crew-state", state.autonomousState);
    expect(response.content[0].text).toContain("Autonomous mode stopped (cancelled).");
  });

  it("clamps fractional concurrency and passes all ready tasks to spawnAgents", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const state = await import("../../crew/state.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    store.createTask(dirs.cwd, "Task one", "Desc one");
    store.createTask(dirs.cwd, "Task two", "Desc two");
    store.createTask(dirs.cwd, "Task three", "Desc three");

    const spawnSpy = vi.spyOn(agents, "spawnAgents").mockResolvedValue([]);

    await workHandler.execute(
      { action: "work", concurrency: 1.8 },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(state.autonomousState.concurrency).toBe(1);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const workerTasks = spawnSpy.mock.calls[0][0] as Array<{ taskId: string }>;
    expect(workerTasks).toHaveLength(3);
  });

  it("reconciles completed_count before returning from a no-ready wave", async () => {
    const store = await import("../../crew/store.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    store.startTask(dirs.cwd, t1.id, "WorkerA");
    store.completeTask(dirs.cwd, t1.id, "Done");
    store.startTask(dirs.cwd, t2.id, "WorkerB");
    store.completeTask(dirs.cwd, t2.id, "Done");

    store.updatePlan(dirs.cwd, { completed_count: 0 });
    expect(store.getPlan(dirs.cwd)?.completed_count).toBe(0);

    const response = await workHandler.execute(
      { action: "work" },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(store.getPlan(dirs.cwd)?.completed_count).toBe(2);
    expect(response.content[0].text).toContain("All tasks are done");
  });

  it("reconciles completed_count after worker results are processed", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) {
          store.updateTask(dirs.cwd, t.taskId, { status: "done" });
        }
      }
      return tasks.map(t => ({
        agent: "crew-worker",
        exitCode: 0,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "completed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t.taskId,
      }));
    });

    const response = await workHandler.execute(
      { action: "work", concurrency: 2 },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(store.getPlan(dirs.cwd)?.completed_count).toBe(2);
    expect(response.content[0].text).toContain("**Progress:** 2/2");
    expect(response.details.succeeded).toEqual([t1.id, t2.id]);
  });

  it("auto-blocks tasks that exceed maxAttemptsPerTask before assigning to workers", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Flaky task", "Keeps failing");

    store.updateTask(dirs.cwd, t1.id, { attempt_count: 5 });

    const spawnSpy = vi.spyOn(agents, "spawnAgents").mockImplementation(async () => []);

    const response = await workHandler.execute(
      { action: "work" },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, t1.id);
    expect(reloaded?.status).toBe("blocked");
    expect(reloaded?.blocked_reason).toContain("Max attempts");
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain("No ready tasks");
  });

  it("worker exit 0 with task still in_progress resets to todo", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Abandoned task", "Worker forgot task.done");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, "Worker");
      }
      return tasks.map(t => ({
        agent: "crew-worker",
        exitCode: 0,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "running" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t.taskId,
      }));
    });

    const response = await workHandler.execute(
      { action: "work" },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, t1.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(response.details.failed).toEqual([t1.id]);
  });

  it("graceful shutdown with non-zero exit and in_progress task resets to todo and reports failed", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Interrupted task", "Graceful non-zero");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, "Worker");
      }
      return tasks.map(t => ({
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t.taskId,
        wasGracefullyShutdown: true,
        error: "terminated",
      }));
    });

    const response = await workHandler.execute(
      { action: "work" },
      createTestMesh(dirs.cwd).mesh,
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, t1.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(response.details.failed).toEqual([t1.id]);
    expect(response.details.blocked).toEqual([]);
  });
});
