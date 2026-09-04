import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";
import type { FeedEvent } from "../../feed.ts";
import type { Task } from "../../crew/types.ts";
import type { CrewConfig, CoordinationLevel } from "../../crew/utils/config.ts";
import { buildSelfRegistration, type MessengerState } from "../../lib.ts";
import type { Mesh } from "../../mesh/types.ts";
import { createTestMesh } from "../helpers/mesh.ts";
import { executeSend as executeSendHandler } from "../../handlers.ts";
import type * as FeedModule from "../../feed.ts";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: homedirMock };
});

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


async function loadCoordinationModule() {
  vi.resetModules();
  return import("../../crew/handlers/coordination.ts");
}

async function loadHandlersModule() {
  vi.resetModules();
  return import("../../handlers.ts");
}

describe("buildDependencySection", () => {
  let dirs: TempCrewDirs;
  let buildDependencySection: typeof import("../../crew/handlers/coordination.ts").buildDependencySection;

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
    const mod = await loadCoordinationModule();
    buildDependencySection = mod.buildDependencySection;
  });

  it("at minimal: shows dep IDs and titles, no summaries", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", summary: "Created types.ts" });
    writeTask(dirs.tasksDir, { id: "task-2", title: "Formatter", summary: "Created format.ts" });

    const task = makeTask("task-3", { depends_on: ["task-1", "task-2"] });
    const result = buildDependencySection(dirs.cwd, task, makeConfig("minimal"));

    expect(result).toContain("task-1: Types");
    expect(result).toContain("task-2: Formatter");
    expect(result).not.toContain("Created types.ts");
    expect(result).not.toContain("Created format.ts");
  });

  it("at moderate+: includes task.summary when available", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", summary: "Created types.ts with interfaces" });
    writeTask(dirs.tasksDir, { id: "task-2", title: "Formatter" });

    const task = makeTask("task-3", { depends_on: ["task-1", "task-2"] });
    const result = buildDependencySection(dirs.cwd, task, makeConfig("moderate"));

    expect(result).toContain("task-1 (Types): Created types.ts with interfaces");
    expect(result).toContain("task-2 (Formatter): (no summary)");
  });

  it("handles missing dep tasks gracefully", () => {
    const task = makeTask("task-3", { depends_on: ["task-1", "task-99"] });
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types" });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("minimal"));

    expect(result).toContain("task-1: Types");
    expect(result).toContain("- task-99");
  });

  it("in advisory mode renders done/in-progress/todo dependency states and non-blocking guidance", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types and Config", status: "done", summary: "Created types.ts with ObservationConfig" });
    writeTask(dirs.tasksDir, { id: "task-2", title: "Formatter", status: "in_progress", assigned_to: "HappyWolf" });
    writeTask(dirs.tasksDir, { id: "task-3", title: "Observer", status: "todo" });

    const task = makeTask("task-4", { depends_on: ["task-1", "task-2", "task-3"] });
    const result = buildDependencySection(dirs.cwd, task, makeConfig("moderate", "advisory"));

    expect(result).toContain("## Dependency Status");
    expect(result).toContain("✓ task-1 (Types and Config) — done. Created types.ts with ObservationConfig");
    expect(result).toContain("⟳ task-2 (Formatter) — in progress, worker: HappyWolf");
    expect(result).toContain("○ task-3 (Observer) — not yet started");
    expect(result).toContain("Do NOT block yourself because a dependency isn't done. Work around it.");
  });

  it("in advisory mode includes DM guidance when coordination is enabled", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", status: "in_progress", assigned_to: "OakBear" });
    const task = makeTask("task-2", { depends_on: ["task-1"] });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("minimal", "advisory"));
    expect(result).toContain("DM in-progress workers for API details they're building.");
  });

  it("in advisory mode excludes DM guidance when coordination is none", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", status: "in_progress", assigned_to: "OakBear" });
    const task = makeTask("task-2", { depends_on: ["task-1"] });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("none", "advisory"));
    expect(result).not.toContain("DM in-progress workers for API details they're building.");
  });

  it("in strict mode keeps existing completed-dependencies section", () => {
    writeTask(dirs.tasksDir, { id: "task-1", title: "Types", status: "done", summary: "Created types.ts" });
    const task = makeTask("task-2", { depends_on: ["task-1"] });

    const result = buildDependencySection(dirs.cwd, task, makeConfig("moderate", "strict"));
    expect(result).toContain("## Dependencies");
    expect(result).toContain("Your task depends on these completed tasks:");
    expect(result).toContain("task-1 (Types): Created types.ts");
    expect(result).not.toContain("## Dependency Status");
    expect(result).not.toContain("Do NOT block yourself because a dependency isn't done.");
  });
});

describe("buildCoordinationContext", () => {
  let dirs: TempCrewDirs;
  let buildCoordinationContext: typeof import("../../crew/handlers/coordination.ts").buildCoordinationContext;

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
    const mod = await loadCoordinationModule();
    buildCoordinationContext = mod.buildCoordinationContext;
  });

  it("with level none returns empty string", () => {
    const task = makeTask("task-1");
    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("none"), []);
    expect(result).toBe("");
  });

  it("with level minimal includes concurrent tasks but not recent activity or ready tasks", () => {
    const task = makeTask("task-1");
    const others = [makeTask("task-2", { title: "Formatter" }), makeTask("task-3", { title: "File Ops" })];

    writeFeedEvents(dirs.cwd, [
      makeEvent("2026-01-01T22:14:00Z", "task.done", "EpicGrove", "task-4", "Created observer.ts"),
    ]);

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("minimal"), others);

    expect(result).toContain("## Concurrent Tasks");
    expect(result).toContain("task-2: Formatter");
    expect(result).toContain("task-3: File Ops");
    expect(result).not.toContain("## Recent Activity");
    expect(result).not.toContain("## Ready Tasks");
  });


  it("chatty ready tasks excludes concurrent tasks", () => {
    writeTask(dirs.tasksDir, { id: "task-1", status: "done" });
    writeTask(dirs.tasksDir, { id: "task-2", status: "todo", title: "Formatter", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-3", status: "todo", title: "File Ops", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-4", status: "todo", title: "Observer", depends_on: ["task-1"] });

    const task = makeTask("task-2", { title: "Formatter", depends_on: ["task-1"] });
    const others = [makeTask("task-3", { title: "File Ops", depends_on: ["task-1"] })];

    const result = buildCoordinationContext(dirs.cwd, task, makeConfig("chatty"), others);

    expect(result).toContain("## Ready Tasks");
    expect(result).toContain("task-4: Observer");
    expect(result).not.toMatch(/Ready Tasks[\s\S]*task-2/);
    expect(result).not.toMatch(/Ready Tasks[\s\S]*task-3/);
  });

  it("chatty ready tasks separates approval-gated and rejected tasks", () => {
    writeTask(dirs.tasksDir, { id: "task-1", status: "done" });
    writeTask(dirs.tasksDir, { id: "task-2", status: "todo", title: "Current", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-3", status: "todo", title: "Needs approval", depends_on: ["task-1"], approval: { required: true, status: "pending" } });
    writeTask(dirs.tasksDir, { id: "task-4", status: "todo", title: "Claimable", depends_on: ["task-1"] });
    writeTask(dirs.tasksDir, { id: "task-5", status: "todo", title: "Rejected", depends_on: ["task-1"], approval: { required: true, status: "rejected", feedback: "needs tests" } });

    const result = buildCoordinationContext(dirs.cwd, makeTask("task-2", { depends_on: ["task-1"] }), makeConfig("chatty"), []);

    const claimableSection = result.slice(0, result.indexOf("## Ready Tasks Needing Approval"));
    expect(claimableSection).toContain("task-4: Claimable");
    expect(claimableSection).not.toContain("task-3: Needs approval");
    expect(claimableSection).not.toContain("task-5: Rejected");
    expect(result).toMatch(/Ready Tasks Needing Approval[\s\S]*task-3: Needs approval/);
    expect(result).toContain('pi_messenger({ action: "task.approve", id: "task-3" })');
    expect(result).toMatch(/Rejected Tasks Needing Revision[\s\S]*task-5: Rejected/);
    expect(result).toContain('pi_messenger({ action: "task.revise", id: "task-5", prompt: "Address approval feedback" })');
  });

});

describe("buildCoordinationInstructions", () => {
  let buildCoordinationInstructions: typeof import("../../crew/handlers/coordination.ts").buildCoordinationInstructions;

  beforeEach(async () => {
    homedirMock.mockReturnValue("/tmp/pi-test-noop");
    const mod = await loadCoordinationModule();
    buildCoordinationInstructions = mod.buildCoordinationInstructions;
  });

  it("returns empty for none", () => {
    expect(buildCoordinationInstructions(makeConfig("none"))).toBe("");
  });

  it("minimal includes reservation checking and budget", () => {
    const result = buildCoordinationInstructions(makeConfig("minimal"));
    expect(result).toContain("## Coordination");
    expect(result).toContain("Message budget: 2 messages");
    expect(result).toContain('action: "list"');
    expect(result).toContain('action: "send"');
    expect(result).not.toContain("broadcast");
  });

  it("moderate uses action: broadcast for announcements", () => {
    const result = buildCoordinationInstructions(makeConfig("moderate"));
    expect(result).toContain("Message budget: 5 messages");
    expect(result).toContain('action: "broadcast"');
    expect(result).toContain("### Announce yourself");
    expect(result).toContain("### On completion");
    expect(result).toContain("### Reservations");
    expect(result).toContain("### Questions about dependencies");
    expect(result).not.toContain("### Claim next task");
    expect(result).not.toContain("### Coordinate with peers");
    expect(result).not.toContain("### Responding to messages");
  });

  it("includes the configured message budget in instructions", () => {
    const config = makeConfig("moderate");
    config.messageBudgets = { none: 0, minimal: 3, moderate: 8, chatty: 15 };
    const result = buildCoordinationInstructions(config);
    expect(result).toContain("Message budget: 8 messages");
  });

  it("chatty includes DM coordination, message responsiveness, and claim next task", () => {
    const result = buildCoordinationInstructions(makeConfig("chatty"));
    expect(result).toContain("### Coordinate with peers");
    expect(result).toContain("### Responding to messages");
    expect(result).toContain("### Claim next task");
    expect(result).toContain("Message budget:");
    expect(result).toContain('action: "send"');
    expect(result).toContain('action: "task.ready"');
    expect(result).toContain("task.start");
    expect(result).toContain("### Questions about dependencies");
  });

  it("read-only coordination avoids edit and build wording", () => {
    const result = buildCoordinationInstructions(makeConfig("chatty"), { readOnly: true });
    expect(result).toContain("what you are investigating");
    expect(result).toContain("what you found or recommend");
    expect(result).not.toContain("will create <files>");
    expect(result).not.toContain("what you built");
    expect(result).not.toContain("Before editing");
    expect(result).not.toContain("### Reservations");
  });
});

describe("config coordination", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
  });

  it("default config has coordination: chatty with message budgets", async () => {
    const { loadCrewConfig } = await (async () => { vi.resetModules(); return import("../../crew/utils/config.ts"); })();
    const cfg = loadCrewConfig(dirs.crewDir);
    expect(cfg.coordination).toBe("chatty");
    expect(cfg.messageBudgets).toEqual({ none: 0, minimal: 2, moderate: 5, chatty: 10 });
  });

  it("respects coordination field from project config", async () => {
    writeJson(path.join(dirs.crewDir, "config.json"), { coordination: "minimal" });
    const { loadCrewConfig } = await (async () => { vi.resetModules(); return import("../../crew/utils/config.ts"); })();
    const cfg = loadCrewConfig(dirs.crewDir);
    expect(cfg.coordination).toBe("minimal");
  });
});


describe("executeSend broadcast filtering", () => {
  let dirs: TempCrewDirs;
  let executeSend: typeof executeSendHandler;
  let feedModule: typeof FeedModule;
  let mesh: Mesh;
  let state: MessengerState;

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);

    const handlers = await loadHandlersModule();
    feedModule = await import("../../feed.ts");
    executeSend = handlers.executeSend;

    ({ mesh, state } = createTestMesh(dirs.cwd, { agentName: "EpicGrove", cwd: dirs.cwd }));
    state.registered = true;
    state.messagesSent = 0;

    vi.spyOn(mesh, "peers").mockReturnValue([
      { ...buildSelfRegistration(state), name: "OakBear" },
      { ...buildSelfRegistration(state), name: "PineFox" },
    ]);
    vi.spyOn(mesh, "send").mockImplementation(async (to, text, options) => ({
      ok: true,
      message: {
        id: "msg-id",
        from: state.agentName,
        to,
        text,
        timestamp: new Date().toISOString(),
        replyTo: options?.replyTo ?? null,
      },
    }));
    vi.spyOn(feedModule, "logFeedEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("worker broadcast logs to feed only", async () => {
    state.isCrewWorker = true;

    const response = await executeSend(
      state,
      mesh,
      dirs.cwd,
      undefined,
      true,
      "Worker update"
    );

    expect(response.content[0]?.text).toContain("Broadcast logged");
    expect(mesh.send).not.toHaveBeenCalled();
    expect(feedModule.logFeedEvent).toHaveBeenCalledWith(
      dirs.cwd,
      "EpicGrove",
      "message",
      undefined,
      "Worker update",
    );
  });

  it("non-worker broadcast delivers to mesh recipients", async () => {
    state.isCrewWorker = false;

    await executeSend(
      state,
      mesh,
      dirs.cwd,
      undefined,
      true,
      "Team-wide update"
    );

    expect(mesh.send).toHaveBeenCalledTimes(2);
    expect(mesh.send).toHaveBeenCalledWith(
      "OakBear",
      "Team-wide update",
      { replyTo: undefined },
    );
    expect(mesh.send).toHaveBeenCalledWith(
      "PineFox",
      "Team-wide update",
      { replyTo: undefined },
    );
  });

  it("worker direct message still delivers", async () => {
    state.isCrewWorker = true;

    await executeSend(
      state,
      mesh,
      dirs.cwd,
      "OakBear",
      undefined,
      "Need your input"
    );

    expect(mesh.send).toHaveBeenCalledTimes(1);
    expect(mesh.send).toHaveBeenCalledWith(
      "OakBear",
      "Need your input",
      { replyTo: undefined },
    );
  });

  it("worker broadcast increments message budget usage", async () => {
    state.isCrewWorker = true;
    state.messagesSent = 0;
    writeJson(path.join(dirs.crewDir, "config.json"), {
      coordination: "chatty",
      messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 1 },
    });

    const first = await executeSend(
      state,
      mesh,
      dirs.cwd,
      undefined,
      true,
      "First broadcast"
    );
    const second = await executeSend(
      state,
      mesh,
      dirs.cwd,
      undefined,
      true,
      "Second broadcast"
    );

    expect(first.content[0]?.text).toContain("Broadcast logged");
    expect(first.content[0]?.text).toContain("(0 messages remaining)");
    expect(second.content[0]?.text).toContain("Message budget reached (1/1");
  });
});
