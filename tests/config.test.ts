import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "./helpers/temp-dirs.ts";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function loadConfigModule() {
  vi.resetModules();
  return import("../config.ts");
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe("config autoOverlayPlanning", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(path.join(dirs.root, ".omp-home"));
  });

  it("defaults autoOverlayPlanning to true", async () => {
    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);
    expect(cfg.autoOverlayPlanning).toBe(true);
  });

  it("applies project override for autoOverlayPlanning", async () => {
    const homeDir = path.join(dirs.root, ".omp-home");
    writeJson(path.join(homeDir, ".omp", "agent", "omp-messenger.json"), {
      autoOverlayPlanning: true,
    });
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      autoOverlayPlanning: false,
    });

    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);

    expect(cfg.autoOverlayPlanning).toBe(false);
  });

  it("defaults stuckWakeAgent to null", async () => {
    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);
    expect(cfg.stuckWakeAgent).toBeNull();
  });

  it("applies project stuckWakeAgent", async () => {
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      stuckWakeAgent: "project-manager",
    });

    const { loadConfig } = await loadConfigModule();
    const cfg = loadConfig(dirs.cwd);
    expect(cfg.stuckWakeAgent).toBe("project-manager");
  });

});

describe("mesh config", () => {
  const originalMeshUrl = process.env.OMP_MESSENGER_MESH_URL;
  const originalMeshToken = process.env.OMP_MESSENGER_MESH_TOKEN;
  const originalX = process.env.X;
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(path.join(dirs.root, ".omp-home"));
    delete process.env.OMP_MESSENGER_MESH_URL;
    delete process.env.OMP_MESSENGER_MESH_TOKEN;
    delete process.env.X;
  });

  afterEach(() => {
    if (originalMeshUrl === undefined) delete process.env.OMP_MESSENGER_MESH_URL;
    else process.env.OMP_MESSENGER_MESH_URL = originalMeshUrl;
    if (originalMeshToken === undefined) delete process.env.OMP_MESSENGER_MESH_TOKEN;
    else process.env.OMP_MESSENGER_MESH_TOKEN = originalMeshToken;
    if (originalX === undefined) delete process.env.X;
    else process.env.X = originalX;
  });

  it("uses filesystem defaults when mesh config is absent", async () => {
    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh).toEqual({
      url: null,
      token: "",
      channel: "main",
    });
  });

  it("resolves an environment-indirected token", async () => {
    process.env.X = "abc";
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { url: "ws://h:1", token: "$X", channel: "repo-a" },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh).toEqual({
      url: "ws://h:1",
      token: "abc",
      channel: "repo-a",
    });
  });

  it("prefers the mesh URL environment variable", async () => {
    process.env.OMP_MESSENGER_MESH_URL = "ws://env:2";
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { url: "ws://file:1", token: "t", channel: "main" },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.url).toBe("ws://env:2");
  });

  it("falls back to main for an invalid channel", async () => {
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { channel: "Bad Name" },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.channel).toBe("main");
  });
});
