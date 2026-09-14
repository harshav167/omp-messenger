import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "./helpers/temp-dirs.ts";
import { createTestMesh } from "./helpers/mesh.ts";
import piMessengerExtension from "../index.ts";
import { createFsMesh } from "../mesh/fs.ts";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));

type Handler = (event: unknown, ctx: unknown) => unknown;

function createMockPi() {
  const handlers: Record<string, Handler[]> = {};
  return {
    pi: {},
    typebox: { Type: new Proxy({}, { get: () => () => ({}) }) },
    handlers,
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    on: (name: string, handler: Handler) => {
      handlers[name] = [...(handlers[name] ?? []), handler];
    },
  };
}

function createCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
    sessionManager: { getEntries: () => [], getSessionId: () => "receiver-session", getSessionFile: () => undefined },
    model: { id: "m" },
  };
}

describe("peer message delivery mode", () => {
  let base: string;
  const originalEnv = {
    OMP_MESSENGER_DIR: process.env.OMP_MESSENGER_DIR,
    OMP_AGENT_NAME: process.env.OMP_AGENT_NAME,
    OMP_MESSENGER_MESH_URL: process.env.OMP_MESSENGER_MESH_URL,
    HOME: process.env.HOME,
  };

  beforeEach(() => {
    const { cwd } = createTempCrewDirs();
    base = path.join(cwd, "mesh-base");
    process.env.OMP_MESSENGER_DIR = base;
    process.env.OMP_AGENT_NAME = "Receiver";
    delete process.env.OMP_MESSENGER_MESH_URL;
    // Isolate from the developer's real ~/.omp/agent/omp-messenger.json (which may point at a mesh server).
    process.env.HOME = path.join(cwd, "home");
    fs.mkdirSync(process.env.HOME, { recursive: true });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("steers by default and uses aside only when the sender marks the message gentle", async () => {
    const { cwd } = createTempCrewDirs();
    fs.writeFileSync(path.join(cwd, ".omp", "omp-messenger.json"), JSON.stringify({ autoRegister: true }));

    const pi = createMockPi();
    piMessengerExtension(pi as never);
    const ctx = createCtx(cwd);
    await pi.handlers.session_start?.[0]?.({ type: "session_start" }, ctx);
    pi.sendMessage.mockClear();
    expect({
      registered: fs.existsSync(path.join(base, "registry", "Receiver.json")),
      notifications: ctx.ui.notify.mock.calls,
    }).toEqual({ registered: true, notifications: [] });

    // A second session on the same filesystem mesh sends two messages.
    const sender = createTestMesh(cwd, { agentName: "Sender", cwd });
    sender.mesh = createFsMesh(base, sender.state, () => {});
    const senderCtx = { ...createCtx(cwd), hasUI: true };
    const joined = await sender.mesh.join(senderCtx as never);
    expect({ joined, notifications: senderCtx.ui.notify.mock.calls }).toEqual({ joined: true, notifications: [] });
    expect((await sender.mesh.send("Receiver", "interrupt me")).ok).toBe(true);
    expect((await sender.mesh.send("Receiver", "when convenient", { gentle: true })).ok).toBe(true);

    await pi.handlers.turn_end?.[0]?.({ type: "turn_end" }, ctx);

    const deliveries = pi.sendMessage.mock.calls
      .filter(([msg]) => (msg as { customType?: string }).customType === "agent_message")
      .map(([msg, opts]) => ({ text: (msg as { details: { text: string } }).details.text, opts }));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.find(d => d.text === "interrupt me")?.opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(deliveries.find(d => d.text === "when convenient")?.opts).toEqual({ triggerTurn: true, deliverAs: "aside" });
  });
});
