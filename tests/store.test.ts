import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentRegistration, LOCAL_HOST_ID } from "../lib.ts";
import { invalidateAgentsCache } from "../mesh/fs.ts";
import type { Mesh } from "../mesh/types.ts";
import { createMockContext } from "./helpers/mock-context.ts";
import { createTestMesh } from "./helpers/mesh.ts";

const roots = new Set<string>();
const meshes = new Set<Mesh>();
const initialCwd = process.cwd();

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-store-test-"));
  roots.add(root);
  return root;
}

function trackMesh(mesh: Mesh): Mesh {
  meshes.add(mesh);
  return mesh;
}

function createContext(cwd: string) {
  const ctx = createMockContext(cwd);
  Object.assign(ctx, { hasUI: false, model: { id: "test-model" } });
  return ctx;
}

interface RegistrationFixture {
  name: string;
  cwd: string;
  hostId?: string;
}

function writeRegistration(registryDir: string, fixture: RegistrationFixture): void {
  const { name, cwd, hostId = LOCAL_HOST_ID } = fixture;
  const now = new Date().toISOString();
  const registration: AgentRegistration = {
    name,
    pid: process.pid,
    hostId,
    sessionId: "session-1",
    cwd,
    model: "test-model",
    startedAt: now,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now },
  };
  fs.writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(registration));
}

afterEach(() => {
  for (const mesh of meshes) mesh.close();
  meshes.clear();
  invalidateAgentsCache();
  process.chdir(initialCwd);
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup races from failed tests.
    }
  }
  roots.clear();
});

describe("filesystem mesh cwd scoping", () => {
  it("matches scoped agents using canonical cwd", () => {
    const root = createTempRoot();
    const fixture = createTestMesh(root);
    const mesh = trackMesh(fixture.mesh);
    const actualProject = path.join(root, "project");
    const aliasProject = path.join(root, "project-alias");

    fs.mkdirSync(actualProject, { recursive: true });
    fs.symlinkSync(actualProject, aliasProject, "dir");
    fixture.state.scopeToFolder = true;
    fixture.state.cwd = aliasProject;
    writeRegistration(path.join(fixture.base, "registry"), { name: "Peer", cwd: actualProject });

    process.chdir(aliasProject);
    const agents = mesh.peers();

    expect(agents.map(agent => agent.name)).toEqual(["Peer"]);
  });

  it("uses state.cwd instead of process.cwd for scoped agent matching", () => {
    const root = createTempRoot();
    const fixture = createTestMesh(root);
    const mesh = trackMesh(fixture.mesh);
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");

    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    fixture.state.scopeToFolder = true;
    fixture.state.cwd = projectA;
    writeRegistration(path.join(fixture.base, "registry"), { name: "PeerA", cwd: projectA });
    writeRegistration(path.join(fixture.base, "registry"), { name: "PeerB", cwd: projectB });

    process.chdir(projectB);
    const agents = mesh.peers();

    expect(agents.map(agent => agent.name)).toEqual(["PeerA"]);
  });

  it("excludes registrations from another host when folder scoping is enabled", () => {
    const root = createTempRoot();
    const fixture = createTestMesh(root);
    const mesh = trackMesh(fixture.mesh);
    fixture.state.scopeToFolder = true;
    writeRegistration(path.join(fixture.base, "registry"), {
      name: "RemotePeer",
      cwd: root,
      hostId: "remote-host",
    });

    expect(mesh.peers()).toEqual([]);
  });

  it("registers the session using ctx.cwd instead of process.cwd", async () => {
    const root = createTempRoot();
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    const fixture = createTestMesh(root, { cwd: projectA });
    const mesh = trackMesh(fixture.mesh);

    process.chdir(projectB);
    expect(await mesh.join(createContext(projectA))).toBe(true);

    const expectedCwd = fs.realpathSync.native(projectA);
    const registration = JSON.parse(
      fs.readFileSync(path.join(fixture.base, "registry", "Self.json"), "utf-8"),
    ) as AgentRegistration;
    expect(registration.cwd).toBe(expectedCwd);
    expect(registration.hostId).toBe(LOCAL_HOST_ID);
    expect(fixture.state.cwd).toBe(expectedCwd);
  });
});

describe("filesystem mesh inbox", () => {
  it("normalizes message and ts fields before delivery", () => {
    const root = createTempRoot();
    const fixture = createTestMesh(root);
    const mesh = trackMesh(fixture.mesh);
    const inbox = path.join(fixture.base, "inbox", "Self");
    fs.mkdirSync(inbox, { recursive: true });
    const timestamp = "2026-08-23T12:00:00.000Z";
    fs.writeFileSync(path.join(inbox, "1.json"), JSON.stringify({
      from: "Peer",
      to: "Self",
      message: "Historical body",
      ts: timestamp,
      replyTo: 123,
    }));
    fixture.state.registered = true;

    mesh.drainInbox();

    expect(fixture.delivered).toEqual([
      {
        id: "1",
        from: "Peer",
        to: "Self",
        text: "Historical body",
        timestamp,
        replyTo: null,
      },
    ]);
    expect(fs.readdirSync(inbox)).toEqual([]);
  });
});

describe("filesystem mesh channels", () => {
  it("registers non-main channels in their own directory", async () => {
    const root = createTempRoot();
    const fixture = createTestMesh(root);
    const mesh = trackMesh(fixture.mesh);

    expect(await mesh.join(createContext(root), { channel: "alpha" })).toBe(true);

    expect(fs.existsSync(path.join(fixture.base, "channels", "alpha", "registry", "Self.json"))).toBe(true);
  });

  it("lists main and named channels with their live member counts", async () => {
    const root = createTempRoot();
    const mainFixture = createTestMesh(root, { agentName: "MainAgent" });
    const alphaFixture = createTestMesh(root, { agentName: "AlphaAgent" });
    const mainMesh = trackMesh(mainFixture.mesh);
    const alphaMesh = trackMesh(alphaFixture.mesh);

    expect(await mainMesh.join(createContext(root))).toBe(true);
    expect(await alphaMesh.join(createContext(root), { channel: "alpha" })).toBe(true);

    const channels = await mainMesh.channels();

    expect(channels.map(({ name, members }) => ({ name, members }))).toEqual([
      { name: "main", members: 1 },
      { name: "alpha", members: 1 },
    ]);
  });
});
