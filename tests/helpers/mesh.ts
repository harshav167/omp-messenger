import * as fs from "node:fs";
import { join } from "node:path";
import type { AgentMailMessage, MessengerState } from "../../lib.ts";
import { createFsMesh } from "../../mesh/fs.ts";
import type { Mesh } from "../../mesh/types.ts";

export interface TestMeshOptions {
  agentName?: string;
  cwd?: string;
  channels?: string[];
}

export interface TestMesh {
  mesh: Mesh;
  base: string;
  state: MessengerState;
  delivered: AgentMailMessage[];
}

export function createTestMesh(root: string, opts?: TestMeshOptions): TestMesh {
  const base = join(root, ".omp", "messenger");
  fs.mkdirSync(join(base, "registry"), { recursive: true });
  fs.mkdirSync(join(base, "inbox"), { recursive: true });

  const now = new Date().toISOString();
  const state: MessengerState = {
    agentName: opts?.agentName ?? "Self",
    explicitName: false,
    registered: false,
    channels: opts?.channels ?? ["main"],
    isCrewWorker: false,
    messagesSent: 0,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "",
    cwd: opts?.cwd ?? root,
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: now,
  };
  const delivered: AgentMailMessage[] = [];
  const mesh = createFsMesh(base, state, message => delivered.push(message));

  return { mesh, base, state, delivered };
}
