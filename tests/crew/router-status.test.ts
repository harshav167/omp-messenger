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

  it("forwards the requested channels when joining", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);

    const response = await executeCrewAction(
      "join",
      { channels: ["blue"] },
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(mesh.channels()).toEqual(["blue"]);
    expect(response.details.channels).toEqual(["blue"]);
  });

  it("routes channels.join and channels.leave to live membership changes", async () => {
    const { cwd } = createTempCrewDirs();
    const { mesh, state } = createTestMesh(cwd, { agentName: "AgentOne", cwd });
    const ctx = createMockContext(cwd);
    await mesh.join(ctx);

    const joined = await executeCrewAction(
      "channels.join",
      { channels: ["blue"] },
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(joined.details.mode).toBe("channels.join");
    expect(joined.details.channels).toEqual(["blue", "main"]);
    expect(mesh.channels()).toEqual(["blue", "main"]);

    const left = await executeCrewAction(
      "channels.leave",
      { channels: ["blue"] },
      state,
      mesh,
      ctx,
      () => {},
      () => {},
      vi.fn(),
    );

    expect(left.details.mode).toBe("channels.leave");
    expect(left.details.channels).toEqual(["main"]);
    expect(mesh.channels()).toEqual(["main"]);
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
