import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMesh } from "../helpers/mesh.ts";
import { executeCrewAction } from "../../crew/index.ts";
import { autonomousState, startAutonomous } from "../../crew/state.ts";
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

describe("crew work.stop action", () => {
  beforeEach(() => {
    resetAutonomousState();
  });

  it("returns no-op message when autonomous is not active for cwd", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    state.registered = true;
    const ctx = createMockContext(cwd);

    const response = await executeCrewAction(
      "work.stop",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.content[0].text).toContain("No autonomous work running for this project.");
    expect(response.details.mode).toBe("work.stop");
  });

  it("stops active autonomous work and persists crew-state", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    state.registered = true;
    const ctx = createMockContext(cwd);
    const appendEntry = vi.fn();

    startAutonomous(cwd, 2);
    expect(autonomousState.active).toBe(true);

    const response = await executeCrewAction(
      "work.stop",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      appendEntry,
    );

    expect(response.content[0].text).toContain("Autonomous work stopped.");
    expect(autonomousState.active).toBe(false);
    expect(autonomousState.stopReason).toBe("manual");
    expect(appendEntry).toHaveBeenCalledWith("crew-state", autonomousState);
  });
});
