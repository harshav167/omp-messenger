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
import { executeCrewAction } from "../../crew/index.ts";

interface Participant {
  mesh: Mesh;
  state: MessengerState;
  delivered: AgentMailMessage[];
}

interface ContractHarness {
  a: Participant;
  b: Participant;
  ctx: ExtensionContext;
  add(channels: string[], name?: string): Promise<Participant>;
  flush(participant: Participant): void;
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
  const root = mkdtempSync(join(tmpdir(), "omp-messenger-contract-fs-"));
  const ctx = createMockContext(root);
  const meshes: Participant[] = [];

  async function add(channels: string[], name = String.fromCharCode(65 + meshes.length)): Promise<Participant> {
    const fixture = createTestMesh(root, { agentName: name, channels });
    fixture.state.explicitName = true;
    const participant = { mesh: fixture.mesh, state: fixture.state, delivered: fixture.delivered };
    meshes.push(participant);
    await participant.mesh.join(ctx);
    return participant;
  }

  const a = await add(["main"], "A");
  const b = await add(["main"], "B");
  return {
    a,
    b,
    ctx,
    add,
    flush: (participant) => participant.mesh.drainInbox(),
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
  const root = mkdtempSync(join(tmpdir(), "omp-messenger-contract-client-"));
  const ctx = createMockContext(root);
  const server = startMeshServer({ port: 0, token: "t" });
  const meshes: Participant[] = [];

  async function add(channels: string[], name = String.fromCharCode(65 + meshes.length)): Promise<Participant> {
    const fixture = createTestMesh(root, { agentName: name, channels });
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
    await participant.mesh.join(ctx);
    return participant;
  }

  const a = await add(["main"], "A");
  const b = await add(["main"], "B");
  await waitUntil(() => a.mesh.peers().some((peer) => peer.name === "B"));
  return {
    a,
    b,
    ctx,
    add,
    flush: () => { },
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
      expect(harness.a.mesh.channels()).toEqual(["main"]);
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

  it("preserves session age and real activity through repeated presence publication", async () => {
    const harness = await factory();
    try {
      harness.a.state.sessionStartedAt = "2026-01-01T00:00:00.000Z";
      harness.a.state.activity = { lastActivityAt: "2026-01-01T00:03:00.000Z", currentActivity: "reading", lastToolCall: "read" };
      harness.a.state.reservations = [{ pattern: "src/presence.ts", since: "2026-01-01T00:00:00.000Z" }];
      harness.a.mesh.publish(harness.ctx);
      await waitUntil(() => harness.b.mesh.peers().find(peer => peer.name === "A")?.reservations?.[0]?.pattern === "src/presence.ts");
      const first = harness.b.mesh.peers().find(peer => peer.name === "A");
      expect(first?.startedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(first?.activity).toEqual({ lastActivityAt: "2026-01-01T00:03:00.000Z", currentActivity: "reading", lastToolCall: "read" });
      harness.a.state.reservations[0].reason = "updated";
      harness.a.mesh.publish(harness.ctx);
      await waitUntil(() => harness.b.mesh.peers().find(peer => peer.name === "A")?.reservations?.[0]?.reason === "updated", 1500);
      const second = harness.b.mesh.peers().find(peer => peer.name === "A");
      expect(second?.startedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(second?.activity.lastActivityAt).toBe("2026-01-01T00:03:00.000Z");
      expect((await harness.a.mesh.rename(harness.ctx, "Renamed")).success).toBe(true);
      harness.a.mesh.publish(harness.ctx);
      await waitUntil(() => harness.b.mesh.peers().some(peer => peer.name === "Renamed"), 1500);
      const renamed = harness.b.mesh.peers().find(peer => peer.name === "Renamed");
      expect(renamed?.startedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(renamed?.activity.lastActivityAt).toBe("2026-01-01T00:03:00.000Z");
    } finally {
      await harness.stop();
    }
  });

  it("delivers a message to a present peer", async () => {
    const harness = await factory();
    try {
      expect((await harness.a.mesh.send(harness.b.state.agentName, "hello")).ok).toBe(true);
      harness.flush(harness.b);
      await waitUntil(() => harness.b.delivered[0]?.text === "hello");
      expect(harness.b.delivered[0]?.from).toBe(harness.a.state.agentName);
      expect(harness.b.delivered[0]?.channel).toBe("main");
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
      const c = await harness.add(["blue"]);
      expect(harness.b.mesh.peers().some((peer) => peer.name === c.state.agentName)).toBe(false);
      expect(await harness.b.mesh.listChannels()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "main", members: 2 }),
        expect.objectContaining({ name: "blue", members: 1 }),
      ]));
    } finally {
      await harness.stop();
    }
  });

  it("bridges single-channel peers through a multi-channel participant", async () => {
    const harness = await factory();
    try {
      const bridge = await harness.add(["main", "blue"], "Bridge");
      const blue = await harness.add(["blue"], "Blue");

      await waitUntil(() => bridge.mesh.peers().length === 3);
      const seen: Record<string, string[]> = Object.fromEntries(bridge.mesh.peers().map((peer) => [peer.name, peer.channels]));
      expect(seen["A"]).toEqual(["main"]);
      expect(seen["B"]).toEqual(["main"]);
      expect(seen["Blue"]).toEqual(["blue"]);

      const bPeer = harness.b.mesh.peers().find((peer) => peer.name === "Bridge");
      expect(bPeer?.channels).toEqual(["main"]);
      expect(harness.b.mesh.peers().some((peer) => peer.name === "Blue")).toBe(false);

      expect(await harness.b.mesh.send("Blue", "unreachable")).toEqual({ ok: false, error: "not_found" });

      expect((await harness.b.mesh.send("Bridge", "via main")).ok).toBe(true);
      harness.flush(bridge);
      await waitUntil(() => bridge.delivered.some((message) => message.text === "via main"));
      expect(bridge.delivered.find((message) => message.text === "via main")?.channel).toBe("main");

      expect((await blue.mesh.send("Bridge", "via blue")).ok).toBe(true);
      harness.flush(bridge);
      await waitUntil(() => bridge.delivered.some((message) => message.text === "via blue"));
      expect(bridge.delivered.find((message) => message.text === "via blue")?.channel).toBe("blue");
    } finally {
      await harness.stop();
    }
  });

  it("requires a channel when the recipient name is present in two joined channels", async () => {
    const harness = await factory();
    try {
      const bridge = await harness.add(["main", "blue"], "Bridge");
      const dupBlue = await harness.add(["blue"], "Dup");
      const dupMain = await harness.add(["main"], "Dup");

      await waitUntil(() => bridge.mesh.peers().some((peer) => peer.name === "Dup" && peer.channels.length === 2));
      const dup = bridge.mesh.peers().find((peer) => peer.name === "Dup");
      expect(dup?.channels).toEqual(["blue", "main"]);

      expect(await bridge.mesh.send("Dup", "x")).toEqual({ ok: false, error: "ambiguous_channel" });

      expect((await bridge.mesh.send("Dup", "x", { channel: "blue" })).ok).toBe(true);
      harness.flush(dupBlue);
      harness.flush(dupMain);
      await waitUntil(() => dupBlue.delivered.length === 1);
      expect(dupBlue.delivered[0]?.channel).toBe("blue");
      expect(dupMain.delivered).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it("merges claims across joined channels in sorted channel order", async () => {
    const harness = await factory();
    try {
      const bridge = await harness.add(["main", "blue"], "Bridge");
      const blue = await harness.add(["blue"], "Blue");
      const spec = join(harness.ctx.cwd, "SPEC.md");

      expect((await harness.a.mesh.claim(harness.ctx, spec, "T1")).success).toBe(true);
      expect((await blue.mesh.claim(harness.ctx, spec, "T2")).success).toBe(true);
      expect((await bridge.mesh.claim(harness.ctx, spec, "T1", undefined, "blue")).success).toBe(true);

      await waitUntil(() => {
        const claims = bridge.mesh.claims();
        return claims[spec]?.T1?.agent === "A" && claims[spec]?.T2?.agent === "Blue";
      });
      // "main" sorts after "blue", so A's main claim wins the shared spec/T1 key.
      expect(bridge.mesh.claims()[spec]?.T1?.agent).toBe("A");
      expect(bridge.mesh.claims()[spec]?.T2?.agent).toBe("Blue");
      expect(harness.b.mesh.claims()[spec]?.T2).toBeUndefined();
    } finally {
      await harness.stop();
    }
  });

  it("posts to the channel: mentioned members are interrupted, the rest receive it gently", async () => {
    const harness = await factory();
    try {
      const c = await harness.add(["main"], "C");
      await waitUntil(() => harness.a.mesh.peers().length === 2);
      const posted = await harness.a.mesh.post("@b take a look");
      expect(posted).toMatchObject({ ok: true, channel: "main", mentions: ["B"] });
      expect(posted.ok && [...posted.delivered].sort()).toEqual(["B", "C"]);

      harness.flush(harness.b);
      harness.flush(c);
      await waitUntil(() => harness.b.delivered.length === 1 && c.delivered.length === 1);
      expect(harness.b.delivered[0]).toMatchObject({ kind: "post", from: "A", text: "@b take a look", channel: "main" });
      expect(harness.b.delivered[0]?.gentle).toBeUndefined();
      expect(c.delivered[0]?.gentle).toBe(true);
      expect(c.delivered[0]?.id).toBe(harness.b.delivered[0]?.id);
    } finally {
      await harness.stop();
    }
  });

  it("requires a channel for a post when in several channels", async () => {
    const harness = await factory();
    try {
      const bridge = await harness.add(["main", "blue"], "Bridge");
      expect(await bridge.mesh.post("hi")).toEqual({ ok: false, error: "ambiguous_channel" });
      expect(await bridge.mesh.post("hi", { channel: "green" })).toEqual({ ok: false, error: "not_joined" });
      expect(await bridge.mesh.post("hi", { channel: "blue" })).toMatchObject({ ok: true, channel: "blue", delivered: [] });
    } finally {
      await harness.stop();
    }
  });
});

describe("channel deletion action", () => {
  it("deletes through the dispatcher, notifies members, and protects main", async () => {
    const harness = await makeClient();
    try {
      const worker = await harness.add(["test"], "Worker");
      const dispatch = (channel?: string) => executeCrewAction(
        "channels.delete", { channel }, harness.a.state, harness.a.mesh, harness.ctx, () => { }, () => { }, () => { },
      );
      const missing = await dispatch();
      expect(missing.details.error).toBe("missing_channel");
      const unknown = await executeCrewAction(
        "channels.typo", {}, harness.a.state, harness.a.mesh, harness.ctx, () => { }, () => { }, () => { },
      );
      expect(unknown.details.error).toBe("unknown_action");
      const protectedMain = await dispatch("main");
      expect(protectedMain.details.error).toBe("protected");
      const deleted = await dispatch("test");
      expect(deleted.details).toMatchObject({ mode: "channels.delete", ok: true, deleted: "test", removed: ["Worker"] });
      await waitUntil(() => worker.delivered.some(message => message.text.startsWith("#test was deleted by A")));
      expect(worker.mesh.channels()).toEqual(["main"]);
      expect(worker.delivered.find(message => message.text.startsWith("#test was deleted by A"))?.from).toBe("A");
      expect((await harness.a.mesh.listChannels()).map(channel => channel.name)).toEqual(["main"]);
    } finally {
      await harness.stop();
    }
  });

  it("reports the filesystem limitation without deleting or leaving anything", async () => {
    const harness = await makeFs();
    try {
      const response = await executeCrewAction(
        "channels.delete", { channel: "test" }, harness.a.state, harness.a.mesh, harness.ctx, () => { }, () => { }, () => { },
      );
      expect(response.details.error).toBe("unsupported");
      expect(harness.a.mesh.channels()).toEqual(["main"]);
    } finally {
      await harness.stop();
    }
  });
});
