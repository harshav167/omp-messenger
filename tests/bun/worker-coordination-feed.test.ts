import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCoordinationContext } from "../../crew/handlers/coordination.ts";
import { buildWorkerPrompt } from "../../crew/prompt.ts";
import type { Task } from "../../crew/types.ts";
import type { CrewConfig, CoordinationLevel } from "../../crew/utils/config.ts";
import type { FeedEvent } from "../../feed.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeTask(tasksDir: string, task: Partial<Task> & { id: string }): void {
  const full: Task = {
    title: task.title ?? task.id,
    status: task.status ?? "done",
    depends_on: task.depends_on ?? [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    attempt_count: 0,
    ...task,
  };
  writeJson(path.join(tasksDir, `${task.id}.json`), full);
}

function writeFeedEvents(cwd: string, events: FeedEvent[]): void {
  const feedPath = path.join(cwd, ".omp", "messenger", "feed.jsonl");
  fs.mkdirSync(path.dirname(feedPath), { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(feedPath, lines);
}

function makeEvent(ts: string, type: string, agent = "TestAgent", target?: string, preview?: string): FeedEvent {
  return { ts, agent, type: type as FeedEvent["type"], target, preview };
}

function makeConfig(level: CoordinationLevel, dependencies: CrewConfig["dependencies"] = "strict"): CrewConfig {
  return {
    concurrency: { workers: 2, max: 10 },
    truncation: {
      planners: { bytes: 204800, lines: 5000 },
      workers: { bytes: 204800, lines: 5000 },
      reviewers: { bytes: 102400, lines: 2000 },
      analysts: { bytes: 102400, lines: 2000 },
    },
    artifacts: { enabled: false, cleanupDays: 7 },
    memory: { enabled: false },
    planSync: { enabled: false },
    review: { enabled: true, maxIterations: 3 },
    planning: { maxPasses: 3 },
    work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false, shutdownGracePeriodMs: 30000 },
    dependencies,
    coordination: level,
    messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 10 },
    team: { enabled: true },
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    depends_on: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    attempt_count: 0,
    ...overrides,
  };
}

let dirs: TempCrewDirs;
let homeDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-home-"));
  process.env.HOME = homeDir;
  dirs = createTempCrewDirs();
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("buildCoordinationContext", () => {
  it("with level moderate includes concurrent tasks and recent activity", () => {
    const task = makeTask("task-1");
    const others = [makeTask("task-2", { title: "Formatter" })];

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:12:00Z", "join", "OakBear"),
      makeEvent("2026-01-01T22:13:00Z", "task.start", "OakBear", "task-5", "Reflector"),
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-4", "Created observer.ts"),
    ]);

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), others);

    expect(result).toContain("## Concurrent Tasks");
    expect(result).toContain("## Recent Activity");
    expect(result).toContain("OakBear started task-5");
    expect(result).toContain("EpicGrove completed task-4");
    expect(result).not.toContain("OakBear" + " " + "join");
    expect(result).not.toContain("## Ready Tasks");
  });

  it("with level chatty includes concurrent tasks, recent activity, and ready tasks", () => {
    writeTask(dirs.tasksDir, { id: "task-1", status: "done" });
    writeTask(dirs.tasksDir, { id: "task-2", status: "todo", title: "Formatter" });
    writeTask(dirs.tasksDir, { id: "task-3", status: "todo", title: "File Ops" });
    writeTask(dirs.tasksDir, { id: "task-6", status: "todo", title: "Entry Point", depends_on: ["task-1"] });

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-1", "Done"),
    ]);

    const task = makeTask("task-2", { title: "Formatter", depends_on: ["task-1"] });
    const others = [makeTask("task-3", { title: "File Ops" })];

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("chatty"), others);

    expect(result).toContain("## Concurrent Tasks");
    expect(result).toContain("## Recent Activity");
    expect(result).toContain("## Ready Tasks");
    expect(result).toContain("task-6: Entry Point");
  });

  it("omits concurrent tasks section when concurrentTasks is empty (solo task)", () => {
    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-1", "Done"),
    ]);

    const task = makeTask("task-2");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), []);

    expect(result).not.toContain("## Concurrent Tasks");
    expect(result).toContain("## Recent Activity");
  });

  it("filters out join/leave noise from recent activity", () => {
    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:10:00Z", "join", "Worker1"),
      makeEvent("2026-01-01T22:11:00Z", "task.start", "Worker1", "task-1", "Types"),
      makeEvent("2026-01-01T22:12:00Z", "leave", "Worker2"),
      makeEvent("2026-01-01T22:13:00Z", "task.done", "Worker1", "task-1", "Created types.ts"),
    ]);

    const task = makeTask("task-2");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), []);

    expect(result).toContain("Worker1 started task-1");
    expect(result).toContain("Worker1 completed task-1");
    expect(result).not.toContain("join");
    expect(result).not.toContain("leave");
  });

  it("formats message events in recent activity with direction indicators", () => {
    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:10:00Z", "task.start", "EpicGrove", "task-1", "Auth module"),
      { ...makeEvent("2026-01-01T22:11:00Z", "message", "EpicGrove"), target: "OakBear", preview: "Need User type from schema" },
      { ...makeEvent("2026-01-01T22:12:00Z", "message", "OakBear"), preview: "Completed task-2: schema.ts exports User, Session" },
    ]);

    const task = makeTask("task-3");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("moderate"), []);

    expect(result).toContain("EpicGrove → OakBear: Need User type from schema");
    expect(result).toContain("OakBear ✦ Completed task-2");
    expect(result).not.toContain("said");
  });
});

describe("buildWorkerPrompt integration", () => {
  it("at chatty level: enriched deps, concurrent tasks, recent activity, ready tasks, coordination instructions in correct order", () => {
    writeTask(dirs.tasksDir, { id: "task-1", status: "done", title: "Types", summary: "Created types.ts" });
    writeTask(dirs.tasksDir, { id: "task-2", status: "todo", title: "Formatter", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-3", status: "todo", title: "File Ops", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-6", status: "todo", title: "Entry Point", depends_on: ["task-1"] });

    fs.writeFileSync(path.join(dirs.tasksDir, "task-2.md"), "Build the formatter module");

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-1", "Done"),
    ]);

    const task = makeTask("task-2", { title: "Formatter", depends_on: ["task-1"] });
    const others = [makeTask("task-3", { title: "File Ops", depends_on: ["task-1"] })];
    const config = makeConfig("chatty");

    const prompt = buildWorkerPrompt(task, "docs/PRD.md", dirs.cwd, config, others);

    // Check all sections present
    expect(prompt).toContain("# Task Assignment");
    expect(prompt).toContain("## Dependencies");
    expect(prompt).toContain("task-1 (Types): Created types.ts");
    expect(prompt).toContain("## Concurrent Tasks");
    expect(prompt).toContain("task-3: File Ops");
    expect(prompt).toContain("## Recent Activity");
    expect(prompt).toContain("## Ready Tasks");
    expect(prompt).toContain("task-6: Entry Point");
    expect(prompt).toContain("## Task Specification");
    expect(prompt).toContain("## Coordination");
    expect(prompt).toContain("### Announce yourself");
    expect(prompt).toContain("### Coordinate with peers");
    expect(prompt).toContain("### Responding to messages");
    expect(prompt).toContain("### Claim next task");

    // Verify ordering: Dependencies before Task Specification, Coordination at end
    const depsIdx = prompt.indexOf("## Dependencies");
    const concurrentIdx = prompt.indexOf("## Concurrent Tasks");
    const specIdx = prompt.indexOf("## Task Specification");
    const coordIdx = prompt.indexOf("## Coordination");

    expect(depsIdx).toBeLessThan(concurrentIdx);
    expect(concurrentIdx).toBeLessThan(specIdx);
    expect(specIdx).toBeLessThan(coordIdx);
  });
});
