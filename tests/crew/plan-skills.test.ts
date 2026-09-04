import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

vi.mock("../../crew/agents.ts", () => ({
  spawnAgents: vi.fn(),
}));

describe("plan with skills", () => {
  let planHandler: typeof import("../../crew/handlers/plan.ts");
  let spawnAgents: ReturnType<typeof vi.fn>;
  let store: typeof import("../../crew/store.ts");
  let state: typeof import("../../crew/state.ts");
  let tmpDir: string;
  let mockCtx: any;

  function plannerOutputWithSkills(tasks: unknown[]) {
    return `## 1. PRD Understanding Summary\nSummary\n## 2. Relevant Code/Docs/Resources Reviewed\nResources\n## 3. Sequential Implementation Steps\nSteps\n## 4. Parallelized Task Graph\nGraph\n\`\`\`tasks-json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``;
  }

  function writeProjectSkill(name: string, description: string) {
    const skillsDir = path.join(tmpDir, ".omp", "messenger", "crew", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nSkill content for ${name}.\n`);
  }

  beforeEach(async () => {
    vi.resetModules();
    planHandler = await import("../../crew/handlers/plan.ts");
    store = await import("../../crew/store.ts");
    state = await import("../../crew/state.ts");
    const agents = await import("../../crew/agents.ts");
    spawnAgents = agents.spawnAgents as ReturnType<typeof vi.fn>;

    const dirs = createTempCrewDirs();
    tmpDir = dirs.cwd;
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "PRD.md"), "# PRD\nBuild a feature");
    mockCtx = { cwd: tmpDir, hasUI: false, ui: {} };
  });

  afterEach(() => {
    if (state.planningState.cwd) state.clearPlanningState(state.planningState.cwd);
    delete process.env.OMP_MESSENGER_TEAM_PROFILE_DIR;
  });

  it("persists planner-tagged skills on created tasks", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Build API", description: "REST endpoints", dependsOn: [], skills: ["api-design", "testing"] },
        { title: "Build UI", description: "React components", dependsOn: ["Build API"], skills: ["react-patterns"] },
        { title: "Write docs", description: "Documentation", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(r.details?.error).toBeUndefined();

    const tasks = store.getTasks(tmpDir);
    expect(tasks).toHaveLength(3);

    const apiTask = tasks.find(t => t.title === "Build API");
    const uiTask = tasks.find(t => t.title === "Build UI");
    const docsTask = tasks.find(t => t.title === "Write docs");

    expect(apiTask?.skills).toEqual(["api-design", "testing"]);
    expect(uiTask?.skills).toEqual(["react-patterns"]);
    expect(docsTask?.skills).toBeUndefined();
  });

  it("handles tasks-json with no skills field gracefully", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Task A", description: "Do A", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(r.details?.error).toBeUndefined();

    const tasks = store.getTasks(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].skills).toBeUndefined();
  });

  it("ignores non-string elements in skills array", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Task A", description: "Do A", dependsOn: [], skills: ["valid", 42, null, "also-valid"] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(r.details?.error).toBeUndefined();

    const tasks = store.getTasks(tmpDir);
    expect(tasks[0].skills).toEqual(["valid", "also-valid"]);
  });

  it("skips invalid tasks-json items without discarding the block", async () => {
    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        null,
        { title: "Task A", description: "Do A", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(r.details?.error).toBeUndefined();
    expect(store.getTasks(tmpDir).map(t => t.title)).toEqual(["Task A"]);
  });

  it("persists planner-tagged Team role and risk labels with approval", async () => {
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(tmpDir, "profiles");
    const teamStore = await import("../../crew/team/store.ts");
    teamStore.useProfile(tmpDir, "migration-squad");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Map auth", description: "Inspect auth", dependsOn: [], role: " Scout ", riskLabels: ["auth"] },
        { title: "Change auth", description: "Edit auth", dependsOn: ["Map auth"], role: "worker", riskLabels: ["auth", "api-contract"] },
        { title: "Typo role", description: "Invalid role", dependsOn: [], role: "scuot", riskLabels: ["auth"] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const r = await planHandler.execute({ action: "plan" }, mockCtx, "agent");
    expect(r.details?.error).toBeUndefined();

    const tasks = store.getTasks(tmpDir);
    expect(tasks[0].role).toBe("scout");
    expect(tasks[0].risk_labels).toEqual(["auth"]);
    expect(tasks[0].approval).toBeUndefined();
    expect(tasks[1].role).toBe("worker");
    expect(tasks[1].risk_labels).toEqual(["auth", "api-contract"]);
    expect(tasks[1].approval).toEqual({ required: true, status: "pending" });
    expect(tasks[2].role).toBeUndefined();
    expect(tasks[2].approval).toEqual({ required: true, status: "pending" });
    expect(r.content[0].text).toContain("Map auth [scout] [risk: auth]");
    expect(r.content[0].text).toContain("Change auth [worker] [risk: auth, api-contract] [approval: pending]");
  });

  it("does not promise auto-start when all ready tasks need approval", async () => {
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(tmpDir, "profiles");
    const teamStore = await import("../../crew/team/store.ts");
    teamStore.useProfile(tmpDir, "migration-squad");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Change auth", description: "Edit auth", dependsOn: [], role: "worker", riskLabels: ["auth"] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    const response = await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    expect(response.content[0].text).not.toContain("Workers will start automatically");
    expect(response.content[0].text).toContain('omp_messenger({ action: "task.approve", id: "task-1" })');
  });

  it("injects Team role catalog into planner prompt when active", async () => {
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(tmpDir, "profiles");
    const teamStore = await import("../../crew/team/store.ts");
    teamStore.useProfile(tmpDir, "migration-squad");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Task A", description: "Do A", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    const plannerPrompt = spawnAgents.mock.calls[0][0][0].task;
    expect(plannerPrompt).toContain("Active Team");
    expect(plannerPrompt).toContain("migration-squad");
    expect(plannerPrompt).toContain("delegate");
    expect(plannerPrompt).toContain("role");
    expect(plannerPrompt).toContain("riskLabels");
    expect(plannerPrompt).toContain("Crew still runs tasks through Crew agents and does not launch pi-subagents");
  });

  it("shows default approval labels in planner prompt when profile omits labels", async () => {
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(tmpDir, "profiles");
    const teamStore = await import("../../crew/team/store.ts");
    teamStore.saveProfile({
      name: "default-gates",
      roles: { worker: { description: "Edit work" } },
      approval: { mode: "risk-labels" },
    });
    teamStore.useProfile(tmpDir, "default-gates");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Task A", description: "Do A", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    const plannerPrompt = spawnAgents.mock.calls[0][0][0].task;
    expect(plannerPrompt).toContain("High-risk labels requiring lead approval for editing roles: security, database, api-contract, destructive, migration, auth, payment");
  });

  it("injects project skill index into planner prompt", async () => {
    writeProjectSkill("react-patterns", "React conventions and hooks");
    writeProjectSkill("testing", "Test setup and patterns");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Task A", description: "Do A", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    const plannerPrompt = spawnAgents.mock.calls[0][0][0].task;
    expect(plannerPrompt).toContain("Available Skills");
    expect(plannerPrompt).toContain("react-patterns");
    expect(plannerPrompt).toContain("testing");
    expect(plannerPrompt).toContain("skills");
  });

  it("planner prompt mentions skills in format instructions", async () => {
    writeProjectSkill("some-skill", "A skill");

    spawnAgents.mockResolvedValue([{
      exitCode: 0,
      output: plannerOutputWithSkills([
        { title: "Task A", description: "Do A", dependsOn: [] },
      ]),
      error: null,
      progress: { toolCallCount: 0, tokens: 0 },
    }]);

    await planHandler.execute({ action: "plan" }, mockCtx, "agent");

    const plannerPrompt = spawnAgents.mock.calls[0][0][0].task;
    expect(plannerPrompt).toContain("optionally skills");
  });

});
