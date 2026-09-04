import { describe, expect, it, vi } from "vitest";
import { createTestMesh } from "../helpers/mesh.ts";
import { executeCrewAction } from "../../crew/index.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";

describe("crew action router status behavior", () => {
  it("routes action=status to messenger status (not crew status)", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);
    await mesh.join(ctx);

    const response = await executeCrewAction(
      "status",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    const text = response.content[0].text;
    expect(text).toContain("You: AgentOne");
    expect(text).not.toContain("# Crew Status");
  });

  it("routes action=channels to the mesh channel list", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);
    await mesh.join(ctx);

    const response = await executeCrewAction(
      "channels",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(response.details.mode).toBe("channels");
    expect(response.details.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "main", members: 1 }),
    ]));
  });

  it("forwards the requested channel when joining", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    const response = await executeCrewAction(
      "join",
      { channel: "blue" },
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(mesh.channel()).toBe("blue");
    expect(response.details.channel).toBe("blue");
  });

  it("routes action=crew.status to crew status handler", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);
    await mesh.join(ctx);
    const response = await executeCrewAction(
      "crew.status",
      {},
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    const text = response.content[0].text;
    expect(text).toContain("# Crew Status");
  });
});
