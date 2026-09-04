import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AllCompletions, CompletionEntry } from "../lib.ts";

export interface Persist {
  loadChannels(): Array<{ name: string; createdAt: string }>;
  saveChannel(name: string, createdAt: string): void;
  loadCompletions(channel: string): AllCompletions;
  saveCompletion(channel: string, spec: string, taskId: string, entry: CompletionEntry): void;
  close(): void;
}

type ChannelRow = {
  readonly name: string;
  readonly created_at: string;
};

type CompletionRow = {
  readonly spec: string;
  readonly task_id: string;
  readonly completed_by: string;
  readonly completed_at: string;
  readonly notes: string | null;
};

export function openPersist(dataDir: string): Persist {
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(join(dataDir, "mesh.sqlite"));
  database.run(`
    CREATE TABLE IF NOT EXISTS completions (
      channel TEXT NOT NULL,
      spec TEXT NOT NULL,
      task_id TEXT NOT NULL,
      completed_by TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      notes TEXT,
      PRIMARY KEY (channel, spec, task_id)
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )
  `);

  const selectChannels = database.query<ChannelRow, []>(
    "SELECT name, created_at FROM channels ORDER BY created_at, name",
  );
  const insertChannel = database.query<undefined, [string, string]>(
    "INSERT OR REPLACE INTO channels(name, created_at) VALUES (?, ?)",
  );
  const selectCompletions = database.query<CompletionRow, [string]>(
    "SELECT spec, task_id, completed_by, completed_at, notes FROM completions WHERE channel = ?",
  );
  const insertCompletion = database.query<undefined, [string, string, string, string, string, string | null]>(
    `INSERT OR REPLACE INTO completions
      (channel, spec, task_id, completed_by, completed_at, notes)
      VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return {
    loadChannels() {
      return selectChannels.all().map((row) => ({ name: row.name, createdAt: row.created_at }));
    },
    saveChannel(name, createdAt) {
      insertChannel.run(name, createdAt);
    },
    loadCompletions(channel) {
      const completions: AllCompletions = {};
      for (const row of selectCompletions.all(channel)) {
        const spec = completions[row.spec] ?? {};
        spec[row.task_id] = {
          completedBy: row.completed_by,
          completedAt: row.completed_at,
          ...(row.notes === null ? {} : { notes: row.notes }),
        };
        completions[row.spec] = spec;
      }
      return completions;
    },
    saveCompletion(channel, spec, taskId, entry) {
      insertCompletion.run(channel, spec, taskId, entry.completedBy, entry.completedAt, entry.notes ?? null);
    },
    close() {
      database.close();
    },
  };
}
