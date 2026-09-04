import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../../crew/prompt.ts";
import * as teamStore from "../../crew/team/store.ts";
import type { Task } from "../../crew/types.ts";
import type { CrewSkillInfo } from "../../crew/utils/discover.ts";
import type { CrewConfig } from "../../crew/utils/config.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    status: "in_progress",
    depends_on: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attempt_count: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CrewConfig> = {}): CrewConfig {
  return {
    concurrency: { workers: 2, max: 8 },
    dependencies: "strict",
    coordination: "none",
    planning: { maxPasses: 1 },
    review: { enabled: false, maxIterations: 1 },
    work: { maxAttemptsPerTask: 3, env: {} },
    artifacts: { enabled: false },
    ...overrides,
  } as CrewConfig;
}

function makeSkills(): CrewSkillInfo[] {
  return [
    { name: "react-patterns", description: "React conventions", path: "/home/user/.omp/agent/skills/react-patterns/SKILL.md", source: "user" },
    { name: "testing", description: "Test setup and patterns", path: "/project/.omp/messenger/crew/skills/testing.md", source: "project" },
    { name: "api-design", description: "REST/GraphQL patterns", path: "/ext/crew/skills/api-design.md", source: "extension" },
  ];
}

describe("buildWorkerPrompt - skills section", () => {
  let dirs: TempCrewDirs;

  afterEach(() => {
    delete process.env.OMP_MESSENGER_TEAM_PROFILE_DIR;
  });

  function setupStore(task: Task) {
    const tasksDir = path.join(dirs.cwd, ".omp", "messenger", "crew", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, `${task.id}.json`), JSON.stringify(task));
    fs.writeFileSync(path.join(tasksDir, `${task.id}.md`), "Task spec content");

    const planDir = path.join(dirs.cwd, ".omp", "messenger", "crew");
    fs.writeFileSync(path.join(planDir, "plan.json"), JSON.stringify({
      prd: "test.md",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      task_count: 1,
      completed_count: 0,
    }));
  }

  it("injects bounded Team role, charter, memory, and approval context", () => {
    dirs = createTempCrewDirs();
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(dirs.cwd, "profiles");
    teamStore.useProfile(dirs.cwd, "migration-squad");
    teamStore.writeCharter(dirs.cwd, "migration-squad", "Review risky auth work before edits.");
    teamStore.noteMemory(dirs.cwd, "decision", "Auth middleware owns refresh validation", "AgentOne");
    const task = makeTask({
      role: "worker",
      risk_labels: ["auth"],
      approval: { required: true, status: "pending" },
    });
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], [], teamStore.buildTeamPromptContext(dirs.cwd, task));

    expect(prompt).toContain("Team Context");
    expect(prompt).toContain("Active team: migration-squad");
    expect(prompt).toContain("Team Role");
    expect(prompt).toContain("worker");
    expect(prompt).toContain("Team Charter");
    expect(prompt).toContain("Review risky auth work before edits.");
    expect(prompt).toContain("Team Memory");
    expect(prompt).toContain("Auth middleware owns refresh validation");
    expect(prompt).toContain("Approval Policy");
    expect(prompt).toContain("pending");
  });

  it("gives non-editing Team roles a read-only mission", () => {
    dirs = createTempCrewDirs();
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(dirs.cwd, "profiles");
    teamStore.useProfile(dirs.cwd, "migration-squad");
    const task = makeTask({ role: "scout", depends_on: ["task-0"], skills: ["testing"] });
    setupStore(task);

    const prompt = buildWorkerPrompt(
      task,
      "test.md",
      dirs.cwd,
      makeConfig({ dependencies: "advisory", coordination: "chatty" }),
      [],
      makeSkills(),
      teamStore.buildTeamPromptContext(dirs.cwd, task),
    );

    expect(prompt).toContain("Inspect this task as a read-only Team role");
    expect(prompt).toContain("This is a non-editing Team role. Do not edit files");
    expect(prompt).toContain("what you're investigating");
    expect(prompt).not.toContain("Reserve files");
  });

  it("includes Available Skills section when skills are provided", () => {
    dirs = createTempCrewDirs();
    const task = makeTask();
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], makeSkills());
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("react-patterns");
    expect(prompt).toContain("testing");
    expect(prompt).toContain("api-design");
  });

  it("omits skills section when no skills provided", () => {
    dirs = createTempCrewDirs();
    const task = makeTask();
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), []);
    expect(prompt).not.toContain("Available Skills");
  });

  it("omits skills section when skills array is empty", () => {
    dirs = createTempCrewDirs();
    const task = makeTask();
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], []);
    expect(prompt).not.toContain("Available Skills");
  });

  it("separates recommended and other skills when task has planner-tagged skills", () => {
    dirs = createTempCrewDirs();
    const task = makeTask({ skills: ["testing", "react-patterns"] });
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], makeSkills());
    expect(prompt).toContain("Recommended for this task");
    expect(prompt).toContain("Also available");

    const recIdx = prompt.indexOf("Recommended for this task");
    const alsoIdx = prompt.indexOf("Also available");
    const testingIdx = prompt.indexOf("testing", recIdx);
    const apiIdx = prompt.indexOf("api-design", alsoIdx);
    expect(testingIdx).toBeLessThan(alsoIdx);
    expect(apiIdx).toBeGreaterThan(alsoIdx);
  });

  it("shows all skills without recommended heading when task has no skills tags", () => {
    dirs = createTempCrewDirs();
    const task = makeTask();
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], makeSkills());
    expect(prompt).not.toContain("Recommended for this task");
    expect(prompt).not.toContain("Also available");
    expect(prompt).toContain("react-patterns");
    expect(prompt).toContain("testing");
  });

  it("includes absolute paths for read tool calls", () => {
    dirs = createTempCrewDirs();
    const task = makeTask();
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], makeSkills());
    expect(prompt).toContain("/home/user/.omp/agent/skills/react-patterns/SKILL.md");
    expect(prompt).toContain("/project/.omp/messenger/crew/skills/testing.md");
  });

  it("excludes the orchestrator crew skill from worker prompts", () => {
    dirs = createTempCrewDirs();
    const task = makeTask({ skills: ["pi-messenger-crew", "testing"] });
    setupStore(task);

    const skills = [
      ...makeSkills(),
      { name: "pi-messenger-crew", description: "Crew orchestration reference", path: "/ext/skills/pi-messenger-crew/SKILL.md", source: "extension" as const },
    ];

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], skills);
    expect(prompt).toContain("testing");
    expect(prompt).not.toContain("pi-messenger-crew");
    expect(prompt).not.toContain("/ext/skills/pi-messenger-crew/SKILL.md");
  });

  it("omits the skills section when only orchestrator-only skills are available", () => {
    dirs = createTempCrewDirs();
    const task = makeTask({ skills: ["pi-messenger-crew"] });
    setupStore(task);

    const prompt = buildWorkerPrompt(task, "test.md", dirs.cwd, makeConfig(), [], [
      { name: "pi-messenger-crew", description: "Crew orchestration reference", path: "/ext/skills/pi-messenger-crew/SKILL.md", source: "extension" },
    ]);

    expect(prompt).not.toContain("Available Skills");
    expect(prompt).not.toContain("pi-messenger-crew");
  });
});
