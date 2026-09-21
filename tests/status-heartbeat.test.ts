import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
vi.mock("typebox", () => ({
  Type: {
    Unsafe: (schema: unknown) => schema,
    Optional: (schema: unknown) => schema,
    String: (schema: unknown) => schema,
    Number: (schema: unknown) => schema,
    Boolean: (schema: unknown) => schema,
    Any: (schema: unknown) => schema,
    Array: (schema: unknown) => schema,
    Object: (schema: unknown) => schema,
  },
}));

function createMockPi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const tools: any[] = [];

  return {
    handlers,
    tools,
    on: vi.fn((event: string, handler: (event: unknown, ctx: any) => unknown) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }),
    registerTool: vi.fn((tool: any) => {
      tools.push(tool);
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

function createEventContext(cwd: string, hasUI: () => boolean) {
  return {
    cwd,
    get hasUI() {
      return hasUI();
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "test-session",
    },
    model: { id: "test-model" },
  } as any;
}

async function loadExtension() {
  const pi = createMockPi();
  const { default: piMessengerExtension } = await import("../index.ts");
  piMessengerExtension(pi as any);
  return pi;
}

describe("status heartbeat", () => {
  const tempHomes: string[] = [];
  const tempCwds: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-home-"));
    tempHomes.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("OMP_MESSENGER_DIR", path.join(home, ".omp", "agent", "messenger"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const cwd of tempCwds) {
      fs.rmSync(cwd, { force: true, recursive: true });
    }
    for (const home of tempHomes) {
      fs.rmSync(home, { force: true, recursive: true });
    }
    tempCwds.length = 0;
    tempHomes.length = 0;
  });

  it("stops the heartbeat when a captured context becomes stale and restarts when a fresh tool context arrives", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    const pi = await loadExtension();
    const sessionStart = pi.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeTruthy();

    let stale = false;
    let staleCtxReads = 0;
    const staleCtx = createEventContext(cwd, () => {
      staleCtxReads += 1;
      if (stale) {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
      return false;
    });

    await sessionStart?.({}, staleCtx);
    staleCtxReads = 0;
    stale = true;

    vi.advanceTimersByTime(15_000);
    expect(staleCtxReads).toBe(1);

    vi.advanceTimersByTime(30_000);
    expect(staleCtxReads).toBe(1);

    const tool = pi.tools.find(tool => tool.name === "omp_messenger");
    expect(tool).toBeTruthy();

    let freshCtxReads = 0;
    const freshCtx = createEventContext(cwd, () => {
      freshCtxReads += 1;
      return false;
    });

    await tool.execute("tool-call", { action: "status" }, new AbortController().signal, undefined, freshCtx);
    vi.advanceTimersByTime(15_000);

    expect(freshCtxReads).toBeGreaterThan(0);
  });

  it("wakes the configured coordinator once when a peer becomes stuck", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".omp", "omp-messenger.json"),
      JSON.stringify({
        autoRegister: true,
        stuckNotify: true,
        stuckThreshold: 60,
        stuckWakeAgent: "project-manager",
      })
    );
    vi.stubEnv("OMP_AGENT_NAME", "project-manager");

    const base = process.env.OMP_MESSENGER_DIR;
    expect(base).toBeTruthy();
    const registry = path.join(base ?? "", "registry");
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(
      path.join(registry, "s1-data.json"),
      JSON.stringify({
        name: "s1-data",
        pid: process.pid,
        cwd,
        model: "test-model",
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        isHuman: false,
        session: { toolCalls: 1, tokens: 1, filesModified: [] },
        activity: { lastActivityAt: new Date(Date.now() - 120_000).toISOString() },
        reservations: ["packages/data"],
      })
    );

    const pi = await loadExtension();
    const sessionStart = pi.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeTruthy();

    const ctx = createEventContext(cwd, () => true);
    await sessionStart?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalled();

    const stuckWakeCalls = pi.sendMessage.mock.calls.filter(
      ([message]) => message.customType === "agent_stuck"
    );
    expect(stuckWakeCalls).toHaveLength(1);
    expect(stuckWakeCalls[0]?.[1]).toMatchObject({
      deliverAs: "steer",
      triggerTurn: true,
    });

    vi.advanceTimersByTime(30_000);
    const repeatedCalls = pi.sendMessage.mock.calls.filter(
      ([message]) => message.customType === "agent_stuck"
    );
    expect(repeatedCalls).toHaveLength(1);
  });

  it("does not swallow non-stale status update errors", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".omp", "omp-messenger.json"), JSON.stringify({ autoRegister: true }));

    const pi = await loadExtension();
    const sessionStart = pi.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeTruthy();

    const ctx = createEventContext(cwd, () => true);
    ctx.ui.setStatus.mockImplementation(() => {
      throw new Error("status render failed");
    });

    await expect(sessionStart?.({}, ctx)).rejects.toThrow("status render failed");
  });
});
