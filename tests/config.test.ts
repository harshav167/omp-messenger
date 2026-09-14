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
  const originalMeshChannels = process.env.OMP_MESSENGER_MESH_CHANNELS;
  const originalX = process.env.X;
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(path.join(dirs.root, ".omp-home"));
    delete process.env.OMP_MESSENGER_MESH_URL;
    delete process.env.OMP_MESSENGER_MESH_TOKEN;
    delete process.env.OMP_MESSENGER_MESH_CHANNELS;
    delete process.env.X;
  });

  afterEach(() => {
    if (originalMeshUrl === undefined) delete process.env.OMP_MESSENGER_MESH_URL;
    else process.env.OMP_MESSENGER_MESH_URL = originalMeshUrl;
    if (originalMeshToken === undefined) delete process.env.OMP_MESSENGER_MESH_TOKEN;
    else process.env.OMP_MESSENGER_MESH_TOKEN = originalMeshToken;
    if (originalMeshChannels === undefined) delete process.env.OMP_MESSENGER_MESH_CHANNELS;
    else process.env.OMP_MESSENGER_MESH_CHANNELS = originalMeshChannels;
    if (originalX === undefined) delete process.env.X;
    else process.env.X = originalX;
  });

  it("uses filesystem defaults when mesh config is absent", async () => {
    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh).toEqual({
      url: null,
      token: "",
      channels: ["main"],
    });
  });

  it("resolves an environment-indirected token", async () => {
    process.env.X = "abc";
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { url: "ws://h:1", token: "$X", channels: ["repo-a"] },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh).toEqual({
      url: "ws://h:1",
      token: "abc",
      channels: ["repo-a"],
    });
  });

  it("prefers the mesh URL environment variable", async () => {
    process.env.OMP_MESSENGER_MESH_URL = "ws://env:2";
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { url: "ws://file:1", token: "t", channels: ["main"] },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.url).toBe("ws://env:2");
  });

  it("accepts a comma-separated channel string", async () => {
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { channels: "blue,main" },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.channels).toEqual(["blue", "main"]);
  });

  it("reads the legacy singular channel string", async () => {
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { channel: "repo-legacy" },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.channels).toEqual(["repo-legacy"]);
  });

  it("drops invalid entries from the channel list", async () => {
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { channels: ["Bad Name", "blue"] },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.channels).toEqual(["blue"]);
  });

  it("falls back to main when every configured channel is invalid", async () => {
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { channel: "Bad Name" },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.channels).toEqual(["main"]);
  });

  it("lets OMP_MESSENGER_MESH_CHANNELS override the configured channels", async () => {
    process.env.OMP_MESSENGER_MESH_CHANNELS = "env-a,env-b";
    writeJson(path.join(dirs.cwd, ".omp", "omp-messenger.json"), {
      mesh: { channels: ["file"] },
    });

    const { loadConfig } = await loadConfigModule();
    expect(loadConfig(dirs.cwd).mesh.channels).toEqual(["env-a", "env-b"]);
  });

  it("round-trips mesh settings through the user config and token file", async () => {
    const { saveMeshSettings, getStoredMeshSettings, loadConfig } = await loadConfigModule();
    const home = path.join(dirs.root, ".omp-home");

    saveMeshSettings({ url: "ws://192.168.1.9:8765", token: "secret-1", channels: ["repo-b", "repo-a", "repo-a"] });

    const stored = JSON.parse(fs.readFileSync(path.join(home, ".omp", "agent", "omp-messenger.json"), "utf-8"));
    expect(stored.mesh).toEqual({ url: "ws://192.168.1.9:8765", channels: ["repo-a", "repo-b"] });
    const tokenPath = path.join(home, ".omp", "agent", "messenger", "mesh.token");
    expect(fs.readFileSync(tokenPath, "utf-8")).toBe("secret-1\n");
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(getStoredMeshSettings()).toEqual({ url: "ws://192.168.1.9:8765", token: "secret-1", channels: ["repo-a", "repo-b"] });
    expect(loadConfig(dirs.cwd).mesh).toEqual({ url: "ws://192.168.1.9:8765", token: "secret-1", channels: ["repo-a", "repo-b"] });

    saveMeshSettings({ url: "", token: "", channels: ["main"] });
    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(loadConfig(dirs.cwd).mesh).toEqual({ url: null, token: "", channels: ["main"] });
  });

  it("reads the legacy channel key in stored mesh settings", async () => {
    const { getStoredMeshSettings } = await loadConfigModule();
    const home = path.join(dirs.root, ".omp-home");
    writeJson(path.join(home, ".omp", "agent", "omp-messenger.json"), {
      mesh: { url: "ws://h:1", channel: "repo-legacy" },
    });

    expect(getStoredMeshSettings().channels).toEqual(["repo-legacy"]);
  });
});
