import { expect, it, vi } from "bun:test";
import { MessengerMesh, type MeshClientEvents } from "../../tern-plugin/app/mesh.ts";
import { startMeshServer } from "../../mesh/server.ts";
import type { AgentMailMessage } from "../../lib.ts";

const KEY = "k".repeat(43);

it("the app joins, delivers individually, reads history, and applies deletion through the real WebSocket client", async () => {
  const server = startMeshServer({ port: 0, hostname: "127.0.0.1", token: "test" });
  const meshes: MessengerMesh[] = [];
  const make = (name: string) => {
    const ready = Promise.withResolvers<void>();
    const message = Promise.withResolvers<AgentMailMessage>();
    const removed = Promise.withResolvers<string[]>();
    const deleted = Promise.withResolvers<string>();
    const events: MeshClientEvents = {
      state() {},
      welcome() {
        ready.resolve();
      },
      peers() {},
      log() {},
      channels() {},
      direct(value) {
        if (value.text === "Only Recipient receives this") message.resolve(value);
      },
      removed(_channel, _by, channels) {
        removed.resolve(channels);
      },
      deleted(channel) {
        deleted.resolve(channel);
      },
    };
    const mesh = new MessengerMesh(
      {
        url: `ws://127.0.0.1:${server.port}`,
        token: "test",
        name,
        channels: ["main"],
        cwd: "/test",
        identityKey: KEY,
      },
      events,
    );
    meshes.push(mesh);
    mesh.connect();
    return {
      mesh,
      ready: ready.promise,
      message: message.promise,
      removed: removed.promise,
      deleted: deleted.promise,
    };
  };
  try {
    const human = make("Human");
    const recipient = make("Recipient");
    await Promise.all([human.ready, recipient.ready]);
    const joined = await human.mesh.join("temporary");
    expect(typeof joined === "object" && joined.channel).toBe("temporary");
    await recipient.mesh.join("temporary");
    const post = await human.mesh.post("temporary", "@all group post");
    expect(post?.ok && post.entry.mentions).toEqual(["all"]);
    const sent = await human.mesh.send("temporary", "Recipient", "Only Recipient receives this");
    expect(sent?.ok).toBe(true);
    expect(await recipient.message).toMatchObject({
      from: "Human",
      to: "Recipient",
      channel: "temporary",
      text: "Only Recipient receives this",
    });
    const page = await human.mesh.history("temporary");
    expect(
      page?.ok && page.entries.map((entry) => ({ kind: entry.kind, text: entry.text })),
    ).toEqual([
      { kind: "post", text: "@all group post" },
      { kind: "dm", text: "Only Recipient receives this" },
    ]);
    const deletion = await human.mesh.deleteChannel("temporary");
    expect(deletion?.ok).toBe(true);
    expect(await recipient.removed).toEqual(["main"]);
    expect(await recipient.deleted).toBe("temporary");
    expect(recipient.mesh.channels).toEqual(["main"]);
    const channels = await human.mesh.listChannels();
    expect(channels?.map((channel) => channel.name)).toEqual(["main"]);
  } finally {
    for (const mesh of meshes) mesh.close();
    await server.stop();
  }
});

it("two app windows of one person both connect under their name through the real WebSocket client", async () => {
  const server = startMeshServer({ port: 0, hostname: "127.0.0.1", token: "test" });
  const windows: MessengerMesh[] = [];
  const open = (): Promise<string> => {
    const welcomed = Promise.withResolvers<string>();
    const events: MeshClientEvents = {
      state() {},
      welcome(name) {
        welcomed.resolve(name);
      },
      peers() {},
      log() {},
      channels() {},
      direct() {},
      removed() {},
      deleted() {},
    };
    const mesh = new MessengerMesh(
      {
        url: `ws://127.0.0.1:${server.port}`,
        token: "test",
        name: "harsha",
        channels: ["main"],
        cwd: "/test",
        identityKey: KEY,
      },
      events,
    );
    windows.push(mesh);
    mesh.connect();
    return welcomed.promise;
  };
  try {
    expect(await Promise.all([open(), open()])).toEqual(["harsha", "harsha"]);
  } finally {
    for (const mesh of windows) mesh.close();
    await server.stop();
  }
});

it("reads a channel's whole history across pages for copying", async () => {
  const server = startMeshServer({ port: 0, hostname: "127.0.0.1", token: "test" });
  const welcomed = Promise.withResolvers<void>();
  const events: MeshClientEvents = {
    state() {},
    welcome() {
      welcomed.resolve();
    },
    peers() {},
    log() {},
    channels() {},
    direct() {},
    removed() {},
    deleted() {},
  };
  const mesh = new MessengerMesh(
    {
      url: `ws://127.0.0.1:${server.port}`,
      token: "test",
      name: "harsha",
      channels: ["main"],
      cwd: "/test",
      identityKey: KEY,
    },
    events,
  );
  try {
    mesh.connect();
    await welcomed.promise;
    for (let i = 1; i <= 5; i++) await mesh.post("main", `post ${i}`);
    const all = await mesh.allHistory("main", 2);
    expect(all.ok && all.entries.map((entry) => entry.text)).toEqual([
      "post 1",
      "post 2",
      "post 3",
      "post 4",
      "post 5",
    ]);
  } finally {
    mesh.close();
    await server.stop();
  }
});

it("reconnects silent sockets and cancels retry and request timers on close", async () => {
  vi.useFakeTimers();
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      sockets.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const states: string[] = [];
  const events: MeshClientEvents = {
    state(state) {
      states.push(state);
    },
    welcome() {},
    peers() {},
    log() {},
    channels() {},
    direct() {},
    removed() {},
    deleted() {},
  };
  const mesh = new MessengerMesh(
    {
      url: "ws://localhost",
      token: "test",
      name: "harsha",
      channels: ["main"],
      cwd: "/test",
      identityKey: KEY,
    },
    events,
  );
  try {
    mesh.connect();
    sockets[0]!.dispatchEvent(new Event("open"));
    vi.advanceTimersByTime(10_000);
    expect(states).toContain("reconnecting");
    vi.advanceTimersByTime(1_201);
    expect(sockets.length).toBe(2);
    const pending = mesh.history("main");
    mesh.close();
    expect(await pending).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(sockets.length).toBe(2);
  } finally {
    mesh.close();
    globalThis.WebSocket = original;
    vi.useRealTimers();
  }
});

it("reuses an unconfirmed post identity and clears it after a definitive reply", async () => {
  vi.useFakeTimers();
  const original = globalThis.WebSocket;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    readonly sent: string[] = [];
    send(data: string) {
      this.sent.push(String(data));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  let socket: FakeSocket;
  globalThis.WebSocket = class extends FakeSocket {
    constructor() {
      super();
      socket = this;
    }
  } as unknown as typeof WebSocket;
  const events: MeshClientEvents = {
    state() {},
    welcome() {},
    peers() {},
    log() {},
    channels() {},
    direct() {},
    removed() {},
    deleted() {},
  };
  const mesh = new MessengerMesh(
    {
      url: "ws://localhost",
      token: "test",
      name: "harsha",
      channels: ["main"],
      cwd: "/test",
      identityKey: KEY,
    },
    events,
  );
  const sentPosts = (): Array<{ id: string; messageId: string }> =>
    socket.sent
      .map((data) => JSON.parse(data) as { t: string; id: string; messageId?: string })
      .filter((frame) => frame.t === "post")
      .map((frame) => ({ id: frame.id, messageId: frame.messageId! }));
  const reply = (id: string, messageId: string): void => {
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          t: "reply",
          id,
          result: {
            ok: true,
            entry: {
              seq: 1,
              id: messageId,
              channel: "main",
              kind: "post",
              from: "harsha",
              to: null,
              mentions: [],
              text: "same draft",
              timestamp: new Date().toISOString(),
              replyTo: null,
            },
            delivered: [],
          },
        }),
      }),
    );
  };
  try {
    mesh.connect();
    socket!.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ t: "welcome", name: "harsha", channels: [] }),
      }),
    );
    const first = mesh.post("main", "same draft");
    const firstFrame = sentPosts()[0]!;
    vi.advanceTimersByTime(10_000);
    expect(await first).toBeNull();

    const retry = mesh.post("main", "same draft");
    const retryFrame = sentPosts()[1]!;
    expect(retryFrame).toEqual(firstFrame);
    reply(retryFrame.id, retryFrame.messageId);
    expect((await retry)?.ok).toBe(true);

    const next = mesh.post("main", "same draft");
    const nextFrame = sentPosts()[2]!;
    expect(nextFrame.id).not.toBe(firstFrame.id);
    expect(nextFrame.messageId).not.toBe(firstFrame.messageId);
    reply(nextFrame.id, nextFrame.messageId);
    expect((await next)?.ok).toBe(true);
  } finally {
    mesh.close();
    globalThis.WebSocket = original;
    vi.useRealTimers();
  }
});

it("reconnects a welcomed socket that stops sending frames", () => {
  vi.useFakeTimers();
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      sockets.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const states: string[] = [];
  const events: MeshClientEvents = {
    state(state) {
      states.push(state);
    },
    welcome() {},
    peers() {},
    log() {},
    channels() {},
    direct() {},
    removed() {},
    deleted() {},
  };
  const mesh = new MessengerMesh(
    {
      url: "ws://localhost",
      token: "test",
      name: "harsha",
      channels: ["main"],
      cwd: "/test",
      identityKey: KEY,
    },
    events,
  );
  try {
    mesh.connect();
    sockets[0]!.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ t: "welcome", name: "harsha", channels: [] }),
      }),
    );
    vi.advanceTimersByTime(60_000);
    expect(states).toContain("reconnecting");
    vi.advanceTimersByTime(1_201);
    expect(sockets.length).toBe(2);
  } finally {
    mesh.close();
    globalThis.WebSocket = original;
    vi.useRealTimers();
  }
});
