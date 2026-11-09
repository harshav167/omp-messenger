import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

vi.mock("../../crew/agents.ts", () => ({
  spawnAgents: vi.fn(),
}));

describe("executeRevise", () => {
  let executeRevise: typeof import("../../crew/handlers/task.ts").executeRevise;
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.ts");
  let state: typeof import("../../crew/state.ts");
  let liveProgress: typeof import("../../crew/live-progress.ts");
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../crew/handlers/revise.ts");
    executeRevise = mod.executeRevise;
    store = await import("../../crew/store.ts");
    state = await import("../../crew/state.ts");
    liveProgress = await import("../../crew/live-progress.ts");
    const agents = await import("../../crew/agents.ts");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    store.createPlan(tmpDir, "docs/PRD.md");
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nSome content");
  });

  afterEach(() => {
    state.autonomousState.active = false;
    state.autonomousState.cwd = null;
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
  });

  it("rejects when task not found", async () => {
    const r = await executeRevise(tmpDir, "task-99", undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("not found");
  });

  it("rejects in_progress task", async () => {
    const task = store.createTask(tmpDir, "test task");
    store.startTask(tmpDir, task.id, "agent");
    const r = await executeRevise(tmpDir, task.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("in_progress");
  });

  it("rejects when __reviser__ is already running", async () => {
    const task = store.createTask(tmpDir, "test task");
    liveProgress.updateLiveWorker(tmpDir, "__reviser__", {
      taskId: "__reviser__",
      agent: "crew-planner",
      name: "Reviser",
      progress: {
        toolCallCount: 0,
        tokens: 0,
        currentTool: undefined,
        currentToolArgs: undefined,
        recentTools: [],
      },
      startedAt: Date.now(),
    });

    const r = await executeRevise(tmpDir, task.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("already running");

    liveProgress.removeLiveWorker(tmpDir, "__reviser__");
  });

  it("rejects during planning", async () => {
    const task = store.createTask(tmpDir, "test task");
    state.startPlanningRun(tmpDir, 3);

    const r = await executeRevise(tmpDir, task.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("planning");

    state.clearPlanningState(tmpDir);
  });

  it("rejects during autonomous work", async () => {
    const task = store.createTask(tmpDir, "test task");
    state.autonomousState.active = true;
    state.autonomousState.cwd = tmpDir;

    const r = await executeRevise(tmpDir, task.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("autonomous");
  });

  it("revises task with prompt and updates spec", async () => {
    const task = store.createTask(tmpDir, "old title", "old spec content");
    spawnAgents.mockResolvedValue([
      {
        exitCode: 0,
        output:
          '```revised-task\n{"title": "new title", "spec": "# New Spec\\nRevised content"}\n```',
        error: null,
        progress: { toolCallCount: 0, tokens: 0 },
      },
    ]);

    const r = await executeRevise(tmpDir, task.id, "make it better", "agent");
    expect(r.success).toBe(true);
    expect(r.message).toContain("new title");

    const updated = store.getTask(tmpDir, task.id);
    expect(updated?.title).toBe("new title");
    const spec = store.getTaskSpec(tmpDir, task.id);
    expect(spec).toContain("Revised content");
  });

  it("revises task without prompt", async () => {
    const task = store.createTask(tmpDir, "test task", "old spec");
    spawnAgents.mockResolvedValue([
      {
        exitCode: 0,
        output: '```revised-task\n{"spec": "# Better Spec\\nImproved"}\n```',
        error: null,
        progress: { toolCallCount: 0, tokens: 0 },
      },
    ]);

    const r = await executeRevise(tmpDir, task.id, undefined, "agent");
    expect(r.success).toBe(true);

    const updated = store.getTask(tmpDir, task.id);
    expect(updated?.title).toBe("test task");
    const spec = store.getTaskSpec(tmpDir, task.id);
    expect(spec).toContain("Improved");
  });

  it("does not start a revision after its owner is cancelled", async () => {
    const task = store.createTask(tmpDir, "test task", "old spec");
    const originalSpec = store.getTaskSpec(tmpDir, task.id);
    const owner = new AbortController();
    owner.abort();

    const result = await executeRevise(
      tmpDir,
      task.id,
      "new instruction",
      "agent",
      undefined,
      undefined,
      "session-a",
      owner.signal,
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("Revision cancelled");
    expect(spawnAgents).not.toHaveBeenCalled();
    expect(store.getTaskSpec(tmpDir, task.id)).toBe(originalSpec);
  });

  it("handles planner failure gracefully", async () => {
    const task = store.createTask(tmpDir, "test task", "spec");
    spawnAgents.mockResolvedValue([
      {
        exitCode: 1,
        output: "",
        error: "planner crashed",
        progress: { toolCallCount: 0, tokens: 0 },
      },
    ]);

    const r = await executeRevise(tmpDir, task.id, "fix it", "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("planner");

    const spec = store.getTaskSpec(tmpDir, task.id);
    expect(spec).not.toContain("fix it");
  });

  it("handles unparseable planner output gracefully", async () => {
    const task = store.createTask(tmpDir, "test task", "spec");
    spawnAgents.mockResolvedValue([
      {
        exitCode: 0,
        output: "some random output without the expected block",
        error: null,
        progress: { toolCallCount: 0, tokens: 0 },
      },
    ]);

    const r = await executeRevise(tmpDir, task.id, undefined, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toContain("parse");
  });

  it("appends revision prompt to task progress log", async () => {
    const task = store.createTask(tmpDir, "test task", "spec");
    spawnAgents.mockResolvedValue([
      {
        exitCode: 0,
        output: '```revised-task\n{"spec": "new spec"}\n```',
        error: null,
        progress: { toolCallCount: 0, tokens: 0 },
      },
    ]);

    await executeRevise(tmpDir, task.id, "split auth", "agent");
    const progress = store.getTaskProgress(tmpDir, task.id);
    expect(progress).toContain("split auth");
  });
});
