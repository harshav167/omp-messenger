import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mesh } from "../../mesh/types.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

const homedirMock = vi.hoisted(() => vi.fn());
const lobbyMock = vi.hoisted(() => {
  let counter = 0;
  return {
    getAvailableLobbyWorkers: vi.fn(() => [] as Array<{ name: string; lobbyId: string }>),
    assignTaskToLobbyWorker: vi.fn(async () => true),
    spawnWorkerForTask: vi.fn(() => {
      counter++;
      return { name: `SpawnedWorker${counter}` };
    }),
    reset: () => { counter = 0; },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: homedirMock };
});

vi.mock("../../crew/lobby.ts", () => ({
  getAvailableLobbyWorkers: lobbyMock.getAvailableLobbyWorkers,
  assignTaskToLobbyWorker: lobbyMock.assignTaskToLobbyWorker,
  spawnWorkerForTask: lobbyMock.spawnWorkerForTask,
}));

vi.mock("../../crew/utils/discover.ts", () => ({
  discoverCrewSkills: vi.fn(() => []),
}));

vi.mock("../../feed.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../feed.ts")>();
  return { ...actual, logFeedEvent: vi.fn() };
});

function writeProjectConfig(crewDir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(crewDir, { recursive: true });
  fs.writeFileSync(path.join(crewDir, "config.json"), JSON.stringify(config, null, 2));
}

describe("spawnWorkersForReadyTasks", () => {
  let dirs: TempCrewDirs;
  let spawn: typeof import("../../crew/spawn.ts");
  let store: typeof import("../../crew/store.ts");
  const stubMesh = {
    send: vi.fn(async () => ({ ok: true })),
    peers: () => [],
    evict: vi.fn(),
  } as unknown as Mesh;

  beforeEach(async () => {
    dirs = createTempCrewDirs();
    homedirMock.mockReturnValue(dirs.root);
    lobbyMock.reset();
    lobbyMock.getAvailableLobbyWorkers.mockReturnValue([]);
    lobbyMock.assignTaskToLobbyWorker.mockResolvedValue(true);
    lobbyMock.spawnWorkerForTask.mockClear();
    lobbyMock.assignTaskToLobbyWorker.mockClear();

    vi.resetModules();
    store = await import("../../crew/store.ts");
    spawn = await import("../../crew/spawn.ts");

    store.createPlan(dirs.cwd, "docs/PRD.md", "Test Plan");
    for (let i = 0; i < 5; i++) {
      store.createTask(dirs.cwd, `Task ${i + 1}`);
    }
  });

  it("respects config.concurrency.max when caller requests more workers", async () => {
    writeProjectConfig(dirs.crewDir, { concurrency: { workers: 1, max: 1 } });

    const result = await spawn.spawnWorkersForReadyTasks(dirs.cwd, 5, stubMesh);

    expect(result.assigned).toBe(1);
    expect(lobbyMock.spawnWorkerForTask).toHaveBeenCalledTimes(1);
  });

  it("uses the caller limit when it is lower than config.concurrency.max", async () => {
    writeProjectConfig(dirs.crewDir, { concurrency: { workers: 2, max: 10 } });

    const result = await spawn.spawnWorkersForReadyTasks(dirs.cwd, 2, stubMesh);

    expect(result.assigned).toBe(2);
    expect(lobbyMock.spawnWorkerForTask).toHaveBeenCalledTimes(2);
  });

  it("caps lobby assignments by config.concurrency.max", async () => {
    writeProjectConfig(dirs.crewDir, { concurrency: { workers: 1, max: 1 } });
    lobbyMock.getAvailableLobbyWorkers.mockReturnValue([
      { name: "Lobby1", lobbyId: "lb-1" },
      { name: "Lobby2", lobbyId: "lb-2" },
    ]);

    const result = await spawn.spawnWorkersForReadyTasks(dirs.cwd, 5, stubMesh);

    expect(result.assigned).toBe(1);
    expect(lobbyMock.assignTaskToLobbyWorker).toHaveBeenCalledTimes(1);
    expect(lobbyMock.spawnWorkerForTask).not.toHaveBeenCalled();
  });
});
