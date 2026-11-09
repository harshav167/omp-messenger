import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import extension from "../../index.ts";

test("registered reservation handler reads every supported edit format", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "omp-edit-events-"));
  const oldHome = process.env.HOME;
  const oldBase = process.env.OMP_MESSENGER_DIR;
  const oldName = process.env.OMP_AGENT_NAME;
  const base = join(root, "mesh");
  process.env.HOME = root;
  process.env.OMP_MESSENGER_DIR = base;
  process.env.OMP_AGENT_NAME = "Self";
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const pi = {
    pi: { getAgentDir: () => join(root, ".omp", "agent") },
    zod,
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    appendEntry() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  const ctx = {
    cwd: root,
    hasUI: false,
    agent: { kind: "main", id: "Main" },
    sessionManager: { getEntries: () => [], getSessionId: () => "edit-session" },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
  };
  try {
    fs.mkdirSync(join(root, ".omp"), { recursive: true });
    fs.writeFileSync(
      join(root, ".omp", "omp-messenger.json"),
      JSON.stringify({ autoRegister: true }),
    );
    fs.mkdirSync(join(base, "registry"), { recursive: true });
    fs.writeFileSync(
      join(base, "registry", "Peer.json"),
      JSON.stringify({
        name: "Peer",
        pid: process.pid,
        cwd: root,
        model: "test",
        startedAt: new Date().toISOString(),
        reservations: [{ pattern: "src/locked.ts" }],
        isHuman: false,
        session: { toolCalls: 0, tokens: 0, filesModified: [] },
        activity: { lastActivityAt: new Date().toISOString() },
      }),
    );
    extension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.[0]?.({}, ctx);
    const guard = handlers.get("tool_call")?.[1];
    expect(guard).toBeDefined();
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
        input: { input: "*** Begin Patch\n[src/free.ts#ABCD]\nMV src/locked.ts\n*** End Patch\n" },
      },
      {
        toolName: "edit",
        input: {
          input:
            "*** Begin Patch\n*** Update File: src/free.ts\n*** Move to: src/locked.ts\n*** End Patch\n",
        },
      },
      {
        toolName: "edit",
        input: { input: "*** Edit File: src/locked.ts\n*** Find\nold\n*** Replace\nnew\n" },
      },
      { toolName: "ast_edit", input: { paths: ["src/**/*.ts"], ops: [] } },
    ])
      expect(await guard?.(event, ctx), JSON.stringify(event)).toMatchObject({ block: true });
    await handlers.get("session_shutdown")?.[0]?.({}, ctx);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldBase === undefined) delete process.env.OMP_MESSENGER_DIR;
    else process.env.OMP_MESSENGER_DIR = oldBase;
    if (oldName === undefined) delete process.env.OMP_AGENT_NAME;
    else process.env.OMP_AGENT_NAME = oldName;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
