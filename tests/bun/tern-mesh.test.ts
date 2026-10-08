import { expect, it } from "bun:test";
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
      state() { }, welcome() { ready.resolve(); }, peers() { }, log() { }, channels() { },
      direct(value) { if (value.text === "Only Recipient receives this") message.resolve(value); },
      removed(_channel, _by, channels) { removed.resolve(channels); },
      deleted(channel) { deleted.resolve(channel); },
    };
    const mesh = new MessengerMesh({ url: `ws://127.0.0.1:${server.port}`, token: "test", name, channels: ["main"], cwd: "/test", identityKey: KEY }, events);
    meshes.push(mesh);
    mesh.connect();
    return { mesh, ready: ready.promise, message: message.promise, removed: removed.promise, deleted: deleted.promise };
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
    expect(await recipient.message).toMatchObject({ from: "Human", to: "Recipient", channel: "temporary", text: "Only Recipient receives this" });
    const page = await human.mesh.history("temporary");
    expect(page?.ok && page.entries.map(entry => ({ kind: entry.kind, text: entry.text }))).toEqual([
      { kind: "post", text: "@all group post" },
      { kind: "dm", text: "Only Recipient receives this" },
    ]);
    const deletion = await human.mesh.deleteChannel("temporary");
    expect(deletion?.ok).toBe(true);
    expect(await recipient.removed).toEqual(["main"]);
    expect(await recipient.deleted).toBe("temporary");
    expect(recipient.mesh.channels).toEqual(["main"]);
    const channels = await human.mesh.listChannels();
    expect(channels?.map(channel => channel.name)).toEqual(["main"]);
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
      state() { }, welcome(name) { welcomed.resolve(name); }, peers() { }, log() { }, channels() { }, direct() { }, removed() { }, deleted() { },
    };
    const mesh = new MessengerMesh({ url: `ws://127.0.0.1:${server.port}`, token: "test", name: "harsha", channels: ["main"], cwd: "/test", identityKey: KEY }, events);
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
