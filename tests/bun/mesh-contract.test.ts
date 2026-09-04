import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { AgentMailMessage, MessengerState } from "../../lib.ts";
import { createMeshClient } from "../../mesh/client.ts";
import { startMeshServer } from "../../mesh/server.ts";
import type { Mesh } from "../../mesh/types.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createMockContext } from "../helpers/mock-context.ts";
import { createTestMesh } from "../helpers/mesh.ts";

interface Participant {
  mesh: Mesh;
  state: MessengerState;
  delivered: AgentMailMessage[];
}

interface ContractHarness {
  a: Participant;
  b: Participant;
  ctx: ExtensionContext;
  add(channel: string): Promise<Participant>;
  flushB(): void;
  stop(): Promise<void>;
}

type ContractFactory = () => Promise<ContractHarness>;

// These integration checks exercise real filesystem watchers and WebSocket broadcasts,
// so fake timers cannot drive the external readiness signals.
async function waitUntil(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await Bun.sleep(10);
  }
}

async function makeFs(): Promise<ContractHarness> {
  const root = mkdtempSync(join(tmpdir(), "pi-messenger-contract-fs-"));
  const ctx = createMockContext(root);
  const meshes: Participant[] = [];

  async function add(channel: string, name = String.fromCharCode(65 + meshes.length)): Promise<Participant> {
    const fixture = createTestMesh(root, { agentName: name, channel });
    fixture.state.explicitName = true;
    const participant = { mesh: fixture.mesh, state: fixture.state, delivered: fixture.delivered };
    meshes.push(participant);
    await participant.mesh.join(ctx, { channel });
    return participant;
  }

  const a = await add("main", "A");
  const b = await add("main", "B");
  return {
    a,
    b,
    ctx,
    add,
    flushB: () => b.mesh.drainInbox(),
    async stop() {
      for (const participant of meshes) {
        participant.mesh.close();
        if (participant.state.registered) await participant.mesh.leave();
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function makeClient(): Promise<ContractHarness> {
  const root = mkdtempSync(join(tmpdir(), "pi-messenger-contract-client-"));
  const ctx = createMockContext(root);
  const server = startMeshServer({ port: 0, token: "t" });
  const meshes: Participant[] = [];

  async function add(channel: string, name = String.fromCharCode(65 + meshes.length)): Promise<Participant> {
    const fixture = createTestMesh(root, { agentName: name, channel });
    fixture.state.explicitName = true;
    const participant: Participant = {
      state: fixture.state,
      delivered: fixture.delivered,
      mesh: createMeshClient({
        url: `ws://127.0.0.1:${server.port}`,
        token: "t",
        state: fixture.state,
        deliver: (message) => fixture.delivered.push(message),
        reconnectBaseMs: 20,
      }),
    };
    meshes.push(participant);
    await participant.mesh.join(ctx, { channel });
    return participant;
  }

  const a = await add("main", "A");
  const b = await add("main", "B");
  await waitUntil(() => a.mesh.peers().some((peer) => peer.name === "B"));
  return {
    a,
    b,
    ctx,
    add,
    flushB: () => {},
    async stop() {
      for (const participant of meshes) participant.mesh.close();
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const implementations: readonly [string, ContractFactory][] = [
  ["fs", makeFs],
  ["mesh", makeClient],
];

describe.each(implementations)("%s mesh contract", (_kind, factory) => {
  it("marks joined participants as registered", async () => {
    const harness = await factory();
    try {
      expect(harness.a.state.registered).toBe(true);
      expect(harness.b.state.registered).toBe(true);
    } finally {
      await harness.stop();
    }
  });

  it("publishes reservation changes to peers", async () => {
    const harness = await factory();
    try {
      harness.a.state.reservations.push({ pattern: "src/x.ts", since: new Date().toISOString() });
      harness.a.mesh.publish(harness.ctx);
      await waitUntil(() => harness.b.mesh.peers()[0]?.reservations?.[0]?.pattern === "src/x.ts");
      expect(harness.b.mesh.peers()[0]?.reservations?.[0]?.pattern).toBe("src/x.ts");
    } finally {
      await harness.stop();
    }
  });

  it("delivers a message to a present peer", async () => {
    const harness = await factory();
    try {
      expect((await harness.a.mesh.send(harness.b.state.agentName, "hello")).ok).toBe(true);
      harness.flushB();
      await waitUntil(() => harness.b.delivered[0]?.text === "hello");
      expect(harness.b.delivered[0]?.from).toBe(harness.a.state.agentName);
    } finally {
      await harness.stop();
    }
  });

  it("rejects a message to an absent peer", async () => {
    const harness = await factory();
    try {
      expect(await harness.a.mesh.send("nobody", "x")).toMatchObject({ ok: false });
    } finally {
      await harness.stop();
    }
  });

  it("claims and unclaims a task", async () => {
    const harness = await factory();
    try {
      const spec = join(harness.ctx.cwd, "SPEC.md");
      expect((await harness.a.mesh.claim(harness.ctx, spec, "T1")).success).toBe(true);
      await waitUntil(() => harness.b.mesh.claims()[spec]?.T1?.agent === harness.a.state.agentName);
      expect(await harness.a.mesh.unclaim(spec, "T1")).toEqual({ success: true });
      await waitUntil(() => harness.b.mesh.claims()[spec]?.T1 === undefined);
    } finally {
      await harness.stop();
    }
  });

  it("renames a participant in peer presence", async () => {
    const harness = await factory();
    try {
      expect((await harness.a.mesh.rename(harness.ctx, "Zed")).success).toBe(true);
      await waitUntil(() => harness.b.mesh.peers().some((peer) => peer.name === "Zed"));
    } finally {
      await harness.stop();
    }
  });

  it("removes a participant that leaves", async () => {
    const harness = await factory();
    try {
      await harness.a.mesh.leave();
      await waitUntil(() => harness.b.mesh.peers().every((peer) => peer.name !== "A"));
    } finally {
      await harness.stop();
    }
  });

  it("isolates a third participant in another channel and lists both", async () => {
    const harness = await factory();
    try {
      const c = await harness.add("blue");
      expect(harness.b.mesh.peers().some((peer) => peer.name === c.state.agentName)).toBe(false);
      expect(await harness.b.mesh.channels()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "main", members: 2 }),
        expect.objectContaining({ name: "blue", members: 1 }),
      ]));
    } finally {
      await harness.stop();
    }
  });
});
