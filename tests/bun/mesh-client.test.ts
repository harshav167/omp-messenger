import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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

  function makeClient(
    agentName = "Self",
    explicitName = false,
    token = "t",
    channels?: string[],
  ): ClientFixture {
    const root = mkdtempSync(join(tmpdir(), "omp-messenger-client-"));
    roots.push(root);
    const fixture = createTestMesh(root, { agentName, channels });
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
    expect(b.delivered[0]?.channel).toBe("main");
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
    const c = makeClient("Self", false, "t", ["blue"]);
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);
    await c.mesh.join(c.ctx);

    await waitUntil(() => a.mesh.peers().length === 1);
    expect(a.mesh.peers().some((peer) => peer.name === c.state.agentName)).toBe(false);
    expect(c.mesh.channels()).toEqual(["blue"]);
    expect(await a.mesh.listChannels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "main", members: 2 }),
        expect.objectContaining({ name: "blue", members: 1 }),
      ]),
    );
  });

  it("returns storage_failed when completion persistence fails", async () => {
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    server = startMeshServer({
      port: 0,
      token: "t",
      persist: {
        loadChannels: () => [],
        saveChannel: () => {},
        loadDeletedChannels: () => [],
        loadCompletions: () => ({}),
        saveCompletion: () => {
          throw new Error("SQLITE_CANTOPEN");
        },
        appendMessage: (entry, delivered = []) => ({
          seq: 1,
          duplicate: false,
          entry: { ...entry, seq: 1 },
          delivered,
        }),
        getMessage: () => null,
        pageMessages: () => [],
        deleteChannel: () => {},
        close: () => {},
        probe: () => {},
      },
    });
    servers.push(server);
    port = server.port;
    const a = makeClient();
    await a.mesh.join(a.ctx);
    const spec = join(a.ctx.cwd, "SPEC.md");
    await a.mesh.claim(a.ctx, spec, "T1");
    expect(await a.mesh.complete(spec, "T1")).toEqual({ success: false, error: "storage_failed" });
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

  it("retries an unconfirmed post with the same id after reconnecting", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let dropReply = true;
    globalThis.WebSocket = new Proxy(originalWebSocket, {
      construct(target, args) {
        const socket = new target(args[0], args[1]);
        socket.addEventListener = new Proxy(socket.addEventListener, {
          apply(addListener, thisArg, listenerArgs) {
            const [type, listener, options] = listenerArgs;
            if (type === "message" && typeof listener === "function") {
              return Reflect.apply(addListener, thisArg, [
                type,
                (event: MessageEvent) => {
                  const frame = JSON.parse(String(event.data)) as {
                    t?: string;
                    result?: { entry?: unknown };
                  };
                  if (dropReply && frame.t === "reply" && frame.result?.entry) {
                    dropReply = false;
                    socket.close();
                    return;
                  }
                  listener.call(socket, event);
                },
                options,
              ]);
            }
            return Reflect.apply(addListener, thisArg, listenerArgs);
          },
        });
        return socket;
      },
    });
    try {
      const a = makeClient("Sender");
      const b = makeClient("Recipient");
      expect(await a.mesh.join(a.ctx)).toBe(true);
      expect(await b.mesh.join(b.ctx)).toBe(true);
      await waitUntil(() => a.mesh.peers().some((peer) => peer.name === b.state.agentName));

      const result = await a.mesh.post("once");
      expect(result).toMatchObject({ ok: true, delivered: [b.state.agentName] });
      expect(dropReply).toBe(false);
      await waitUntil(() => b.delivered.length === 1, 2_000);
      expect(b.delivered.map((message) => message.text)).toEqual(["once"]);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("returns unreachable when the reconnect wait deadline expires", async () => {
    vi.useFakeTimers();
    const original = globalThis.WebSocket;
    const sockets: FakeSocket[] = [];
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      readonly sent: string[] = [];
      constructor() {
        super();
        sockets.push(this);
      }
      send(data: string) {
        this.sent.push(String(data));
      }
      close() {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const client = makeClient();
    try {
      const joined = client.mesh.join(client.ctx);
      const socket = sockets[0]!;
      socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            t: "welcome",
            name: "Self",
            channels: [{ channel: "main", peers: [], claims: {}, completions: {} }],
          }),
        }),
      );
      expect(await joined).toBe(true);
      const post = client.mesh.post("unconfirmed");
      socket.close();
      await Promise.resolve();
      vi.advanceTimersByTime(10_000);
      expect(await post).toEqual({ ok: false, error: "unreachable" });
    } finally {
      globalThis.WebSocket = original;
      vi.useRealTimers();
    }
  });

  it("does not bypass reconnect backoff when recovering the inbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-messenger-client-"));
    roots.push(root);
    const fixture = createTestMesh(root, { agentName: "Backoff" });
    const ctx = createMockContext(root);
    const mesh = createMeshClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      state: fixture.state,
      deliver: () => {},
      reconnectBaseMs: 1000,
    });
    clients.push(mesh);
    expect(await mesh.join(ctx)).toBe(true);
    await server.stop();
    await waitUntil(() => mesh.status() === "reconnecting", 500);
    server = startMeshServer({ port, token: "t" });
    servers.push(server);
    mesh.recoverInbox();
    mesh.recoverInbox();
    // The real socket and reconnect timer share the platform clock; fake time cannot drive this integration.
    await Bun.sleep(100);
    expect(mesh.status()).toBe("reconnecting");
    await waitUntil(() => mesh.status() === "connected", 2_000);
  });

  it("contains a stale context during reconnect and recovers with a fresh context", async () => {
    const client = makeClient();
    let stale = false;
    let staleReads = 0;
    Object.defineProperty(client.ctx.sessionManager, "getSessionId", {
      value: () => {
        if (stale) {
          staleReads++;
          throw new Error("extension ctx is stale");
        }
        return "test-session";
      },
    });
    expect(await client.mesh.join(client.ctx)).toBe(true);
    await server.stop();
    await waitUntil(() => client.mesh.status() === "reconnecting", 500);
    stale = true;
    server = startMeshServer({ port, token: "t" });
    servers.push(server);
    await waitUntil(() => staleReads > 0, 2_000);
    client.mesh.publish(createMockContext(client.ctx.cwd));
    await waitUntil(() => client.mesh.status() === "connected", 2_000);
  });

  it("contains a rejected reconnect and retries later", async () => {
    const client = makeClient();
    expect(await client.mesh.join(client.ctx)).toBe(true);
    await server.stop();
    await waitUntil(() => client.mesh.status() === "reconnecting", 500);
    const originalWebSocket = globalThis.WebSocket;
    let attempts = 0;
    try {
      globalThis.WebSocket = new Proxy(originalWebSocket, {
        construct() {
          attempts++;
          throw "transport unavailable";
        },
      });
      await waitUntil(() => attempts >= 2, 2_000);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
    server = startMeshServer({ port, token: "t" });
    servers.push(server);
    await waitUntil(() => client.mesh.status() === "connected", 2_000);
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

  it("bridges single-channel peers and tags each peer with its shared channels", async () => {
    const a = makeClient("Bridge", false, "t", ["main", "blue"]);
    const b = makeClient("MainOnly", false, "t", ["main"]);
    const c = makeClient("BlueOnly", false, "t", ["blue"]);
    expect(await a.mesh.join(a.ctx, { channels: ["main", "blue"] })).toBe(true);
    expect(await b.mesh.join(b.ctx)).toBe(true);
    expect(await c.mesh.join(c.ctx)).toBe(true);

    await waitUntil(() => a.mesh.peers().length === 2);
    const peers: Record<string, string[]> = Object.fromEntries(
      a.mesh.peers().map((peer) => [peer.name, peer.channels]),
    );
    expect(peers["MainOnly"]).toEqual(["main"]);
    expect(peers["BlueOnly"]).toEqual(["blue"]);

    await waitUntil(() => b.mesh.peers().length === 1);
    expect(b.mesh.peers()[0]?.name).toBe("Bridge");
    expect(b.mesh.peers()[0]?.channels).toEqual(["main"]);

    expect((await c.mesh.send("Bridge", "hi")).ok).toBe(true);
    await waitUntil(() => a.delivered.length === 1);
    expect(a.delivered[0]?.channel).toBe("blue");
    expect(a.delivered[0]?.from).toBe("BlueOnly");
  });

  it("requires a channel when the recipient name is present in two joined channels", async () => {
    const a = makeClient("Bridge", false, "t", ["main", "blue"]);
    const b = makeClient("Same", false, "t", ["main"]);
    const b2 = makeClient("Same", false, "t", ["blue"]);
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);
    await b2.mesh.join(b2.ctx);

    await waitUntil(() =>
      a.mesh.peers().some((peer) => peer.name === "Same" && peer.channels.length === 2),
    );

    expect(await a.mesh.send("Same", "x")).toEqual({ ok: false, error: "ambiguous_channel" });

    expect((await a.mesh.send("Same", "x", { channel: "blue" })).ok).toBe(true);
    await waitUntil(() => b2.delivered.length === 1);
    expect(b2.delivered[0]?.channel).toBe("blue");
    expect(b.delivered).toHaveLength(0);

    expect((await a.mesh.send("Same", "y", { channel: "main" })).ok).toBe(true);
    await waitUntil(() => b.delivered.length === 1);
    expect(b.delivered[0]?.channel).toBe("main");
  });

  it("joins and leaves channels on the live connection", async () => {
    const a = makeClient("Bridge", false, "t", ["main", "blue"]);
    const b = makeClient("MainOnly", false, "t", ["main"]);
    await a.mesh.join(a.ctx);
    await b.mesh.join(b.ctx);
    await waitUntil(() => b.mesh.peers().some((peer) => peer.name === "Bridge"));

    expect(await a.mesh.joinChannels(a.ctx, ["green"])).toBe(true);
    expect(a.mesh.channels()).toEqual(["blue", "green", "main"]);

    await a.mesh.leaveChannels(["main"]);
    expect(a.mesh.channels()).toEqual(["blue", "green"]);
    expect(a.mesh.peers().some((peer) => peer.name === "MainOnly")).toBe(false);
    await waitUntil(() => b.mesh.peers().every((peer) => peer.name !== "Bridge"));
  });

  it("re-asserts every joined channel after a server restart", async () => {
    const a = makeClient("Bridge", false, "t", ["main", "blue"]);
    const c = makeClient("BlueOnly", false, "t", ["blue"]);
    await a.mesh.join(a.ctx);
    await c.mesh.join(c.ctx);
    await waitUntil(() => c.mesh.peers().some((peer) => peer.name === "Bridge"));

    await server.stop();
    await waitUntil(() => a.mesh.status() === "reconnecting", 500);
    server = startMeshServer({ port, token: "t" });
    servers.push(server);

    await waitUntil(() => a.mesh.status() === "connected", 2_000);
    await waitUntil(() => c.mesh.peers().some((peer) => peer.name === "Bridge"), 2_000);
    expect(a.mesh.channels()).toEqual(["blue", "main"]);
  });
});
