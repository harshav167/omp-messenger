import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-tui", () => ({
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
import type { Task } from "../../crew/types.ts";
import { buildTeamPromptContext, taskNeedsApproval } from "../../crew/team/store.ts";
import { buildWorkerPrompt } from "../../crew/prompt.ts";
import { loadCrewConfig } from "../../crew/utils/config.ts";
import { executeCrewAction } from "../../crew/index.ts";
import { renderStatusBar, renderTaskList } from "../../overlay-render.ts";
import { createCrewViewState } from "../../overlay-actions.ts";
import type { MessengerState } from "../../lib.ts";
import type { Mesh } from "../../mesh/types.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { createTestMesh } from "../helpers/mesh.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

const pendingScoutTask = {
  id: "task-1",
  title: "Inspect",
  status: "todo",
  role: "scout",
  approval: { required: true, status: "pending" },
  depends_on: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  attempt_count: 0,
} satisfies Task;

describe("disabled Team layer", () => {
  let cwd: string;
  let crewDir: string;
  let mesh: Mesh;
  let state: MessengerState;

  beforeEach(() => {
    ({ cwd, crewDir } = createTempCrewDirs());
    fs.writeFileSync(path.join(crewDir, "config.json"), JSON.stringify({ team: { enabled: false } }));
    ({ mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd }));
    state.registered = true;
  });

  it("rejects Team actions without creating Team state when Team is disabled", async () => {
    const response = await executeCrewAction(
      "team.setup",
      {},
      state,
      mesh,
      createMockContext(cwd),
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.error).toBe("team_disabled");
    expect(fs.existsSync(path.join(cwd, ".pi", "messenger", "team"))).toBe(false);
  });

  it("ignores pending approval metadata when Team is disabled", () => {
    expect(taskNeedsApproval(cwd, pendingScoutTask)).toBe(false);
  });

  it("honors pending approval metadata when Team is enabled", () => {
    fs.writeFileSync(path.join(crewDir, "config.json"), JSON.stringify({ team: { enabled: true } }));
    expect(taskNeedsApproval(cwd, pendingScoutTask)).toBe(true);
  });

  it("does not apply stale Team role metadata to worker prompts when Team is disabled", () => {
    const prompt = buildWorkerPrompt(
      pendingScoutTask,
      "PRD.md",
      cwd,
      loadCrewConfig(crewDir),
      [],
      [],
      buildTeamPromptContext(cwd, pendingScoutTask),
    );

    expect(prompt).not.toContain("Active Team");
    expect(prompt).not.toContain("read-only Team role");
  });

  it("hides stale Team state from the status bar when Team is disabled", () => {
    const teamDir = path.join(cwd, ".pi", "messenger", "team");
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, "team.json"), JSON.stringify({
      name: "migration-squad",
      profile: "migration-squad",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }));

    const status = renderStatusBar(createMockContext(cwd).ui.theme, cwd, 200);

    expect(status).not.toContain("Team:");
  });

  it("hides stale Team metadata from task rows when Team is disabled", () => {
    const rendered = renderTaskList(createMockContext(cwd).ui.theme, cwd, 200, 10, createCrewViewState(), [pendingScoutTask]).join("\n");

    expect(rendered).not.toContain("[scout]");
    expect(rendered).not.toContain("[pending]");
  });

  it("drops inherited Team metadata when splitting tasks while Team is disabled", async () => {
    fs.writeFileSync(path.join(crewDir, "plan.json"), JSON.stringify({
      prd: "PRD.md",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      task_count: 1,
      completed_count: 0,
    }));
    fs.writeFileSync(path.join(crewDir, "tasks", "task-1.json"), JSON.stringify({
      id: "task-1",
      title: "Parent",
      status: "todo",
      role: "scout",
      risk_labels: ["auth"],
      approval: { required: true, status: "pending" },
      depends_on: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      attempt_count: 0,
    } satisfies Task));

    await executeCrewAction(
      "task.split",
      { id: "task-1", subtasks: [{ title: "First" }, { title: "Second" }] },
      state,
      mesh,
      createMockContext(cwd),
      () => {},
      () => {},
      vi.fn(),
    );

    for (const taskId of ["task-2", "task-3"]) {
      const task: unknown = JSON.parse(fs.readFileSync(path.join(crewDir, "tasks", `${taskId}.json`), "utf-8"));
      expect(task).not.toHaveProperty("role");
      expect(task).not.toHaveProperty("risk_labels");
      expect(task).not.toHaveProperty("approval");
    }
  });

  it("rejects task approval actions when Team is disabled", async () => {
    const response = await executeCrewAction(
      "task.approve",
      { id: "task-1" },
      state,
      mesh,
      createMockContext(cwd),
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details).toMatchObject({ mode: "task.approve", error: "team_disabled" });
  });

  it("drops Team metadata when creating tasks while Team is disabled", async () => {
    fs.writeFileSync(path.join(crewDir, "plan.json"), JSON.stringify({
      prd: "PRD.md",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      task_count: 0,
      completed_count: 0,
    }));

    const response = await executeCrewAction(
      "task.create",
      {
        title: "Implement",
        role: "scout",
        riskLabels: ["auth"],
        approval: { required: true, status: "pending" },
      },
      state,
      mesh,
      createMockContext(cwd),
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.task).toMatchObject({ role: undefined, risk_labels: undefined, approval: undefined });
  });
});
