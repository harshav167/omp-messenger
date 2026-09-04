import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findAgentClaim } from "../../lib.ts";
import { executeCrewAction } from "../../crew/index.ts";
import { createTestMesh } from "../helpers/mesh.ts";
import * as crewStore from "../../crew/store.ts";
import { readFeedEvents } from "../../feed.ts";
import { autonomousState, planningState, startAutonomous, startPlanningRun, clearPlanningState } from "../../crew/state.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";


function resetAutonomousState(): void {
  autonomousState.active = false;
  autonomousState.cwd = null;
  autonomousState.waveNumber = 0;
  autonomousState.waveHistory = [];
  autonomousState.startedAt = null;
  autonomousState.stoppedAt = null;
  autonomousState.stopReason = null;
  autonomousState.concurrency = 2;
  autonomousState.autoOverlayPending = false;
  autonomousState.pid = null;
}

function resetPlanningState(): void {
  planningState.active = false;
  planningState.cwd = null;
  planningState.runId = null;
  planningState.pass = 0;
  planningState.maxPasses = 0;
  planningState.phase = "idle";
  planningState.updatedAt = null;
  planningState.pid = null;
}


describe("omp_messenger leave action", () => {
  beforeEach(() => {
    resetAutonomousState();
    resetPlanningState();
  });

  it("leaves the mesh, releases reservations, and unclaims the active swarm claim", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state, base } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    await mesh.join(ctx);

    state.reservations = [{ pattern: "src/index.ts", reason: "editing", since: new Date().toISOString() }];
    state.spec = path.join(cwd, "docs", "SPEC.md");
    fs.mkdirSync(path.dirname(state.spec), { recursive: true });
    fs.writeFileSync(state.spec, "# Spec\n");
    mesh.publish(ctx);

    const claim = await mesh.claim(ctx, state.spec, "TASK-1", "working");
    expect(claim.success).toBe(true);

    const response = await executeCrewAction(
      "leave",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.mode).toBe("leave");
    expect(response.content[0].text).toContain("Left omp-messenger.");
    expect(response.content[0].text).toContain("Released reservations: src/index.ts");
    expect(response.content[0].text).toContain("Released claim: TASK-1");
    expect(state.registered).toBe(false);
    expect(state.reservations).toEqual([]);
    expect(fs.existsSync(path.join(base, "registry", `${state.agentName}.json`))).toBe(false);
    expect(findAgentClaim(mesh.claims(), state.agentName)).toBeNull();
    expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("messenger", undefined);

    const events = readFeedEvents(cwd, 10);
    expect(events.map(event => event.type)).toContain("release");
    expect(events.at(-1)?.type).toBe("leave");
  });

  it("refuses to leave while project planning is active", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    await mesh.join(ctx);
    startPlanningRun(cwd, 1);

    const response = await executeCrewAction(
      "leave",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.mode).toBe("leave");
    expect(response.details.error).toBe("planning_active");
    expect(response.content[0].text).toContain("Cannot leave while Crew planning is active");
    expect(state.registered).toBe(true);

    clearPlanningState(cwd);
  });

  it("refuses to leave while autonomous Crew work is active", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    await mesh.join(ctx);
    startAutonomous(cwd, 2);

    const response = await executeCrewAction(
      "leave",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.mode).toBe("leave");
    expect(response.details.error).toBe("autonomous_active");
    expect(response.content[0].text).toContain("Cannot leave while autonomous Crew work is active");
    expect(state.registered).toBe(true);
  });

  it("refuses to leave while this session still owns in-progress Crew tasks", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    await mesh.join(ctx);
    crewStore.createPlan(cwd, "docs/PRD.md");
    const task = crewStore.createTask(cwd, "Implement auth", "Build auth flow");
    crewStore.startTask(cwd, task.id, state.agentName);

    const response = await executeCrewAction(
      "leave",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.mode).toBe("leave");
    expect(response.details.error).toBe("crew_tasks_in_progress");
    expect(response.content[0].text).toContain(`Cannot leave while Crew task assigned to you is still in progress: ${task.id}`);
    expect(state.registered).toBe(true);
  });

  it("does not partially leave when active claim release throws", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state, base } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    await mesh.join(ctx);
    const reservation = { pattern: "src/index.ts", since: new Date().toISOString() };
    state.reservations = [reservation];
    state.spec = path.join(cwd, "docs", "SPEC.md");
    fs.mkdirSync(path.dirname(state.spec), { recursive: true });
    fs.writeFileSync(state.spec, "# Spec\n");
    mesh.publish(ctx);

    const claim = await mesh.claim(ctx, state.spec, "TASK-1");
    expect(claim.success).toBe(true);

    const unclaimSpy = vi.spyOn(mesh, "unclaim").mockRejectedValue(new Error("lock busy"));

    const response = await executeCrewAction(
      "leave",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.mode).toBe("leave");
    expect(response.details.error).toBe("unclaim_failed");
    expect(response.content[0].text).toContain("could not be released: lock busy");
    expect(state.registered).toBe(true);
    expect(state.reservations).toEqual([reservation]);
    expect(findAgentClaim(mesh.claims(), state.agentName)?.taskId).toBe("TASK-1");
    expect(fs.existsSync(path.join(base, "registry", `${state.agentName}.json`))).toBe(true);

    unclaimSpy.mockRestore();
  });

  it("returns an error when unregister fails instead of reporting a successful leave", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    await mesh.join(ctx);

    const unregisterSpy = vi.spyOn(mesh, "leave").mockRejectedValue(new Error("disk busy"));

    const response = await executeCrewAction(
      "leave",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.mode).toBe("leave");
    expect(response.details.error).toBe("unregister_failed");
    expect(response.content[0].text).toContain("Could not leave omp-messenger: disk busy");
    expect(state.registered).toBe(true);

    unregisterSpy.mockRestore();
  });

  it("can rejoin later from the same session after leaving", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state, base } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    await mesh.join(ctx);

    const leaveResponse = await executeCrewAction(
      "leave",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );
    expect(leaveResponse.details.mode).toBe("leave");
    expect(state.registered).toBe(false);

    const joinResponse = await executeCrewAction(
      "join",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(joinResponse.details.mode).toBe("join");
    expect(state.registered).toBe(true);
    expect(state.agentName).toBe("AgentOne");
    expect(fs.existsSync(path.join(base, "registry", `${state.agentName}.json`))).toBe(true);
  });
});
