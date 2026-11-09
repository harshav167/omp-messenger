import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AllCompletions, CompletionEntry, HistoryEntry } from "../lib.ts";

export class StorageError extends Error {
  constructor(
    readonly operation: string,
    options: { cause: unknown },
  ) {
    super(`Mesh storage failed during ${operation}`, options);
    this.name = "StorageError";
  }
}

export interface Persist {
  /** Verify that SQLite can open its write journal, not merely read the main file. */
  probe(): void;
  loadChannels(): Array<{ name: string; createdAt: string }>;
  saveChannel(name: string, createdAt: string): void;
  loadDeletedChannels(): string[];
  loadCompletions(channel: string): AllCompletions;
  saveCompletion(channel: string, spec: string, taskId: string, entry: CompletionEntry): void;
  /** Append to the channel log; duplicates return the original entry and delivery outcome. */
  appendMessage(
    entry: Omit<HistoryEntry, "seq">,
    delivered?: string[],
  ): { seq: number; duplicate: boolean; entry: HistoryEntry; delivered: string[] };
  /** Return the accepted entry for a client id while it remains in the retry window. */
  getMessage(channel: string, id: string): HistoryEntry | null;
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
  readonly delivered: string;
};

export function openPersist(dataDir: string): Persist {
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(join(dataDir, "mesh.sqlite"));
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA user_version = 1");
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
      reply_to TEXT,
      delivered TEXT NOT NULL DEFAULT '[]'
    )
  `);
  if (
    !database
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .some((column) => column.name === "delivered")
  ) {
    database.run("ALTER TABLE messages ADD COLUMN delivered TEXT NOT NULL DEFAULT '[]'");
  }
  database.run("CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages(channel, seq)");
  // Older databases allowed arbitrary duplicate ids. Preserve every row and give
  // every later duplicate a new id that cannot collide with any existing or generated id.
  const usedIds = new Set(
    database
      .query<{ channel: string; id: string }, []>("SELECT channel, id FROM messages")
      .all()
      .map((row) => JSON.stringify([row.channel, row.id])),
  );
  const updateLegacyId = database.query<undefined, [string, number]>(
    "UPDATE messages SET id = ? WHERE seq = ?",
  );
  database.transaction(() => {
    const duplicates = database
      .query<{ seq: number; channel: string; id: string }, []>(
        `SELECT seq, channel, id FROM messages
          WHERE seq NOT IN (SELECT MIN(seq) FROM messages GROUP BY channel, id)
          ORDER BY seq`,
      )
      .all();
    for (const row of duplicates) {
      const base = `${row.id}:legacy:${row.seq}`;
      let candidate = base;
      let suffix = 1;
      while (usedIds.has(JSON.stringify([row.channel, candidate]))) {
        candidate = `${base}:${suffix++}`;
      }
      updateLegacyId.run(candidate, row.seq);
      usedIds.add(JSON.stringify([row.channel, candidate]));
    }
  })();
  database.run("CREATE UNIQUE INDEX IF NOT EXISTS messages_channel_id ON messages(channel, id)");
  database.run("CREATE TABLE IF NOT EXISTS mesh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const selectChannels = database.query<ChannelRow, []>(
    "SELECT name, created_at FROM channels ORDER BY created_at, name",
  );
  const insertChannel = database.query<undefined, [string, string]>(
    "INSERT OR REPLACE INTO channels(name, created_at) VALUES (?, ?)",
  );
  const selectCompletions = database.query<CompletionRow, [string]>(
    "SELECT spec, task_id, completed_by, completed_at, notes FROM completions WHERE channel = ?",
  );
  const insertCompletion = database.query<
    undefined,
    [string, string, string, string, string, string | null]
  >(
    `INSERT OR REPLACE INTO completions
      (channel, spec, task_id, completed_by, completed_at, notes)
      VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = database.query<
    { seq: number },
    [string, string, string, string, string | null, string, string, string, string | null, string]
  >(
    `INSERT INTO messages
      (channel, id, kind, sender, recipient, mentions, text, timestamp, reply_to, delivered)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel, id) DO UPDATE SET channel = excluded.channel RETURNING seq`,
  );
  const selectMessageById = database.query<MessageRow, [string, string]>(
    "SELECT * FROM messages WHERE channel = ? AND id = ?",
  );
  const selectMessages = database.query<MessageRow, [string, number, number]>(
    "SELECT * FROM messages WHERE channel = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
  );
  const parseNames = (payload: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(payload);
      return Array.isArray(parsed)
        ? parsed.filter((name): name is string => typeof name === "string")
        : [];
    } catch {
      return [];
    }
  };
  const historyFromRow = (row: MessageRow): HistoryEntry => ({
    seq: row.seq,
    id: row.id,
    channel: row.channel,
    kind: row.kind === "post" ? "post" : "dm",
    from: row.sender,
    to: row.recipient,
    mentions: parseNames(row.mentions),
    text: row.text,
    timestamp: row.timestamp,
    replyTo: row.reply_to,
  });
  const appendMessage = database.transaction(
    (
      entry: Omit<HistoryEntry, "seq">,
      delivered: string[] = [],
    ): { seq: number; duplicate: boolean; entry: HistoryEntry; delivered: string[] } => {
      const existing = selectMessageById.get(entry.channel, entry.id);
      if (existing) {
        return {
          seq: existing.seq,
          duplicate: true,
          entry: historyFromRow(existing),
          delivered: parseNames(existing.delivered),
        };
      }
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
        JSON.stringify(delivered),
      );
      if (!row) throw new Error("messages insert returned no sequence number");
      database
        .query(
          `DELETE FROM messages WHERE channel = ? AND seq <= (
        SELECT seq FROM (SELECT seq FROM messages WHERE channel = ? ORDER BY seq DESC LIMIT 1 OFFSET 2000)
      )`,
        )
        .run(entry.channel, entry.channel);
      return {
        seq: row.seq,
        duplicate: false,
        entry: { ...entry, seq: row.seq },
        delivered: [...delivered],
      };
    },
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
    probe() {
      database
        .query("INSERT OR REPLACE INTO mesh_meta(key, value) VALUES ('write_probe', ?)")
        .run(new Date().toISOString());
    },
    loadDeletedChannels() {
      return database
        .query<{ name: string }, []>("SELECT name FROM deleted_channels")
        .all()
        .map((row) => row.name);
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
      insertCompletion.run(
        channel,
        spec,
        taskId,
        entry.completedBy,
        entry.completedAt,
        entry.notes ?? null,
      );
    },
    appendMessage,
    getMessage(channel, id) {
      const row = selectMessageById.get(channel, id);
      return row ? historyFromRow(row) : null;
    },
    pageMessages(channel, before, limit) {
      return selectMessages
        .all(channel, before ?? Number.MAX_SAFE_INTEGER, limit)
        .reverse()
        .map(historyFromRow);
    },
    close() {
      database.close();
    },
  };
}
