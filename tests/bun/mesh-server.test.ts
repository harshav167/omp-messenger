import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistration } from "../../lib.ts";
import { MESH_CLOSE, MESH_SUBPROTOCOL, parseFrame, type ChannelSnapshot, type ClientFrame, type HistoryPage, type PostResult, type ServerFrame } from "../../mesh/protocol.ts";
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
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now },
  };
}

async function hello(client: TestClient, name: string, channels: string[] = ["main"], token = "t"): Promise<ServerFrame> {
  await client.opened;
  client.send({ t: "hello", token, channels, agent: registration(name), claims: [] });
  return client.next((frame) => frame.t === "welcome" || frame.t === "reject");
}

function isReply(frame: ServerFrame, id: string): boolean {
  return frame.t === "reply" && frame.id === id;
}

function snapshot(frame: ServerFrame, channel: string): ChannelSnapshot | undefined {
  return frame.t === "welcome" ? frame.channels.find((snap) => snap.channel === channel) : undefined;
}
function replyChannels(frame: ServerFrame, id: string): (ChannelSnapshot | string)[] | undefined {
  if (frame.t !== "reply" || frame.id !== id) return undefined;
  const result = frame.result;
  if (Array.isArray(result) || !("ok" in result) || result.ok !== true || !("channels" in result)) return undefined;
  return result.channels;
}


afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("mesh server", () => {
  it("rejects a bad token and closes with the authentication code", async () => {
    const client = connect(start());
    const rejected = await hello(client, "A", ["main"], "wrong");
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
    await a.next((frame) => frame.t === "peers" && frame.channel === "main" && frame.peers.some((peer) => peer.name === "B"));
    await b.next((frame) => frame.t === "peers" && frame.channel === "main" && frame.peers.some((peer) => peer.name === "A"));
    const cWelcome = await hello(c, "C", ["blue"]);
    a.send({ t: "publish", agent: { ...registration("A"), statusMessage: "after-blue-join" } });
    const aPeers = await a.next((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.statusMessage === "after-blue-join"));
    const bPeers = await b.next((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.statusMessage === "after-blue-join"));
    expect(aPeers.t === "peers" && aPeers.peers.some((peer) => peer.name === "C")).toBeFalse();
    expect(bPeers.t === "peers" && bPeers.peers.some((peer) => peer.name === "C")).toBeFalse();
    expect(snapshot(cWelcome, "blue")?.peers.some((peer) => peer.name !== "C")).toBeFalse();
  });

  it("reports channel membership", async () => {
    const server = start();
    const a = connect(server);
    await hello(a, "A");
    await hello(connect(server), "B");
    await hello(connect(server), "C", ["blue"]);
    a.send({ t: "channels", id: "channels" });
    const reply = await a.next((frame) => isReply(frame, "channels"));
    expect(reply.t === "reply" && Array.isArray(reply.result) && reply.result.find((ch) => ch.name === "main")?.members).toBe(2);
    expect(reply.t === "reply" && Array.isArray(reply.result) && reply.result.find((ch) => ch.name === "blue")?.members).toBe(1);
  });

  it("rejects duplicate names only within the same channel", async () => {
    const server = start();
    await hello(connect(server), "A");
    const duplicate = connect(server);
    expect(await hello(duplicate, "A")).toEqual({ t: "reject", error: "name_taken", channel: "main" });
    duplicate.send({ t: "hello", token: "t", channels: ["blue"], agent: registration("A"), claims: [] });
    const welcome = await duplicate.next((frame) => frame.t === "welcome");
    expect(snapshot(welcome, "blue")?.channel).toBe("blue");
  });

  it("delivers messages and reports an absent recipient", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    await hello(a, "A");
    await hello(b, "B");
    const message = { id: "m1", from: "A", to: "B", text: "hello", timestamp: new Date().toISOString(), replyTo: null };
    a.send({ t: "send", id: "send-1", channel: "main", to: "B", message });
    expect(await b.next((frame) => frame.t === "message" && frame.message.id === "m1"))
      .toEqual({ t: "message", channel: "main", message: { ...message, channel: "main" } });
    const delivered = await a.next((frame) => isReply(frame, "send-1"));
    expect(delivered.t === "reply" && !Array.isArray(delivered.result) && "ok" in delivered.result && delivered.result.ok).toBeTrue();

    a.send({ t: "send", id: "send-2", channel: "main", to: "nobody", message: { ...message, id: "m2", to: "nobody" } });
    const absent = await a.next((frame) => isReply(frame, "send-2"));
    expect(absent.t === "reply" && !Array.isArray(absent.result) && "error" in absent.result && absent.result.error).toBe("not_found");
  });

  it("enforces claim ownership and releases disconnected claims", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    await hello(a, "A");
    await hello(b, "B");
    a.send({ t: "claim", id: "claim-a", channel: "main", spec: "spec", taskId: "T1" });
    const first = await a.next((frame) => isReply(frame, "claim-a"));
    expect(first.t === "reply" && !Array.isArray(first.result) && "success" in first.result && first.result.success).toBeTrue();
    b.send({ t: "claim", id: "claim-b1", channel: "main", spec: "spec", taskId: "T1" });
    const conflict = await b.next((frame) => isReply(frame, "claim-b1"));
    expect(conflict.t === "reply" && !Array.isArray(conflict.result) && "error" in conflict.result && conflict.result.error).toBe("already_claimed");

    a.close();
    await b.next((frame) => frame.t === "peers" && frame.channel === "main" && !frame.peers.some((peer) => peer.name === "A"));
    b.send({ t: "claim", id: "claim-b2", channel: "main", spec: "spec", taskId: "T1" });
    const claimed = await b.next((frame) => isReply(frame, "claim-b2"));
    expect(claimed.t === "reply" && !Array.isArray(claimed.result) && "success" in claimed.result && claimed.result.success).toBeTrue();
    const claims = await b.next((frame) => frame.t === "claims" && frame.claims.spec?.T1?.agent === "B");
    expect(claims.t === "claims" && claims.channel).toBe("main");
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
    await hello(a, "A", ["blue"]);
    a.send({ t: "claim", id: "claim", channel: "blue", spec: "spec", taskId: "T1" });
    await a.next((frame) => isReply(frame, "claim"));
    a.send({ t: "complete", id: "complete", channel: "blue", spec: "spec", taskId: "T1" });
    const completed = await a.next((frame) => isReply(frame, "complete"));
    expect(completed.t === "reply" && !Array.isArray(completed.result) && "success" in completed.result && completed.result.success).toBeTrue();
    a.close();
    await a.closed;
    await firstServer.stop();

    const secondServer = start(dataDir);
    const fresh = connect(secondServer);
    const welcome = await hello(fresh, "B", ["blue"]);
    expect(snapshot(welcome, "blue")?.completions.spec?.T1?.completedBy).toBe("A");
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

  it("welcomes a multi-channel hello with a snapshot per channel", async () => {
    const server = start();
    const mainOnly = connect(server);
    const blueOnly = connect(server);
    const bridge = connect(server);
    await hello(mainOnly, "MainOnly", ["main"]);
    await hello(blueOnly, "BlueOnly", ["blue"]);

    const welcome = await hello(bridge, "Bridge", ["main", "blue"]);
    expect(welcome.t === "welcome" && welcome.name).toBe("Bridge");
    expect(welcome.t === "welcome" && welcome.channels.map((snap) => snap.channel).sort()).toEqual(["blue", "main"]);
    expect(snapshot(welcome, "main")?.peers.some((peer) => peer.name === "MainOnly")).toBeTrue();
    expect(snapshot(welcome, "main")?.peers.some((peer) => peer.name === "BlueOnly")).toBeFalse();
    expect(snapshot(welcome, "blue")?.peers.some((peer) => peer.name === "BlueOnly")).toBeTrue();
    expect(snapshot(welcome, "blue")?.peers.some((peer) => peer.name === "MainOnly")).toBeFalse();

    const mainPeers = await mainOnly.next((frame) => frame.t === "peers" && frame.channel === "main" && frame.peers.some((peer) => peer.name === "Bridge"));
    expect(mainPeers.t === "peers" && mainPeers.peers.some((peer) => peer.name === "BlueOnly")).toBeFalse();
    const bluePeers = await blueOnly.next((frame) => frame.t === "peers" && frame.channel === "blue" && frame.peers.some((peer) => peer.name === "Bridge"));
    expect(bluePeers.t === "peers" && bluePeers.peers.some((peer) => peer.name === "MainOnly")).toBeFalse();
  });

  it("routes sends through the named channel and reports absent recipients", async () => {
    const server = start();
    const mainOnly = connect(server);
    const blueOnly = connect(server);
    const bridge = connect(server);
    await hello(mainOnly, "MainOnly", ["main"]);
    await hello(blueOnly, "BlueOnly", ["blue"]);
    await hello(bridge, "Bridge", ["main", "blue"]);

    const stamp = () => new Date().toISOString();
    mainOnly.send({
      t: "send",
      id: "s1",
      channel: "main",
      to: "Bridge",
      message: { id: "m1", from: "MainOnly", to: "Bridge", text: "via main", timestamp: stamp(), replyTo: null },
    });
    const viaMain = await bridge.next((frame) => frame.t === "message" && frame.message.id === "m1");
    expect(viaMain.t === "message" && viaMain.channel).toBe("main");
    expect(viaMain.t === "message" && viaMain.message.channel).toBe("main");

    blueOnly.send({
      t: "send",
      id: "s2",
      channel: "blue",
      to: "Bridge",
      message: { id: "m2", from: "BlueOnly", to: "Bridge", text: "via blue", timestamp: stamp(), replyTo: null },
    });
    const viaBlue = await bridge.next((frame) => frame.t === "message" && frame.message.id === "m2");
    expect(viaBlue.t === "message" && viaBlue.channel).toBe("blue");
    expect(viaBlue.t === "message" && viaBlue.message.channel).toBe("blue");

    mainOnly.send({
      t: "send",
      id: "s3",
      channel: "main",
      to: "BlueOnly",
      message: { id: "m3", from: "MainOnly", to: "BlueOnly", text: "unreachable", timestamp: stamp(), replyTo: null },
    });
    const absent = await mainOnly.next((frame) => isReply(frame, "s3"));
    expect(absent.t === "reply" && !Array.isArray(absent.result) && "error" in absent.result && absent.result.error).toBe("not_found");
  });

  it("joins and parts channels on a live socket", async () => {
    const server = start();
    const a = connect(server);
    const observer = connect(server);
    await hello(a, "A", ["main", "blue"]);
    await hello(observer, "MainObs", ["main"]);

    a.send({ t: "join", id: "j1", channels: ["green"] });
    const joined = await a.next((frame) => isReply(frame, "j1"));
    const green = replyChannels(joined, "j1")?.find((snap): snap is ChannelSnapshot => typeof snap === "object" && snap.channel === "green");
    expect(green?.channel).toBe("green");
    expect(green?.peers.some((peer) => peer.name === "A")).toBeTrue();

    a.send({ t: "part", id: "p1", channels: ["main"] });
    const parted = await a.next((frame) => isReply(frame, "p1"));
    expect(replyChannels(parted, "p1")).toEqual(["blue", "green"]);
    await observer.next((frame) => frame.t === "peers" && frame.channel === "main" && !frame.peers.some((peer) => peer.name === "A"));

    a.send({ t: "part", id: "p2", channels: ["blue", "green"] });
    const emptied = await a.next((frame) => isReply(frame, "p2"));
    expect(replyChannels(emptied, "p2")).toEqual([]);
    expect((await a.closed).code).toBe(1000);
  });

  it("rejects a hello when the name is taken in one requested channel", async () => {
    const server = start();
    await hello(connect(server), "A", ["main"]);
    const observer = connect(server);
    await hello(observer, "BlueObs", ["blue"]);

    const dup = connect(server);
    const rejected = await hello(dup, "A", ["main", "blue"]);
    expect(rejected).toEqual({ t: "reject", error: "name_taken", channel: "main" });

    // A bogus blue peers broadcast is debounced during hello processing, so it
    // precedes the reply to any later request on the observer's socket.
    observer.send({ t: "channels", id: "flush" });
    await observer.next((frame) => isReply(frame, "flush"));
    expect(observer.frames.some((frame) => frame.t === "peers" && frame.peers.some((peer) => peer.name === "A"))).toBeFalse();
  });

  it("refuses a rename when the new name exists in any joined channel", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    const c = connect(server);
    await hello(a, "A", ["main", "blue"]);
    await hello(b, "B", ["main"]);
    await hello(c, "C", ["blue"]);

    a.send({ t: "rename", id: "r1", name: "C" });
    const conflict = await a.next((frame) => isReply(frame, "r1"));
    expect(conflict.t === "reply" && !Array.isArray(conflict.result) && "error" in conflict.result && conflict.result.error).toBe("name_taken");

    a.send({ t: "rename", id: "r2", name: "Zed" });
    const renamed = await a.next((frame) => isReply(frame, "r2"));
    expect(renamed.t === "reply" && !Array.isArray(renamed.result) && "success" in renamed.result && renamed.result.success).toBeTrue();
    await b.next((frame) => frame.t === "peers" && frame.channel === "main" && frame.peers.some((peer) => peer.name === "Zed"));
    await c.next((frame) => frame.t === "peers" && frame.channel === "blue" && frame.peers.some((peer) => peer.name === "Zed"));
  });

  it("scopes claim broadcasts to their channel", async () => {
    const server = start();
    const mainOnly = connect(server);
    const bridge = connect(server);
    await hello(mainOnly, "MainOnly", ["main"]);
    await hello(bridge, "Bridge", ["main", "blue"]);

    bridge.send({ t: "claim", id: "c1", channel: "blue", spec: "spec", taskId: "T1" });
    const blueClaims = await bridge.next((frame) => frame.t === "claims" && frame.channel === "blue");
    expect(blueClaims.t === "claims" && blueClaims.claims.spec?.T1?.agent).toBe("Bridge");

    bridge.send({ t: "claim", id: "c2", channel: "main", spec: "spec", taskId: "T2" });
    const mainClaims = await mainOnly.next((frame) => frame.t === "claims" && frame.channel === "main");
    expect(mainClaims.t === "claims" && mainClaims.claims.spec?.T2?.agent).toBe("Bridge");
    expect(mainClaims.t === "claims" && mainClaims.claims.spec?.T1).toBeUndefined();
    expect(mainOnly.frames.some((frame) => frame.t === "claims" && frame.channel === "blue")).toBeFalse();
    expect(mainOnly.frames.some((frame) => frame.t === "claims" && frame.claims.spec?.T1 !== undefined)).toBeFalse();
  });
});

function replyResult<T>(frame: ServerFrame): T {
  if (frame.t !== "reply") throw new Error(`expected a reply, got ${frame.t}`);
  return frame.result as T;
}

function inboxMessage(client: TestClient, id: string) {
  return client.next((frame) => frame.t === "message" && frame.message.id === id);
}

describe("mesh server group chat", () => {
  it("pushes the channel list to every member when a channel appears and when it empties", async () => {
    const server = start();
    const observer = connect(server);
    const agent = connect(server);
    await hello(observer, "harsha", ["main"]);

    await hello(agent, "A", ["test"]);
    const created = await observer.next((frame) => frame.t === "channel_list" && frame.channels.some((c) => c.name === "test"));
    expect(created.t === "channel_list" && created.channels.find((c) => c.name === "test")?.members).toBe(1);

    agent.close();
    await observer.next((frame) => frame.t === "channel_list" && !frame.channels.some((c) => c.name === "test"));
  });

  it("notifies a watcher about deletion and does not recreate it from a stale hello after restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mesh-delete-reconnect-"));
    tempDirs.push(dataDir);
    const server = start(dataDir);
    const owner = connect(server);
    const watcher = connect(server);
    const offline = connect(server);
    await hello(owner, "Owner", ["main", "doomed"]);
    await hello(watcher, "Watcher", ["main"]);
    await hello(offline, "Offline", ["doomed"]);
    watcher.send({ t: "watch", id: "watch", channels: ["doomed"] });
    await watcher.next(frame => isReply(frame, "watch"));
    offline.close();
    await offline.closed;
    owner.send({ t: "delete_channel", id: "delete", channel: "doomed" });
    await owner.next(frame => isReply(frame, "delete"));
    expect(await watcher.next(frame => frame.t === "channel_deleted")).toEqual({ t: "channel_deleted", channel: "doomed", by: "Owner" });
    await server.stop();
    const restarted = start(dataDir);
    const returning = connect(restarted);
    const welcome = await hello(returning, "Offline", ["doomed"]);
    expect(welcome.t === "welcome" && welcome.channels.map(channel => channel.channel)).toEqual(["main"]);
    const notice = await returning.next(frame => frame.t === "message" && frame.message.text.includes("disconnected"));
    expect(notice.t === "message" && notice.message.to).toBe("Offline");
    returning.send({ t: "channels", id: "list" });
    const listed = await returning.next(frame => isReply(frame, "list"));
    expect(listed.t === "reply" && listed.result).toEqual([expect.objectContaining({ name: "main", members: 1 })]);
    returning.send({ t: "join", id: "recreate", channels: ["doomed"] });
    const recreated = await returning.next(frame => isReply(frame, "recreate"));
    expect(replyChannels(recreated, "recreate")?.map(channel => typeof channel === "string" ? channel : channel.channel)).toEqual(["doomed"]);
  });

  it("delivers a direct message only to its recipient and records it for the channel observer", async () => {
    const server = start();
    const human = connect(server);
    const recipient = connect(server);
    const observer = connect(server);
    await hello(human, "Human", ["main"]);
    await hello(recipient, "Recipient", ["main"]);
    await hello(observer, "Observer", ["main"]);
    observer.send({ t: "watch", id: "watch", channels: ["main"] });
    await observer.next(frame => isReply(frame, "watch"));
    human.send({
      t: "send", id: "direct", channel: "main", to: "Recipient", message: {
        id: "direct-message", from: "Human", to: "Recipient", text: "individual delivery", timestamp: new Date().toISOString(), replyTo: null,
      }
    });
    const delivered = await recipient.next(frame => frame.t === "message" && frame.message.id === "direct-message");
    expect(delivered.t === "message" && delivered.message).toMatchObject({ from: "Human", to: "Recipient", text: "individual delivery" });
    const logged = await observer.next(frame => frame.t === "log" && frame.entry.id === "direct-message");
    expect(logged.t === "log" && logged.entry).toMatchObject({ kind: "dm", from: "Human", to: "Recipient", text: "individual delivery" });
    expect(observer.frames.filter(frame => frame.t === "message")).toEqual([]);
  });

  it("deletes a channel with agents in it: removes and tells them, moves the stranded to main, drops the history", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mesh-delete-"));
    tempDirs.push(dataDir);
    const server = start(dataDir);
    const human = connect(server);
    const stranded = connect(server);
    const bridged = connect(server);
    await hello(human, "harsha", ["main", "test"]);
    await hello(stranded, "Storm", ["test"]);
    await hello(bridged, "Rogue", ["test", "blue"]);
    human.send({ t: "post", id: "p1", channel: "test", text: "doomed" });
    await human.next((frame) => isReply(frame, "p1"));

    human.send({ t: "delete_channel", id: "d1", channel: "test" });
    const reply = await human.next((frame) => isReply(frame, "d1"));
    expect(reply.t === "reply" && reply.result).toEqual({ ok: true, deleted: "test", removed: expect.arrayContaining(["Storm", "Rogue"]) });

    const stormRemoved = await stranded.next((frame) => frame.t === "removed");
    expect(stormRemoved).toMatchObject({ t: "removed", channel: "test", by: "harsha", channels: ["main"] });
    const stormTold = await stranded.next((frame) => frame.t === "message" && frame.message.text.startsWith("#test was deleted by harsha"));
    expect(stormTold.t === "message" && stormTold.message).toMatchObject({ from: "harsha", to: "Storm", channel: "main" });
    expect(stormTold.t === "message" && stormTold.message.text).toContain("#test was deleted by harsha");

    const rogueRemoved = await bridged.next((frame) => frame.t === "removed");
    expect(rogueRemoved).toMatchObject({ channel: "test", channels: ["blue"], added: [] });

    await human.next((frame) => frame.t === "peers" && frame.channel === "main" && frame.peers.some((peer) => peer.name === "Storm"));
    await human.next((frame) => frame.t === "channel_list" && !frame.channels.some((c) => c.name === "test"));
    human.send({ t: "history", id: "h1", channel: "test" });
    const history = await human.next((frame) => isReply(frame, "h1"));
    expect(history.t === "reply" && history.result).toMatchObject({ ok: true, entries: [] });

    human.send({ t: "delete_channel", id: "d2", channel: "main" });
    const refused = await human.next((frame) => isReply(frame, "d2"));
    expect(refused.t === "reply" && refused.result).toEqual({ ok: false, error: "protected" });
  });

  it("delivers a post to every other member, interrupting only the ones it mentions", async () => {
    const server = start();
    const human = connect(server);
    const storm = connect(server);
    const rogue = connect(server);
    await hello(human, "harsha");
    await hello(storm, "Storm");
    await hello(rogue, "Rogue");

    human.send({ t: "post", id: "p1", channel: "main", text: "@storm can you take the parser?" });
    const posted = replyResult<PostResult>(await human.next((frame) => isReply(frame, "p1")));
    if (!posted.ok) throw new Error(posted.error);
    expect(posted.entry.mentions).toEqual(["Storm"]);
    expect(posted.delivered.sort()).toEqual(["Rogue", "Storm"]);

    const toStorm = await inboxMessage(storm, posted.entry.id);
    const toRogue = await inboxMessage(rogue, posted.entry.id);
    expect(toStorm.t === "message" && toStorm.message).toMatchObject({ kind: "post", from: "harsha", channel: "main", mentions: ["Storm"] });
    expect(toStorm.t === "message" && toStorm.message.gentle).toBeUndefined();
    expect(toRogue.t === "message" && toRogue.message.gentle).toBe(true);
    expect(human.frames.some((frame) => frame.t === "message")).toBeFalse();
  });

  it("interrupts every member for @all and rejects posts from non-members and empty posts", async () => {
    const server = start();
    const a = connect(server);
    const b = connect(server);
    await hello(a, "A", ["main", "blue"]);
    await hello(b, "B", ["main"]);

    a.send({ t: "post", id: "p1", channel: "main", text: "@all standup" });
    const posted = replyResult<PostResult>(await a.next((frame) => isReply(frame, "p1")));
    if (!posted.ok) throw new Error(posted.error);
    const toB = await inboxMessage(b, posted.entry.id);
    expect(toB.t === "message" && toB.message.gentle).toBeUndefined();

    b.send({ t: "post", id: "p2", channel: "blue", text: "hi" });
    expect(replyResult<PostResult>(await b.next((frame) => isReply(frame, "p2")))).toEqual({ ok: false, error: "not_joined" });
    b.send({ t: "post", id: "p3", channel: "main", text: "   " });
    expect(replyResult<PostResult>(await b.next((frame) => isReply(frame, "p3")))).toEqual({ ok: false, error: "empty" });
  });

  it("logs posts and direct messages per channel, pages them oldest first, and keeps them across a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mesh-history-"));
    tempDirs.push(dataDir);
    const first = start(dataDir);
    const a = connect(first);
    const b = connect(first);
    await hello(a, "A");
    await hello(b, "B");
    for (let i = 1; i <= 3; i++) {
      a.send({ t: "post", id: `p${i}`, channel: "main", text: `post ${i}` });
      await a.next((frame) => isReply(frame, `p${i}`));
    }
    const dm = { id: "dm-1", from: "A", to: "B", text: "psst", timestamp: new Date().toISOString(), replyTo: null };
    a.send({ t: "send", id: "s1", channel: "main", to: "B", message: dm });
    await a.next((frame) => isReply(frame, "s1"));

    a.send({ t: "history", id: "h1", channel: "main", limit: 2 });
    const newest = replyResult<HistoryPage>(await a.next((frame) => isReply(frame, "h1")));
    if (!newest.ok) throw new Error(newest.error);
    expect(newest.hasMore).toBeTrue();
    expect(newest.entries.map((entry) => [entry.kind, entry.text, entry.to])).toEqual([["post", "post 3", null], ["dm", "psst", "B"]]);

    a.send({ t: "history", id: "h2", channel: "main", before: newest.entries[0]!.seq, limit: 10 });
    const older = replyResult<HistoryPage>(await a.next((frame) => isReply(frame, "h2")));
    if (!older.ok) throw new Error(older.error);
    expect(older.hasMore).toBeFalse();
    expect(older.entries.map((entry) => entry.text)).toEqual(["post 1", "post 2"]);

    await first.stop();
    servers.splice(servers.indexOf(first), 1);
    const second = start(dataDir);
    const c = connect(second);
    await hello(c, "C");
    c.send({ t: "history", id: "h3", channel: "main" });
    const restored = replyResult<HistoryPage>(await c.next((frame) => isReply(frame, "h3")));
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.entries.map((entry) => entry.text)).toEqual(["post 1", "post 2", "post 3", "psst"]);
  });

  it("streams a watched channel's log and presence to a non-member that cannot post there", async () => {
    const server = start();
    const observer = connect(server);
    const a = connect(server);
    const b = connect(server);
    await hello(observer, "harsha", ["main"]);
    await hello(a, "A", ["blue"]);
    await hello(b, "B", ["blue"]);

    observer.send({ t: "watch", id: "w1", channels: ["blue"] });
    const watched = replyResult<{ ok: true; watching: ChannelSnapshot[] }>(await observer.next((frame) => isReply(frame, "w1")));
    expect(watched.watching[0]?.peers.map((peer) => peer.name).sort()).toEqual(["A", "B"]);

    const dm = { id: "dm-2", from: "A", to: "B", text: "between us", timestamp: new Date().toISOString(), replyTo: null };
    a.send({ t: "send", id: "s1", channel: "blue", to: "B", message: dm });
    const logged = await observer.next((frame) => frame.t === "log" && frame.entry.kind === "dm");
    expect(logged.t === "log" && logged.entry).toMatchObject({ channel: "blue", from: "A", to: "B", text: "between us" });

    b.close();
    await observer.next((frame) => frame.t === "peers" && frame.channel === "blue" && !frame.peers.some((peer) => peer.name === "B"));

    observer.send({ t: "post", id: "p1", channel: "blue", text: "hello" });
    expect(replyResult<PostResult>(await observer.next((frame) => isReply(frame, "p1")))).toEqual({ ok: false, error: "not_joined" });
  });
});
