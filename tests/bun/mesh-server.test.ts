import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistration } from "../../lib.ts";
import { MESH_CLOSE, MESH_SUBPROTOCOL, parseFrame, type ClientFrame, type ServerFrame } from "../../mesh/protocol.ts";
import { startMeshServer, type MeshServer } from "../../mesh/server.ts";

type FrameWaiter = {
  readonly predicate: (frame: ServerFrame) => boolean;
  readonly resolve: (frame: ServerFrame) => void;
};

class TestClient {
  readonly frames: ServerFrame[] = [];
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<CloseEvent>;
  private readonly waiters: FrameWaiter[] = [];

  constructor(url: string, protocols: string[] = [MESH_SUBPROTOCOL]) {
    this.socket = new WebSocket(url, protocols);
    const opened = Promise.withResolvers<void>();
    this.opened = opened.promise;
    this.socket.addEventListener("open", () => opened.resolve(), { once: true });
    this.socket.addEventListener("error", () => opened.reject(new Error("websocket open failed")), { once: true });
    const closed = Promise.withResolvers<CloseEvent>();
    this.closed = closed.promise;
    this.socket.addEventListener("close", closed.resolve, { once: true });
    this.socket.addEventListener("message", (event) => {
      const frame = parseFrame<ServerFrame>(event.data);
      if (!frame) return;
      this.frames.push(frame);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index < 0) return;
      const waiter = this.waiters[index];
      if (!waiter) return;
      this.waiters.splice(index, 1);
      waiter.resolve(frame);
    });
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  next(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    const pending = Promise.withResolvers<ServerFrame>();
    this.waiters.push({ predicate, resolve: pending.resolve });
    return pending.promise;
  }

  close(): void {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000);
  }
}

const servers: MeshServer[] = [];
const clients: TestClient[] = [];
const tempDirs: string[] = [];

function start(dataDir?: string): MeshServer {
  const server = startMeshServer({ port: 0, hostname: "127.0.0.1", token: "t", dataDir });
  servers.push(server);
  return server;
}

function connect(server: MeshServer): TestClient {
  const client = new TestClient(`ws://${server.hostname}:${server.port}`);
  clients.push(client);
  return client;
}

function registration(name: string): AgentRegistration {
  const now = new Date().toISOString();
  return {
    name,
    pid: 1,
    hostId: "h",
    sessionId: `session-${name}`,
    cwd: "/repo",
    model: "test",
    startedAt: now,
    isHuman: false,
    session: { turns: 0, toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now },
  };
}

async function hello(client: TestClient, name: string, channel = "main", token = "t"): Promise<ServerFrame> {
  await client.opened;
  client.send({ t: "hello", token, channel, agent: registration(name), claims: [] });
  return client.next((frame) => frame.t === "welcome" || frame.t === "reject");
}

function isReply(frame: ServerFrame, id: string): boolean {
  return frame.t === "reply" && frame.id === id;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("mesh server", () => {
  it("rejects a bad token and closes with the authentication code", async () => {
    const client = connect(start());
    const rejected = await hello(client, "A", "main", "wrong");
    expect(rejected).toEqual({ t: "reject", error: "bad_token" });
    expect((await client.closed).code).toBe(MESH_CLOSE.BAD_TOKEN);
  });

  it("requires the mesh WebSocket subprotocol", async () => {
    const server = start();
    const response = await fetch(`http://${server.hostname}:${server.port}`);
    expect(response.status).toBe(426);
  });

  it("isolates presence by channel", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    const c = connect(server);
    await hello(a, "A");
    await hello(b, "B");
    await a.next((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.name === "B"));
    await b.next((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.name === "A"));
    const cWelcome = await hello(c, "C", "blue");
    a.send({ t: "publish", agent: { ...registration("A"), statusMessage: "after-blue-join" } });
    const aPeers = await a.next((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.statusMessage === "after-blue-join"));
    const bPeers = await b.next((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.statusMessage === "after-blue-join"));
    expect(aPeers.t === "peers" && aPeers.peers.some((peer) => peer.name === "C")).toBeFalse();
    expect(bPeers.t === "peers" && bPeers.peers.some((peer) => peer.name === "C")).toBeFalse();
    expect(cWelcome.t === "welcome" && cWelcome.peers.some((peer) => peer.name !== "C")).toBeFalse();

  });

  it("reports channel membership", async () => {
    const server = start();
    const a = connect(server);
    await hello(a, "A");
    await hello(connect(server), "B");
    await hello(connect(server), "C", "blue");
    a.send({ t: "channels", id: "channels" });
    const reply = await a.next((frame) => isReply(frame, "channels"));
    expect(reply.t === "reply" && Array.isArray(reply.result) && reply.result.find((ch) => ch.name === "main")?.members).toBe(2);
    expect(reply.t === "reply" && Array.isArray(reply.result) && reply.result.find((ch) => ch.name === "blue")?.members).toBe(1);
  });

  it("rejects duplicate names only within the same channel", async () => {
    const server = start();
    await hello(connect(server), "A");
    const duplicate = connect(server);
    expect(await hello(duplicate, "A")).toEqual({ t: "reject", error: "name_taken" });
    duplicate.send({ t: "hello", token: "t", channel: "blue", agent: registration("A"), claims: [] });
    const welcome = await duplicate.next((frame) => frame.t === "welcome");
    expect(welcome.t === "welcome" && welcome.channel).toBe("blue");
  });

  it("delivers messages and reports an absent recipient", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    await hello(a, "A");
    await hello(b, "B");
    const message = { id: "m1", from: "A", to: "B", text: "hello", timestamp: new Date().toISOString(), replyTo: null };
    a.send({ t: "send", id: "send-1", to: "B", message });
    expect(await b.next((frame) => frame.t === "message" && frame.message.id === "m1")).toEqual({ t: "message", message });
    const delivered = await a.next((frame) => isReply(frame, "send-1"));
    expect(delivered.t === "reply" && !Array.isArray(delivered.result) && "ok" in delivered.result && delivered.result.ok).toBeTrue();

    a.send({ t: "send", id: "send-2", to: "nobody", message: { ...message, id: "m2", to: "nobody" } });
    const absent = await a.next((frame) => isReply(frame, "send-2"));
    expect(absent.t === "reply" && !Array.isArray(absent.result) && "error" in absent.result && absent.result.error).toBe("not_found");
  });

  it("enforces claim ownership and releases disconnected claims", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    await hello(a, "A");
    await hello(b, "B");
    a.send({ t: "claim", id: "claim-a", spec: "spec", taskId: "T1" });
    const first = await a.next((frame) => isReply(frame, "claim-a"));
    expect(first.t === "reply" && !Array.isArray(first.result) && "success" in first.result && first.result.success).toBeTrue();
    b.send({ t: "claim", id: "claim-b1", spec: "spec", taskId: "T1" });
    const conflict = await b.next((frame) => isReply(frame, "claim-b1"));
    expect(conflict.t === "reply" && !Array.isArray(conflict.result) && "error" in conflict.result && conflict.result.error).toBe("already_claimed");

    a.close();
    await b.next((frame) => frame.t === "peers" && !frame.peers.some((peer) => peer.name === "A"));
    b.send({ t: "claim", id: "claim-b2", spec: "spec", taskId: "T1" });
    const claimed = await b.next((frame) => isReply(frame, "claim-b2"));
    expect(claimed.t === "reply" && !Array.isArray(claimed.result) && "success" in claimed.result && claimed.result.success).toBeTrue();
    const claims = await b.next((frame) => frame.t === "claims" && frame.claims.spec?.T1?.agent === "B");
    expect(claims.t === "claims" && claims.claims.spec?.T1?.agent).toBe("B");
  });

  it("renames presence and notifies channel peers", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    await hello(a, "A");
    await hello(b, "B");
    a.send({ t: "rename", id: "rename", name: "Z" });
    const reply = await a.next((frame) => isReply(frame, "rename"));
    expect(reply.t === "reply" && !Array.isArray(reply.result) && "success" in reply.result && reply.result.success).toBeTrue();
    const peers = await b.next((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.name === "Z"));
    expect(peers.t === "peers" && peers.peers.some((peer) => peer.name === "A")).toBeFalse();
  });

  it("persists completions and channel creation across restarts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omp-messenger-mesh-"));
    tempDirs.push(dataDir);
    const firstServer = start(dataDir);
    const a = connect(firstServer);
    await hello(a, "A", "blue");
    a.send({ t: "claim", id: "claim", spec: "spec", taskId: "T1" });
    await a.next((frame) => isReply(frame, "claim"));
    a.send({ t: "complete", id: "complete", spec: "spec", taskId: "T1" });
    const completed = await a.next((frame) => isReply(frame, "complete"));
    expect(completed.t === "reply" && !Array.isArray(completed.result) && "success" in completed.result && completed.result.success).toBeTrue();
    a.close();
    await a.closed;
    await firstServer.stop();

    const secondServer = start(dataDir);
    const fresh = connect(secondServer);
    const welcome = await hello(fresh, "B", "blue");
    expect(welcome.t === "welcome" && welcome.completions.spec?.T1?.completedBy).toBe("A");
    fresh.send({ t: "channels", id: "channels" });
    const channels = await fresh.next((frame) => isReply(frame, "channels"));
    expect(channels.t === "reply" && Array.isArray(channels.result) && channels.result.some((channel) => channel.name === "blue")).toBeTrue();
  });

  it("serves the health check", async () => {
    const server = start();
    const response = await fetch(`http://${server.hostname}:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
