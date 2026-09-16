import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempCrewDirs } from "./helpers/temp-dirs.ts";
import { createTestMesh } from "./helpers/mesh.ts";
import piMessengerExtension from "../index.ts";
import { createFsMesh } from "../mesh/fs.ts";
import type { Mesh } from "../mesh/types.ts";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
  pi: Record<string, never>;
  typebox: { Type: unknown };
  handlers: Record<string, Handler[]>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerMessageRenderer: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  on: (name: string, handler: Handler) => void;
}

function createMockPi(): MockPi {
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
    on: (name, handler) => {
      handlers[name] = [...(handlers[name] ?? []), handler];
    },
  };
}

function createCtx(cwd: string, idle = false) {
  return {
    cwd,
    hasUI: false,
    isIdle: () => idle,
    ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
    sessionManager: { getEntries: () => [], getSessionId: () => "receiver-session", getSessionFile: () => undefined },
    model: { id: "m" },
  };
}

interface Delivery {
  customType: string;
  text: string;
  opts: unknown;
}

function deliveries(pi: MockPi): Delivery[] {
  return pi.sendMessage.mock.calls.flatMap(([msg, opts]) => {
    if (!msg || typeof msg !== "object" || !("customType" in msg) || typeof msg.customType !== "string") return [];
    if (msg.customType !== "irc:incoming") return [];
    const details = "details" in msg && msg.details && typeof msg.details === "object" ? msg.details : {};
    const text = "message" in details && typeof details.message === "string" ? details.message : "";
    return [{ customType: msg.customType, text, opts }];
  });
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

  async function setupReceiver(cwd: string, idle: boolean) {
    fs.writeFileSync(path.join(cwd, ".omp", "omp-messenger.json"), JSON.stringify({ autoRegister: true }));
    const pi = createMockPi();
    piMessengerExtension(pi as never);
    const ctx = createCtx(cwd, idle);
    await pi.handlers.session_start?.[0]?.({ type: "session_start" }, ctx);
    pi.sendMessage.mockClear();
    expect(fs.existsSync(path.join(base, "registry", "Receiver.json"))).toBe(true);
    return { pi, ctx };
  }

  async function joinSender(cwd: string): Promise<Mesh> {
    const sender = createTestMesh(cwd, { agentName: "Sender", cwd });
    const mesh = createFsMesh(base, sender.state, () => {});
    expect(await mesh.join(createCtx(cwd) as never)).toBe(true);
    return mesh;
  }

  it("busy receiver: steers by default, aside only when the sender marks the message gentle", async () => {
    const { cwd } = createTempCrewDirs();
    const { pi, ctx } = await setupReceiver(cwd, false);
    const sender = await joinSender(cwd);

    expect((await sender.send("Receiver", "interrupt me")).ok).toBe(true);
    expect((await sender.send("Receiver", "when convenient", { gentle: true })).ok).toBe(true);
    await pi.handlers.turn_end?.[0]?.({ type: "turn_end" }, ctx);

    const delivered = deliveries(pi);
    expect(delivered).toHaveLength(2);
    expect(delivered.find(d => d.text === "interrupt me")).toMatchObject({ customType: "irc:incoming", opts: { triggerTurn: true, deliverAs: "steer" } });
    expect(delivered.find(d => d.text === "when convenient")).toMatchObject({ customType: "irc:incoming", opts: { triggerTurn: true, deliverAs: "aside" } });
  });

  it("idle receiver: same irc:incoming record, delivered as an aside so an Esc'd session wakes", async () => {
    const { cwd } = createTempCrewDirs();
    const { pi, ctx } = await setupReceiver(cwd, true);
    const sender = await joinSender(cwd);

    expect((await sender.send("Receiver", "wake up")).ok).toBe(true);
    await pi.handlers.turn_end?.[0]?.({ type: "turn_end" }, ctx);

    const [delivered] = deliveries(pi);
    expect(delivered).toMatchObject({ customType: "irc:incoming", text: "wake up", opts: { triggerTurn: true, deliverAs: "aside" } });
    const [payload] = pi.sendMessage.mock.calls[0];
    expect(payload).toMatchObject({ details: { from: "Sender", message: "wake up" } });
  });
});
