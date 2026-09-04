import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerState } from "../../lib.ts";
import type { Mesh } from "../../mesh/types.ts";
import { executeCrewAction } from "../../crew/index.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { createTestMesh } from "../helpers/mesh.ts";


describe("team command routing", () => {
  let cwd: string;
  let mesh: Mesh;
  let state: MessengerState;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = path.join(cwd, "profiles");
    ({ mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd }));
    state.registered = true;
  });

  afterEach(() => {
    delete process.env.OMP_MESSENGER_TEAM_PROFILE_DIR;
  });

  async function run(action: string, params: Record<string, unknown> = {}) {
    return executeCrewAction(action, { action, ...params }, state, mesh, createMockContext(cwd), () => {}, () => {}, vi.fn());
  }

  it("sets up a profile and starter charter in one command", async () => {
    const setup = await run("team.setup", { name: "research-squad" });

    expect(setup.details.mode).toBe("team.setup");
    expect(setup.details.charterStatus).toBe("created");
    expect(setup.content[0].text).toContain("Set up Team profile **research-squad**");
    expect(fs.readFileSync(path.join(cwd, ".omp", "messenger", "team", "charter.md"), "utf-8")).toContain("Use the research-squad Team profile");

    const keep = await run("team.setup", { name: "review-squad" });
    expect(keep.details.charterStatus).toBe("kept");
    expect(fs.readFileSync(path.join(cwd, ".omp", "messenger", "team", "charter.md"), "utf-8")).toContain("Use the research-squad Team profile");

    const custom = await run("team.setup", { name: "review-squad", message: "Review first, then apply approved cleanup." });
    expect(custom.details.charterStatus).toBe("updated");
    expect(fs.readFileSync(path.join(cwd, ".omp", "messenger", "team", "charter.md"), "utf-8")).toContain("Review first, then apply approved cleanup.");
  });

  it("routes team commands", async () => {
    const invalid = await run("team.profile.use", { name: "../outside" });
    expect(invalid.details.error).toBe("invalid_name");

    expect((await run("team.setup")).details.mode).toBe("team.setup");
    expect((await run("team.profile.use", { name: "migration-squad" })).details.mode).toBe("team.profile.use");
    expect((await run("team.profile.list")).details.mode).toBe("team.profile.list");
    expect((await run("team.profile.save", { name: "saved-squad" })).details.mode).toBe("team.profile.save");
    expect((await run("team.charter.create", { name: "migration-squad", message: "Ship safely." })).details.mode).toBe("team.charter.create");
    expect((await run("team.charter.show")).details.mode).toBe("team.charter.show");
    expect((await run("team.charter.update", { message: "Prefer reviews." })).details.mode).toBe("team.charter.update");
    expect((await run("team.memory.note", { type: "decision", message: "Use JSON profiles." })).details.mode).toBe("team.memory.note");
    expect((await run("team.memory.list", { type: "decision" })).details.mode).toBe("team.memory.list");
    expect((await run("team.roles")).details.mode).toBe("team.roles");
    expect((await run("team.status")).details.mode).toBe("team.status");
  });

  it("surfaces rejected tasks in team status", async () => {
    const store = await import("../../crew/store.ts");
    store.createPlan(cwd, "docs/PRD.md");
    const rejected = store.createTask(cwd, "Rejected auth", "", [], {
      approval: { required: true, status: "rejected", feedback: "needs rollback tests" },
    });

    const status = await run("team.status");

    expect(status.content[0].text).toContain("Rejected tasks:");
    expect(status.content[0].text).toContain("needs rollback tests");
    expect(status.content[0].text).toContain(`task.revise", id: "${rejected.id}`);
    expect(status.details.rejected).toEqual([
      { id: rejected.id, title: "Rejected auth", approval: { required: true, status: "rejected", feedback: "needs rollback tests" } },
    ]);
  });
});
