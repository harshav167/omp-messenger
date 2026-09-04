import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MessengerState } from "../../lib.ts";
import * as taskHandler from "../../crew/handlers/task.ts";
import * as store from "../../crew/store.ts";
import * as teamStore from "../../crew/team/store.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

function createState(agentName = "Lead"): MessengerState {
  return { agentName } as MessengerState;
}

describe("Team task approval gates", () => {
  afterEach(() => {
    delete process.env.OMP_MESSENGER_TEAM_PROFILE_DIR;
  });

  it("blocks manual start and separates approval-gated ready tasks", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const gated = store.createTask(cwd, "Change auth", "", [], {
      role: "worker",
      risk_labels: ["Auth"],
      approval: { required: true, status: "pending" },
    });

    const start = await taskHandler.execute("start", { id: gated.id }, createState("Worker"), createMockContext(cwd));
    expect(start.details.error).toBe("needs_approval");

    const ready = await taskHandler.execute("ready", {}, createState(), createMockContext(cwd));
    expect(ready.details.ready).toEqual([]);
    expect(ready.details.needsApproval).toEqual([
      { id: gated.id, title: "Change auth", approval: { required: true, status: "pending" } },
    ]);
  });

  it("points newly-created approval-gated tasks at approval", async () => {
    const { cwd } = createTempCrewDirs();
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(cwd, "profiles");
    teamStore.useProfile(cwd, "migration-squad");
    store.createPlan(cwd, "docs/PRD.md");

    const created = await taskHandler.execute(
      "create",
      { title: "Change auth", role: "worker", riskLabels: ["auth"] },
      createState(),
      createMockContext(cwd),
    );

    expect(created.details.task.approval).toEqual({ required: true, status: "pending" });
    expect(created.content[0].text).toContain("Approve first");
  });

  it("canonicalizes known Team roles and rejects unknown active-Team roles", async () => {
    const { cwd } = createTempCrewDirs();
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(cwd, "profiles");
    teamStore.useProfile(cwd, "migration-squad");
    store.createPlan(cwd, "docs/PRD.md");

    const canonical = await taskHandler.execute(
      "create",
      { title: "Inspect auth", role: " Scout ", riskLabels: ["auth"] },
      createState(),
      createMockContext(cwd),
    );
    expect(canonical.details.task.role).toBe("scout");
    expect(canonical.details.task.approval).toBeUndefined();

    const invalid = await taskHandler.execute(
      "create",
      { title: "Typo role", role: "scuot", riskLabels: ["auth"] },
      createState(),
      createMockContext(cwd),
    );
    expect(invalid.details.error).toBe("invalid_role");
  });

  it("shows Team metadata in task list and task details", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const gated = store.createTask(cwd, "Change auth", "", [], {
      role: "worker",
      risk_labels: ["auth"],
      approval: { required: true, status: "pending" },
    });

    const list = await taskHandler.execute("list", {}, createState(), createMockContext(cwd));
    expect(list.content[0].text).toContain("[worker] [risk: auth] [approval: pending]");
    expect(list.details.tasks[0].role).toBe("worker");
    expect(list.details.tasks[0].risk_labels).toEqual(["auth"]);
    expect(list.details.tasks[0].approval).toEqual({ required: true, status: "pending" });

    const show = await taskHandler.execute("show", { id: gated.id }, createState(), createMockContext(cwd));
    expect(show.content[0].text).toContain("[worker] [risk: auth] [approval: pending]");
  });

  it("surfaces rejected tasks as revision work", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const rejected = store.createTask(cwd, "Change auth", "", [], {
      approval: { required: true, status: "rejected", feedback: "needs rollback tests" },
    });

    const start = await taskHandler.execute("start", { id: rejected.id }, createState("Worker"), createMockContext(cwd));
    expect(start.details.error).toBe("needs_revision");

    const ready = await taskHandler.execute("ready", {}, createState(), createMockContext(cwd));
    expect(ready.details.ready).toEqual([]);
    expect(ready.details.needsApproval).toEqual([]);
    expect(ready.details.rejected).toEqual([
      { id: rejected.id, title: "Change auth", approval: { required: true, status: "rejected", feedback: "needs rollback tests" } },
    ]);
    expect(ready.content[0].text).toContain("Rejected tasks need revision");
    expect(ready.content[0].text).toContain('omp_messenger({ action: "task.revise", id: "task-1", prompt: "Address approval feedback" })');
  });

  it("approves gated tasks so they can be started", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const gated = store.createTask(cwd, "Change auth", "", [], {
      approval: { required: true, status: "pending" },
    });

    const approval = await taskHandler.execute("approve", { id: gated.id }, createState("Lead"), createMockContext(cwd));
    expect(approval.details.task.approval.status).toBe("approved");
    expect(approval.details.task.approval.decided_by).toBe("Lead");

    const start = await taskHandler.execute("start", { id: gated.id }, createState("Worker"), createMockContext(cwd));
    expect(start.details.task.status).toBe("in_progress");
  });

  it("clears stale rejection feedback when approving without new feedback", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const gated = store.createTask(cwd, "Change auth", "", [], {
      approval: { required: true, status: "rejected", feedback: "needs tests" },
    });

    const approval = await taskHandler.execute("approve", { id: gated.id }, createState("Lead"), createMockContext(cwd));

    expect(approval.details.task.approval.status).toBe("approved");
    expect(approval.details.task.approval.feedback).toBeUndefined();
  });

  it("rejects approval changes after work starts or finishes", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const active = store.createTask(cwd, "Active auth", "", [], {
      approval: { required: true, status: "approved" },
    });
    store.startTask(cwd, active.id, "Worker");

    const activeReject = await taskHandler.execute("reject", { id: active.id, reason: "too late" }, createState("Lead"), createMockContext(cwd));
    expect(activeReject.details.error).toBe("invalid_status");

    const done = store.createTask(cwd, "Done auth", "", [], {
      approval: { required: true, status: "approved" },
    });
    store.startTask(cwd, done.id, "Worker");
    store.completeTask(cwd, done.id, "Done");

    const doneReject = await taskHandler.execute("reject", { id: done.id, reason: "too late" }, createState("Lead"), createMockContext(cwd));
    expect(doneReject.details.error).toBe("invalid_status");
  });

  it("reports approval-gated tasks unlocked by task completion", async () => {
    const { cwd } = createTempCrewDirs();
    fs.mkdirSync(path.join(cwd, ".omp", "messenger", "crew"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".omp", "messenger", "crew", "config.json"), JSON.stringify({ dependencies: "strict" }));
    store.createPlan(cwd, "docs/PRD.md");
    const first = store.createTask(cwd, "Prepare", "");
    const gated = store.createTask(cwd, "Change auth", "", [first.id], {
      approval: { required: true, status: "pending" },
    });
    store.startTask(cwd, first.id, "Worker");

    const done = await taskHandler.execute("done", { id: first.id, summary: "Done" }, createState("Worker"), createMockContext(cwd));

    expect(done.content[0].text).toContain(`**Needs approval:** ${gated.id}`);
    expect(done.content[0].text).not.toContain(`**Ready tasks:** ${gated.id}`);
  });

  it("splits Team metadata onto subtasks and clears the parent milestone gate", async () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const parent = store.createTask(cwd, "Change auth", "", [], {
      role: "worker",
      risk_labels: ["auth"],
      approval: { required: true, status: "pending" },
    });

    const split = await taskHandler.execute(
      "split",
      { id: parent.id, subtasks: [{ title: "Part one" }, { title: "Part two" }] },
      createState(),
      createMockContext(cwd),
    );

    const subtaskIds = split.details.subtasks.map((task: { id: string }) => task.id);
    for (const subtaskId of subtaskIds) {
      const subtask = store.getTask(cwd, subtaskId);
      expect(subtask?.role).toBe("worker");
      expect(subtask?.risk_labels).toEqual(["auth"]);
      expect(subtask?.approval).toEqual({ required: true, status: "pending" });
    }

    const milestone = store.getTask(cwd, parent.id);
    expect(milestone?.milestone).toBe(true);
    expect(milestone?.role).toBeUndefined();
    expect(milestone?.risk_labels).toBeUndefined();
    expect(milestone?.approval).toBeUndefined();
  });
});
