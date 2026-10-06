import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AllCompletions, CompletionEntry, HistoryEntry } from "../lib.ts";

export interface Persist {
  loadChannels(): Array<{ name: string; createdAt: string }>;
  saveChannel(name: string, createdAt: string): void;
  loadDeletedChannels(): string[];
  loadCompletions(channel: string): AllCompletions;
  saveCompletion(channel: string, spec: string, taskId: string, entry: CompletionEntry): void;
  /** Append to the channel log; returns the entry's sequence number. */
  appendMessage(entry: Omit<HistoryEntry, "seq">): number;
  /** Up to `limit` entries of `channel` with `seq < before` (all when omitted), oldest first. */
  pageMessages(channel: string, before: number | undefined, limit: number): HistoryEntry[];
  /** Remove a channel with its message log and task completions. */
  deleteChannel(channel: string): void;
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

type MessageRow = {
  readonly seq: number;
  readonly channel: string;
  readonly id: string;
  readonly kind: string;
  readonly sender: string;
  readonly recipient: string | null;
  readonly mentions: string;
  readonly text: string;
  readonly timestamp: string;
  readonly reply_to: string | null;
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
  database.run("CREATE TABLE IF NOT EXISTS deleted_channels (name TEXT PRIMARY KEY)");
  database.run(`
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT,
      mentions TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      reply_to TEXT
    )
  `);
  database.run("CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages(channel, seq)");

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
  const insertMessage = database.query<{ seq: number }, [string, string, string, string, string | null, string, string, string, string | null]>(
    `INSERT INTO messages (channel, id, kind, sender, recipient, mentions, text, timestamp, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
  );
  const selectMessages = database.query<MessageRow, [string, number, number]>(
    "SELECT * FROM messages WHERE channel = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
  );
  const deleteChannelRows = database.transaction((channel: string) => {
    database.query("DELETE FROM messages WHERE channel = ?").run(channel);
    database.query("DELETE FROM completions WHERE channel = ?").run(channel);
    database.query("DELETE FROM channels WHERE name = ?").run(channel);
    database.query("INSERT OR IGNORE INTO deleted_channels(name) VALUES (?)").run(channel);
  });
  const saveChannelRows = database.transaction((name: string, createdAt: string) => {
    insertChannel.run(name, createdAt);
    database.query("DELETE FROM deleted_channels WHERE name = ?").run(name);
  });

  return {
    loadDeletedChannels() {
      return database.query<{ name: string }, []>("SELECT name FROM deleted_channels").all().map(row => row.name);
    },
    deleteChannel(channel) {
      deleteChannelRows(channel);
    },
    loadChannels() {
      return selectChannels.all().map((row) => ({ name: row.name, createdAt: row.created_at }));
    },
    saveChannel(name, createdAt) {
      saveChannelRows(name, createdAt);
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
    appendMessage(entry) {
      const row = insertMessage.get(
        entry.channel,
        entry.id,
        entry.kind,
        entry.from,
        entry.to,
        JSON.stringify(entry.mentions),
        entry.text,
        entry.timestamp,
        entry.replyTo,
      );
      if (!row) throw new Error("messages insert returned no sequence number");
      return row.seq;
    },
    pageMessages(channel, before, limit) {
      return selectMessages
        .all(channel, before ?? Number.MAX_SAFE_INTEGER, limit)
        .reverse()
        .map((row) => ({
          seq: row.seq,
          id: row.id,
          channel: row.channel,
          kind: row.kind === "post" ? "post" : "dm",
          from: row.sender,
          to: row.recipient,
          mentions: JSON.parse(row.mentions) as string[],
          text: row.text,
          timestamp: row.timestamp,
          replyTo: row.reply_to,
        }));
    },
    close() {
      database.close();
    },
  };
}
