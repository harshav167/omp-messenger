import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openPersist, type Persist } from "../../mesh/persist.ts";
import type { HistoryEntry } from "../../lib.ts";

const dirs: string[] = [];
const stores: Persist[] = [];
function store(): Persist {
  const dir = mkdtempSync(join(tmpdir(), "mesh-persist-"));
  dirs.push(dir);
  const persist = openPersist(dir);
  stores.push(persist);
  return persist;
}
function entry(id: string): Omit<HistoryEntry, "seq"> {
  return {
    id,
    channel: "main",
    kind: "post",
    from: "A",
    to: null,
    mentions: [],
    text: "hello",
    timestamp: "2026-01-01T00:00:00.000Z",
    replyTo: null,
  };
}

afterEach(() => {
  for (const persist of stores.splice(0)) persist.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mesh persistence", () => {
  it("verifies write access and performs idempotent appends", () => {
    const persist = store();
    expect(() => persist.probe()).not.toThrow();
    const first = persist.appendMessage(entry("same-id"), ["Recipient"]);
    expect(first.duplicate).toBeFalse();
    expect(
      persist.appendMessage(
        { ...entry("same-id"), text: "changed", timestamp: "2027-01-01T00:00:00.000Z" },
        ["SomeoneElse"],
      ),
    ).toEqual({
      seq: first.seq,
      duplicate: true,
      entry: { ...entry("same-id"), seq: first.seq },
      delivered: ["Recipient"],
    });
    expect(persist.pageMessages("main", undefined, 10).map((message) => message.id)).toEqual([
      "same-id",
    ]);
  });

  it("bounds retained history per channel", () => {
    const persist = store();
    for (let index = 0; index < 2005; index++) persist.appendMessage(entry(`message-${index}`));
    const page = persist.pageMessages("main", undefined, 1);
    expect(page).toHaveLength(1);
    expect(page[0]?.id).toBe("message-2004");
    const retained = persist.pageMessages("main", page[0]?.seq, 2000);
    expect(retained).toHaveLength(1999);
    expect(retained[0]?.id).toBe("message-5");
  });

  it("migrates existing duplicate ids before enforcing idempotency", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-duplicate-migration-"));
    dirs.push(dir);
    const path = join(dir, "mesh.sqlite");
    const database = new Database(path);
    database.run(`CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, id TEXT NOT NULL,
      kind TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT, mentions TEXT NOT NULL,
      text TEXT NOT NULL, timestamp TEXT NOT NULL, reply_to TEXT
    )`);
    const insert = database.query(
      "INSERT INTO messages(channel,id,kind,sender,recipient,mentions,text,timestamp,reply_to) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    insert.run("main", "duplicate", "post", "A", null, "[]", "first", "2026-01-01", null);
    insert.run("main", "duplicate", "post", "A", null, "[]", "second", "2026-01-02", null);
    insert.run(
      "main",
      "duplicate:legacy:2",
      "post",
      "A",
      null,
      "[]",
      "existing collision",
      "2026-01-03",
      null,
    );
    insert.run("main", "abc:legacy:1", "post", "A", null, "[]", "legacy first", "2026-01-04", null);
    insert.run(
      "main",
      "abc:legacy:1",
      "post",
      "A",
      null,
      "[]",
      "legacy second",
      "2026-01-05",
      null,
    );
    database.close();
    const persist = openPersist(dir);
    stores.push(persist);
    expect(
      persist.pageMessages("main", undefined, 10).map((message) => [message.id, message.text]),
    ).toEqual([
      ["duplicate", "first"],
      ["duplicate:legacy:2:1", "second"],
      ["duplicate:legacy:2", "existing collision"],
      ["abc:legacy:1", "legacy first"],
      ["abc:legacy:1:legacy:5", "legacy second"],
    ]);
    expect(persist.appendMessage(entry("duplicate")).duplicate).toBeTrue();
    expect(persist.appendMessage(entry("abc:legacy:1")).duplicate).toBeTrue();
  });

  it("survives a corrupt mentions payload without losing the stored text", () => {
    const persist = store();
    persist.appendMessage(entry("good"));
    const path = join(dirs[0]!, "mesh.sqlite");
    persist.close();
    stores.length = 0;
    const database = new Database(path);
    database.query("UPDATE messages SET mentions = 'not-json'").run();
    database.close();
    const reopened = openPersist(dirs[0]!);
    stores.push(reopened);
    expect(reopened.pageMessages("main", undefined, 10)[0]).toMatchObject({
      id: "good",
      text: "hello",
      mentions: [],
    });
  });
});
