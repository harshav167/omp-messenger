import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autonomousState,
  isPendingAutoWork,
  setPendingAutoWork,
  consumePendingAutoWork,
  startAutonomous,
} from "../../crew/state.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));

const executeCrewAction = vi.hoisted(() => vi.fn());
vi.mock("../../crew/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crew/index.ts")>();
  return { ...actual, executeCrewAction };
});

function createMockPi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();

  return {
    pi: { getAgentDir: () => path.join(process.env.HOME ?? os.homedir(), ".omp", "agent") },
    zod,
    handlers,
    on: vi.fn((event: string, handler: (event: unknown, ctx: any) => unknown) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

function createEventContext(cwd: string, sessionFile?: string) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "test-session",
      getSessionFile: () => sessionFile,
    },
    model: { id: "test-model" },
  } as any;
}

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

describe("agent_end autonomous continuation guards", () => {
  const tempHomes: string[] = [];

  beforeEach(() => {
    executeCrewAction.mockReset();
    resetAutonomousState();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-home-"));
    tempHomes.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("OMP_MESSENGER_DIR", path.join(home, ".omp", "agent", "messenger"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const home of tempHomes) {
      fs.rmSync(home, { force: true, recursive: true });
    }
    tempHomes.length = 0;
  });

  it("stops restored autonomous state when session is not registered", async () => {
    const { cwd } = createTempCrewDirs();
    const ctx = createEventContext(cwd);
    const pi = createMockPi();
    const { default: piMessengerExtension } = await import("../../index.ts");
    piMessengerExtension(pi as any);

    const agentEndHandler = pi.handlers.get("agent_end")?.[0];
    expect(agentEndHandler).toBeTruthy();

    startAutonomous(cwd, 2);
    expect(autonomousState.active).toBe(true);

    await agentEndHandler?.({}, ctx);

    expect(autonomousState.active).toBe(false);
    expect(autonomousState.stopReason).toBe("manual");
    expect(pi.appendEntry).toHaveBeenCalledWith("crew-state", autonomousState);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["willContinue", "awaitingAsyncWork"])(
    "does not consume autonomous state while %s is true",
    async (flag) => {
      const { cwd } = createTempCrewDirs();
      const ctx = createEventContext(cwd);
      const pi = createMockPi();
      // Load after the mocked runtime modules are installed.
      const { default: piMessengerExtension } = await import("../../index.ts");
      piMessengerExtension(pi as unknown as Parameters<typeof piMessengerExtension>[0]);
      startAutonomous(cwd, 2);

      await pi.handlers.get("agent_end")?.[0]?.({ [flag]: true }, ctx);

      expect(autonomousState.active).toBe(true);
      expect(pi.appendEntry).not.toHaveBeenCalled();
      expect(pi.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["willContinue", "awaitingAsyncWork"])(
    "leaves pending plan work intact while %s is true",
    async (flag) => {
      const { cwd } = createTempCrewDirs();
      fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, ".omp", "omp-messenger.json"),
        JSON.stringify({ autoRegister: true }),
      );
      const ctx = createEventContext(cwd);
      const pi = createMockPi();
      // Load after the mocked runtime modules are installed.
      const { default: piMessengerExtension } = await import("../../index.ts");
      piMessengerExtension(pi as unknown as Parameters<typeof piMessengerExtension>[0]);
      await pi.handlers.get("session_start")?.[0]?.({}, ctx);
      setPendingAutoWork(cwd);
      await pi.handlers.get("agent_end")?.[0]?.({ [flag]: true }, ctx);
      expect(isPendingAutoWork()).toBe(true);
      consumePendingAutoWork();
      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );

  it.each(["session_switch", "session_branch"])(
    "ends this session's restored autonomous state on %s",
    async (eventName) => {
      const { cwd } = createTempCrewDirs();
      const ctx = createEventContext(cwd);
      ctx.agent = { kind: "main", id: "Main" };
      startAutonomous(cwd, 2);
      const saved = { ...autonomousState };
      ctx.sessionManager.getEntries = () => [
        { type: "custom", customType: "crew-state", data: saved },
      ];
      const pi = createMockPi();
      // Load after the mocked runtime modules are installed.
      const { default: extension } = await import("../../index.ts");
      extension(pi as unknown as Parameters<typeof extension>[0]);
      await pi.handlers.get("session_start")?.[0]?.({}, ctx);
      await pi.handlers.get(eventName)?.[0]?.({}, ctx);
      expect(autonomousState.active).toBe(false);
      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );

  it("does not stop a main autonomous run from a non-crew subagent", async () => {
    const { cwd } = createTempCrewDirs();
    const ctx = createEventContext(cwd);
    ctx.agent = { kind: "sub", id: "child" };
    const pi = createMockPi();
    // Load after the mocked runtime modules are installed.
    const { default: piMessengerExtension } = await import("../../index.ts");
    piMessengerExtension(pi as unknown as Parameters<typeof piMessengerExtension>[0]);
    startAutonomous(cwd, 2);
    await pi.handlers.get("agent_end")?.[0]?.({}, ctx);
    await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    expect(autonomousState.active).toBe(true);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("skips autonomous continuation handling inside worker sessions", async () => {
    const { cwd } = createTempCrewDirs();
    const workerSessionFile = path.join(
      cwd,
      ".omp",
      "messenger",
      "crew",
      "artifacts",
      "OakBear.jsonl",
    );
    const ctx = createEventContext(cwd, workerSessionFile);
    const pi = createMockPi();
    const { default: piMessengerExtension } = await import("../../index.ts");
    piMessengerExtension(pi as any);

    const sessionStartHandler = pi.handlers.get("session_start")?.[0];
    const agentEndHandler = pi.handlers.get("agent_end")?.[0];
    expect(sessionStartHandler).toBeTruthy();
    expect(agentEndHandler).toBeTruthy();

    await sessionStartHandler?.({ type: "session_start" }, ctx);
    pi.sendMessage.mockClear();
    pi.appendEntry.mockClear();
    startAutonomous(cwd, 2);

    await agentEndHandler?.({}, ctx);

    expect(autonomousState.active).toBe(true);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["session_switch", "session_branch"])(
    "aborts the in-flight crew action owner signal on %s",
    async (eventName) => {
      const { cwd } = createTempCrewDirs();
      const ctx = createEventContext(cwd);
      ctx.agent = { kind: "main", id: "Main" };
      const pi = createMockPi();
      const { default: extension } = await import("../../index.ts");
      extension(pi as unknown as Parameters<typeof extension>[0]);
      await pi.handlers.get("session_start")?.[0]?.({}, ctx);

      const first = Promise.withResolvers<unknown>();
      executeCrewAction.mockReturnValueOnce(first.promise);
      const tool = pi.registerTool.mock.calls[0]?.[0];
      const running = tool.execute(
        "call-1",
        { action: "review", target: "task-1" },
        undefined,
        undefined,
        ctx,
      );
      const firstOwnerSignal = executeCrewAction.mock.calls[0]?.[8]?.ownerSignal as AbortSignal;
      expect(firstOwnerSignal.aborted).toBe(false);

      await pi.handlers.get(eventName)?.[0]?.({}, ctx);
      expect(firstOwnerSignal.aborted).toBe(true);
      first.resolve({ content: [{ type: "text", text: "cancelled" }] });
      await running;

      executeCrewAction.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
      await tool.execute(
        "call-2",
        { action: "review", target: "task-1" },
        undefined,
        undefined,
        ctx,
      );
      const nextOwnerSignal = executeCrewAction.mock.calls[1]?.[8]?.ownerSignal as AbortSignal;
      expect(nextOwnerSignal).not.toBe(firstOwnerSignal);
      expect(nextOwnerSignal.aborted).toBe(false);
      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );
});
