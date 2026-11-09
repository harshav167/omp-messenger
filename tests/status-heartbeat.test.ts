import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));

function createMockPi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const tools: any[] = [];

  return {
    pi: { getAgentDir: () => path.join(process.env.HOME ?? os.homedir(), ".omp", "agent") },
    zod,
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
    registerCommand: vi.fn((_name: string, _command: unknown) => {}),
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

  it("does not access the crew SDK until a crew operation needs it", async () => {
    const pi = createMockPi();
    const host = pi.pi;
    pi.pi = new Proxy(host, {
      get(target, property, receiver) {
        if (property === "getAgentDir") return Reflect.get(target, property, receiver);
        throw new Error("Crew SDK unavailable");
      },
    });
    // Load after the mocked runtime modules are installed.
    const { default: extension } = await import("../index.ts");
    expect(() => extension(pi as unknown as Parameters<typeof extension>[0])).not.toThrow();
  });

  it("opens configuration for the string argument to /messenger", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    const pi = await loadExtension();
    const command = pi.registerCommand.mock.calls.find(([name]) => name === "messenger")?.[1] as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    const ctx = createEventContext(cwd, () => true);
    await command.handler("config", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("refuses model overrides and classifies approval by action", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    const pi = await loadExtension();
    const tool = pi.tools.find((tool) => tool.name === "omp_messenger");
    const result = await tool.execute(
      "call",
      { action: "work", model: "other/model" },
      undefined,
      undefined,
      createEventContext(cwd, () => false),
    );
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("per_call_model_unsupported");
    expect(tool.approval({ action: "status" })).toBe("read");
    expect(tool.approval({ action: "send" })).toBe("write");
    expect(tool.approval({ action: "work" })).toBe("exec");
  });

  it("queues registration context for the next turn without starting one", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".omp", "omp-messenger.json"),
      JSON.stringify({ autoRegister: true, registrationContext: true }),
    );
    const pi = await loadExtension();
    await pi.handlers.get("session_start")?.[0]?.(
      {},
      createEventContext(cwd, () => false),
    );
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "messenger_context", display: false }),
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
  });

  it("blocks edits and writes targeting a peer reservation across supported tool payloads", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".omp", "omp-messenger.json"),
      JSON.stringify({ autoRegister: true }),
    );
    vi.stubEnv("OMP_AGENT_NAME", "Self");
    const registry = path.join(process.env.OMP_MESSENGER_DIR!, "registry");
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(
      path.join(registry, "Peer.json"),
      JSON.stringify({
        name: "Peer",
        pid: process.pid,
        cwd,
        model: "test",
        startedAt: new Date().toISOString(),
        reservations: [{ pattern: "src/locked.ts" }],
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      }),
    );
    const pi = await loadExtension();
    const ctx = createEventContext(cwd, () => false);
    await pi.handlers.get("session_start")?.[0]?.({}, ctx);
    const guard = pi.handlers.get("tool_call")?.[1];
    for (const event of [
      { toolName: "write", input: { path: "[src/locked.ts#ABCD]", content: "x" } },
      {
        toolName: "edit",
        input: { input: "*** Begin Patch\n[src/locked.ts#ABCD]\nPUT 1.=1:\n+x\n*** End Patch\n" },
      },
      {
        toolName: "edit",
        input: {
          input: "*** Begin Patch\n*** Update File: src/locked.ts\n@@\n-old\n+new\n*** End Patch\n",
        },
      },
      {
        toolName: "edit",
        input: { input: "*** Edit File: src/locked.ts\n*** Find\nold\n*** Replace\nnew\n" },
      },
      { toolName: "ast_edit", input: { paths: ["src/locked.ts"], ops: [] } },
      { toolName: "ast_edit", input: { paths: ["src"], ops: [] } },
      { toolName: "ast_edit", input: { paths: ["src/**/*.ts"], ops: [] } },
    ]) {
      expect(await guard?.(event, ctx), JSON.stringify(event)).toMatchObject({ block: true });
    }
    await pi.handlers.get("tool_result")?.[0]?.(
      {
        toolName: "edit",
        isError: false,
        input: { input: "*** Begin Patch\n[src/free.ts#ABCD]\nPUT 1.=1:\n+x\n*** End Patch\n" },
      },
      ctx,
    );
    await pi.handlers.get("tool_result")?.[0]?.(
      {
        toolName: "ast_edit",
        isError: false,
        input: { paths: ["src/other.ts"], ops: [] },
      },
      ctx,
    );
    vi.advanceTimersByTime(10_000);
    const registration = JSON.parse(fs.readFileSync(path.join(registry, "Self.json"), "utf8"));
    expect(registration.session.filesModified).toEqual(["src/free.ts", "src/other.ts"]);
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

    const tool = pi.tools.find((tool) => tool.name === "omp_messenger");
    expect(tool).toBeTruthy();

    let freshCtxReads = 0;
    const freshCtx = createEventContext(cwd, () => {
      freshCtxReads += 1;
      return false;
    });

    await tool.execute(
      "tool-call",
      { action: "status" },
      new AbortController().signal,
      undefined,
      freshCtx,
    );
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
      }),
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
      }),
    );

    const pi = await loadExtension();
    const sessionStart = pi.handlers.get("session_start")?.[0];
    expect(sessionStart).toBeTruthy();

    const ctx = createEventContext(cwd, () => true);
    await sessionStart?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalled();

    const stuckWakeCalls = pi.sendMessage.mock.calls.filter(
      ([message]) => message.customType === "agent_stuck",
    );
    expect(stuckWakeCalls).toHaveLength(1);
    expect(stuckWakeCalls[0]?.[1]).toMatchObject({
      deliverAs: "steer",
      triggerTurn: true,
    });

    vi.advanceTimersByTime(30_000);
    const repeatedCalls = pi.sendMessage.mock.calls.filter(
      ([message]) => message.customType === "agent_stuck",
    );
    expect(repeatedCalls).toHaveLength(1);
  });

  it("contains failures in the background status heartbeat", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".omp", "omp-messenger.json"),
      JSON.stringify({ autoRegister: true }),
    );
    const pi = await loadExtension();
    const ctx = createEventContext(cwd, () => true);
    await pi.handlers.get("session_start")?.[0]?.({}, ctx);
    ctx.ui.setStatus.mockImplementation(() => {
      throw new Error("status render failed");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => vi.advanceTimersByTime(15_000)).not.toThrow();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not swallow non-stale status update errors", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-cwd-"));
    tempCwds.push(cwd);
    fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".omp", "omp-messenger.json"),
      JSON.stringify({ autoRegister: true }),
    );

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
