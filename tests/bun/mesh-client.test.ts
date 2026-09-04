import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentMailMessage, MessengerState } from "../../lib.ts";
import { createMeshClient } from "../../mesh/client.ts";
import { startMeshServer, type MeshServer } from "../../mesh/server.ts";
import type { Mesh } from "../../mesh/types.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { createTestMesh } from "../helpers/mesh.ts";

interface ClientFixture {
  mesh: Mesh;
  state: MessengerState;
  delivered: AgentMailMessage[];
  ctx: ExtensionContext;
}

// Real WebSocket broadcasts are external readiness signals, so fake timers cannot drive them.
async function waitUntil(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await Bun.sleep(10);
  }
}

describe("mesh client", () => {
  const clients: Mesh[] = [];
  const servers: MeshServer[] = [];
  const roots: string[] = [];
  let server: MeshServer;
  let port: number;

  function makeClient(agentName = "Self", explicitName = false, token = "t"): ClientFixture {
    const root = mkdtempSync(join(tmpdir(), "pi-messenger-client-"));
    roots.push(root);
    const fixture = createTestMesh(root, { agentName });
    fixture.state.explicitName = explicitName;
    const ctx = createMockContext(root);
    const mesh = createMeshClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      state: fixture.state,
      deliver: (message) => fixture.delivered.push(message),
      reconnectBaseMs: 50,
    });
    clients.push(mesh);
    return { mesh, state: fixture.state, delivered: fixture.delivered, ctx };
  }

  beforeEach(() => {
    server = startMeshServer({ port: 0, token: "t" });
    servers.push(server);
    port = server.port;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await Promise.all(servers.map((item) => item.stop()));
    servers.length = 0;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("discovers peers and delivers messages", async () => {
    const a = makeClient();
    const b = makeClient();
    expect(await a.mesh.join(a.ctx)).toBe(true);
    expect(await b.mesh.join(b.ctx)).toBe(true);
    await waitUntil(() => a.mesh.peers().some((peer) => peer.name === b.state.agentName));
    await waitUntil(() => b.mesh.peers().some((peer) => peer.name === a.state.agentName));

    expect((await a.mesh.send(b.state.agentName, "hi")).ok).toBe(true);
    await waitUntil(() => b.delivered.length === 1);
    expect(b.delivered[0]?.text).toBe("hi");
    expect(b.delivered[0]?.from).toBe(a.state.agentName);
  });

  it("rejects an explicit duplicate and suffixes an automatic duplicate", async () => {
    const existing = makeClient("Fixed", true);
    const duplicate = makeClient("Fixed", true);
    const automatic = makeClient("Fixed");
    expect(await existing.mesh.join(existing.ctx)).toBe(true);

    expect(await duplicate.mesh.join(duplicate.ctx)).toBe(false);
    expect(duplicate.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("rejected agent name"),
      "error",
    );
    expect(await automatic.mesh.join(automatic.ctx)).toBe(true);
    expect(automatic.state.agentName).toBe("Fixed2");
  });

  it("returns not_found for an absent recipient", async () => {
    const a = makeClient();
    expect(await a.mesh.join(a.ctx)).toBe(true);
    expect(await a.mesh.send("ghost", "x")).toEqual({ ok: false, error: "not_found" });
  });

  it("replicates claim conflicts to both clients", async () => {
    const a = makeClient();
    const b = makeClient();
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);
    const spec = join(a.ctx.cwd, "SPEC.md");

    expect((await a.mesh.claim(a.ctx, spec, "T1")).success).toBe(true);
    const conflict = await b.mesh.claim(b.ctx, spec, "T1");
    expect(conflict).toMatchObject({ success: false, error: "already_claimed" });
    await waitUntil(() => a.mesh.claims()[spec]?.T1?.agent === a.state.agentName);
    await waitUntil(() => b.mesh.claims()[spec]?.T1?.agent === a.state.agentName);
  });

  it("isolates peers by channel and lists channel membership", async () => {
    const a = makeClient();
    const b = makeClient();
    const c = makeClient();
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);
    await c.mesh.join(c.ctx, { channel: "blue" });

    await waitUntil(() => a.mesh.peers().length === 1);
    expect(a.mesh.peers().some((peer) => peer.name === c.state.agentName)).toBe(false);
    expect(await a.mesh.channels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "main", members: 2 }),
      expect.objectContaining({ name: "blue", members: 1 }),
    ]));
  });

  it("reconnects with its existing claim after a server restart", async () => {
    const a = makeClient();
    const b = makeClient();
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);
    const spec = join(a.ctx.cwd, "SPEC.md");
    await a.mesh.claim(a.ctx, spec, "T1");

    await server.stop();
    await waitUntil(() => a.mesh.status() === "reconnecting", 500);
    server = startMeshServer({ port, token: "t" });
    servers.push(server);

    await waitUntil(() => a.mesh.status() === "connected", 2_000);
    await waitUntil(() => b.mesh.peers().some((peer) => peer.name === a.state.agentName), 2_000);
    await waitUntil(() => b.mesh.claims()[spec]?.T1?.agent === a.state.agentName, 2_000);
  });

  it("rejects a bad token", async () => {
    const client = makeClient("Self", false, "wrong");
    expect(await client.mesh.join(client.ctx)).toBe(false);
    expect(client.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("rejected the token"),
      "error",
    );
  });

  it("renames the local agent and updates peer presence", async () => {
    const a = makeClient();
    const b = makeClient();
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);

    expect(await a.mesh.rename(a.ctx, "Zed")).toMatchObject({ success: true });
    expect(a.state.agentName).toBe("Zed");
    await waitUntil(() => b.mesh.peers().some((peer) => peer.name === "Zed"));
  });

  it("leaves and can join again", async () => {
    const a = makeClient();
    const b = makeClient();
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);

    await a.mesh.leave();
    await waitUntil(() => b.mesh.peers().every((peer) => peer.name !== a.state.agentName));
    expect(await a.mesh.join(a.ctx)).toBe(true);
  });
});
