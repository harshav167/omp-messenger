import { describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));

import { renderMeshPanel, renderStatusBar } from "../overlay-render.ts";
import { LOCAL_HOST_ID } from "../lib.ts";
import type { Mesh, MeshPeer } from "../mesh/types.ts";
import { createTestMesh } from "./helpers/mesh.ts";
import { createTempCrewDirs } from "./helpers/temp-dirs.ts";
import { createMockContext } from "./helpers/mock-context.ts";

function peer(overrides: Partial<MeshPeer>): MeshPeer {
  const now = new Date().toISOString();
  return {
    name: "Beta",
    pid: 1,
    hostId: "laptop-b",
    sessionId: "s",
    cwd: "/work/repo",
    model: "m",
    startedAt: now,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now },
    channels: ["repo-a"],
    ...overrides,
  };
}

function fakeMesh(peers: MeshPeer[], kind: "fs" | "mesh" = "mesh", channels = ["repo-a"]): Mesh {
  return {
    kind,
    status: () => (kind === "mesh" ? "connected" : "local"),
    channels: () => channels,
    peers: () => peers,
    claims: () => ({}),
  } as unknown as Mesh;
}

describe("renderMeshPanel", () => {
  it("shows server, channel, self, and remote peers with host and reservations", () => {
    const { cwd } = createTempCrewDirs();
    const { state } = createTestMesh(cwd, { agentName: "Alpha", cwd });
    const theme = createMockContext(cwd).ui.theme;
    const mesh = fakeMesh([
      peer({ name: "Beta", reservations: [{ pattern: "src/x.ts", since: new Date().toISOString() }] }),
      peer({ name: "Gamma", hostId: LOCAL_HOST_ID, statusMessage: "reviewing" }),
    ]);

    const text = renderMeshPanel(theme, state, mesh, "ws://192.168.1.9:8765", 900_000, 200, 12).join("\n");

    expect(text).toContain("ws://192.168.1.9:8765");
    expect(text).toContain("connected");
    expect(text).toContain("#repo-a");
    expect(text).toContain("Alpha");
    expect(text).toContain("Peers (2)");
    expect(text).toContain("Beta");
    expect(text).toContain("@laptop-b");
    expect(text).toContain("reserved: src/x.ts");
    expect(text).toContain("Gamma");
    expect(text).not.toContain(`@${LOCAL_HOST_ID}`);
    expect(text).toContain("reviewing");
    expect(text).not.toContain("Crew agents:");
  });

  it("tags peers with their shared channels when joined to more than one", () => {
    const { cwd } = createTempCrewDirs();
    const { state } = createTestMesh(cwd, { agentName: "Alpha", cwd, channels: ["main", "blue"] });
    const theme = createMockContext(cwd).ui.theme;
    const mesh = fakeMesh([
      peer({ name: "Beta", channels: ["main", "blue"] }),
      peer({ name: "Gamma", hostId: LOCAL_HOST_ID, channels: ["blue"] }),
    ], "mesh", ["main", "blue"]);

    const text = renderMeshPanel(theme, state, mesh, "ws://h:1", 900_000, 200, 12).join("\n");

    expect(text).toContain("#main");
    expect(text).toContain("#blue");
    expect(text).toMatch(/Beta.*#main.*#blue/);
    expect(text).toMatch(/Gamma.*#blue/);
    expect(text).not.toMatch(/Gamma[^\n]*#main/);
  });

  it("explains an empty local mesh and points at the config key", () => {
    const { cwd } = createTempCrewDirs();
    const { state } = createTestMesh(cwd, { agentName: "Alpha", cwd });
    const theme = createMockContext(cwd).ui.theme;

    const text = renderMeshPanel(theme, state, fakeMesh([], "fs"), null, 900_000, 200, 12).join("\n");

    expect(text).toContain("local filesystem");
    expect(text).toContain("c to connect a server");
    expect(text).toContain("No peers in your channels yet.");
  });
});

describe("renderStatusBar without a plan", () => {
  it("summarises the mesh instead of the crew", () => {
    const { cwd } = createTempCrewDirs();
    const theme = createMockContext(cwd).ui.theme;

    const line = renderStatusBar(theme, cwd, 200, undefined, { kind: "mesh", status: "connected", channels: ["repo-a"], peerCount: 2 });

    expect(line).toContain("⚡ connected");
    expect(line).toContain("#repo-a");
    expect(line).toContain("2 peers");
    expect(line).not.toContain("No active plan");
  });

  it("joins every joined channel into the status bar", () => {
    const { cwd } = createTempCrewDirs();
    const theme = createMockContext(cwd).ui.theme;

    const line = renderStatusBar(theme, cwd, 200, undefined, { kind: "mesh", status: "connected", channels: ["main", "blue"], peerCount: 3 });

    expect(line).toContain("#main,blue");
  });
});
