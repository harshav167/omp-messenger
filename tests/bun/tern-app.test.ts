import { describe, expect, it } from "bun:test";
import type { HistoryEntry } from "../../lib.ts";
import { View } from "@stencil-hq/tern";
import { buildView, COMPOSER_ID, STYLESHEET, type ViewState } from "../../tern-plugin/app/view.ts";
import {
  applyCompletion,
  applyNativeEdit,
  createChannel,
  createComposer,
  editComposer,
  findCompletion,
  insertText,
  mergeLog,
  recallHistory,
  submitComposer,
  replaceDraft,
  undoDraft,
} from "../../tern-plugin/app/model.ts";

const plain = { ctrl: false, alt: false, meta: false, shift: false };


describe("composer", () => {
  it("completes a mention at the caret: prefix matches first, @all always offered, self excluded", () => {
    const composer = createComposer();
    insertText(composer, "hey @st");
    const completion = findCompletion(composer, ["Storm", "Rogue", "harsha", "Gambit-Stark"], "harsha");
    expect(completion?.options).toEqual(["Storm", "Gambit-Stark"]);
    applyCompletion(composer, completion!, "Storm");
    expect(composer.text).toBe("hey @Storm ");
    expect(composer.cursor).toBe(composer.text.length);

    const bare = createComposer();
    insertText(bare, "@");
    expect(findCompletion(bare, ["Storm"], "harsha")?.options).toEqual(["all", "Storm"]);
    const email = createComposer();
    insertText(email, "me@st");
    expect(findCompletion(email, ["Storm"], "harsha")).toBeNull();
  });

  it("edits by word and line, and recalls sent drafts without losing the current one", () => {
    const composer = createComposer();
    insertText(composer, "first message");
    submitComposer(composer);
    insertText(composer, "draft words");
    editComposer(composer, { ...plain, name: "backspace", alt: true });
    expect(composer.text).toBe("draft ");
    expect(recallHistory(composer, -1)).toBe(true);
    expect(composer.text).toBe("first message");
    expect(recallHistory(composer, 1)).toBe(true);
    expect(composer.text).toBe("draft ");
    editComposer(composer, { ...plain, name: "u", ctrl: true });
    expect(composer.text).toBe("");
  });

  it("applies selection replacement as one undo step and ignores a stale edit", () => {
    const draft = createComposer();
    insertText(draft, "hello 🌍");
    expect(applyNativeEdit(draft, { from: 6, to: 8, text: "Tern", cursor: 10, len: 8 })).toBe(true);
    expect(draft.text).toBe("hello Tern");
    expect(applyNativeEdit(draft, { from: 0, to: 1, text: "x", cursor: 1, len: 8 })).toBe(false);
    expect(undoDraft(draft)).toBe(true);
    expect(draft.text).toBe("hello 🌍");
    submitComposer(draft);
    expect(undoDraft(draft)).toBe(true);
    expect(draft.text).toBe("hello 🌍");
  });

  it("keeps channel drafts separate and completes optional commands", () => {
    const main = createChannel("main", true);
    const blue = createChannel("blue", true);
    insertText(main.draft, "main draft");
    insertText(blue.draft, "/cre");
    const completion = findCompletion(blue.draft, [], "human");
    expect(completion?.options).toEqual(["/create"]);
    applyCompletion(blue.draft, completion!, "/create");
    expect(blue.draft.text).toBe("/create ");
    expect(main.draft.text).toBe("main draft");
    replaceDraft(blue.draft, "new draft");
    expect(main.draft.text).toBe("main draft");
  });

  it("loads an older history window at the memory limit without discarding the fetched page", () => {
    const entry = (seq: number): HistoryEntry => ({
      seq, id: `m${seq}`, channel: "main", kind: "post", from: "A", to: null, mentions: [], text: String(seq), timestamp: "", replyTo: null,
    });
    const recent = Array.from({ length: 2000 }, (_, index) => entry(index + 201));
    const older = Array.from({ length: 200 }, (_, index) => entry(index + 1));
    const window = mergeLog(recent, older, "oldest");
    expect(window.slice(0, 200).map(message => message.seq)).toEqual(older.map(message => message.seq));
    expect(window.at(-1)?.seq).toBe(2000);
    const newest = mergeLog(window, [entry(2201)]);
    expect(newest.at(-1)?.seq).toBe(2201);
  });

  it("merges logs by sequence: deduplicated, ordered", () => {
    const entry = (seq: number): HistoryEntry => ({
      seq, id: `m${seq}`, channel: "main", kind: "post", from: "A", to: null, mentions: [], text: String(seq), timestamp: "", replyTo: null,
    });
    expect(mergeLog([entry(3), entry(1)], [entry(2), entry(3)]).map(e => e.seq)).toEqual([1, 2, 3]);
  });
});

function chatState(cols: number): ViewState {
  const channel = createChannel("main", true);
  channel.members = [{
    name: "Storm", pid: 1, hostId: "local", sessionId: "s", cwd: "/repo", model: "claude-opus", isHuman: false,
    startedAt: new Date().toISOString(), activity: { lastActivityAt: new Date().toISOString(), currentActivity: "editing view.ts" },
    session: { tokens: 0, toolCalls: 0, filesModified: [] },
  }];
  return {
    self: "harsha", connection: "connected", url: "ws://localhost", channels: [channel, createChannel("creative", false)], active: "main",
    composer: channel.draft, completion: null, stuckThresholdMs: 300_000, cols, hour12: false, panel: null,
    sidebars: { channels: true, members: true },
  };
}

describe("chat layout", () => {
  it("keeps the header and the sidebars fixed beside the scrolling timeline, never over it", () => {
    const state = chatState(160);
    state.channels[0].log = [{ seq: 1, id: "m1", channel: "main", kind: "post", from: "Storm", to: null, mentions: [], text: "hello", timestamp: new Date().toISOString(), replyTo: null }];
    const wide = View.from(buildView(state));
    // Each message is its own child of main, the way Tern lays out, anchors and follows a transcript.
    expect(wide.find("main.m1")?.props.role).toBe("messenger.row-open-open");
    expect(wide.find("main.m1.msg")?.props.role).toBe("messenger.message");
    expect(wide.find("main.older")?.props.role).toBe("messenger.row-open-open");
    expect(wide.find("layer.header")?.props.role).toBe("messenger.header-open-open");
    expect(wide.find("layer.header.name")?.props.spans).toEqual([{ t: "#main", s: "strong" }]);
    expect(wide.find("main.timeline")).toBeUndefined();
    expect(wide.find(COMPOSER_ID)?.kind).toBe("editor");
    expect(wide.find("dock.chat")?.props.role).toBe("messenger.dock-open-open");
    expect(wide.find("layer.left.rail.list")?.kind).toBe("list");
    const storm = "layer.right.members.mb-Storm";
    expect(wide.find(`${storm}.identity.name`)?.props.spans).toEqual([{ t: "Storm", s: "strong" }]);
    expect(wide.find(`${storm}.identity.status`)?.props).toMatchObject({ text: "active", tone: "success" });
    expect(wide.find(`${storm}.about`)?.props.text).toBe("claude-opus");
    expect(wide.find(`${storm}.activity`)?.props.text).toBe("editing view.ts");
    expect(wide.find(`${storm}.idle.label`)?.props.text).toBe("Since activity");
    expect(wide.find(`${storm}.idle.value`)?.kind).toBe("elapsed");
    expect(wide.find(`${storm}.session.label`)?.props.text).toBe("Session age");
    expect(wide.find(`${storm}.session.value`)?.kind).toBe("elapsed");
    expect(wide.find(`${storm}.direct`)?.kind).toBe("el");
    expect(wide.find("layer.toolbar")).toBeUndefined();

    state.sidebars.channels = false;
    const slim = View.from(buildView(state));
    expect(slim.find("layer.left.rail")).toBeUndefined();
    expect(slim.find("layer.left")?.props.role).toBe("messenger.side-left-slim");
    expect(slim.find("main.older")?.props.role).toBe("messenger.row-slim-open");
    expect(slim.find("dock.chat")?.props.role).toBe("messenger.dock-slim-open");
  });

  it("styles every inset and panel role the layout can emit, at any pane width", () => {
    const roles = new Set<string>();
    for (const cols of [40, 100, 160]) {
      for (const channels of [true, false]) {
        for (const members of [true, false]) {
          const state = chatState(cols);
          state.sidebars = { channels, members };
          const view = View.from(buildView(state));
          for (const id of ["main.older", "dock.chat", "layer.header", "layer.left", "layer.right"]) {
            const role = view.find(id)?.props.role;
            if (typeof role === "string") roles.add(role);
          }
        }
      }
    }
    expect([...roles].sort()).toEqual([
      "messenger.dock-open-open", "messenger.dock-open-slim", "messenger.dock-sheet-sheet", "messenger.dock-slim-open", "messenger.dock-slim-slim",
      "messenger.header-open-open", "messenger.header-open-slim", "messenger.header-sheet-sheet", "messenger.header-slim-open", "messenger.header-slim-slim",
      "messenger.row-open-open", "messenger.row-open-slim", "messenger.row-sheet-sheet", "messenger.row-slim-open", "messenger.row-slim-slim",
      "messenger.side-left-open", "messenger.side-left-slim", "messenger.side-right-open", "messenger.side-right-slim",
    ]);
    for (const role of roles) expect(STYLESHEET).toContain(`[data-role='${role}']`);
  });
});

describe("native views", () => {
  it("renders a human without reservations and keeps the composer unavailable under a modal", () => {
    const channel = createChannel("main", true);
    channel.members = [{
      name: "Human", pid: 1, hostId: "local", sessionId: "session", cwd: "/repo", model: "human", isHuman: true,
      startedAt: new Date().toISOString(), activity: { lastActivityAt: new Date().toISOString() },
      session: { tokens: 0, toolCalls: 0, filesModified: [] },
    }];
    const state: ViewState = {
      self: "Human", connection: "connected", url: "ws://localhost", channels: [channel], active: "main",
      composer: channel.draft, completion: null, stuckThresholdMs: 300_000, cols: 150, hour12: false, panel: null,
      sidebars: { channels: true, members: true }
    };
    const normal = View.from(buildView(state));
    expect(normal.find("layer.right.members.mb-Human.identity.name")?.props.spans).toEqual([{ t: "Human", s: "strong" }]);
    expect(normal.find("layer.right.members.mb-Human.about")?.props.text).toBe("You · human");
    expect(normal.find("layer.right.members.mb-Human.direct")).toBeUndefined();
    expect(normal.find(COMPOSER_ID)?.props.sendable).toBe(true);
    channel.draft.text = "Keep this unsent draft";
    state.sidebars = { channels: false, members: false };
    const collapsed = View.from(buildView(state));
    expect(collapsed.find("layer.right.members")).toBeUndefined();
    expect(collapsed.find(COMPOSER_ID)?.props.text).toBe("Keep this unsent draft");
    expect(collapsed.find(COMPOSER_ID)?.props.sendable).toBe(true);
    state.dialog = { kind: "create", input: createComposer(), operation: { state: "ready" } };
    const modal = View.from(buildView(state));
    expect(modal.find(COMPOSER_ID)?.props.sendable).toBe(false);
    expect(modal.find("layer.dialog.body.input")?.kind).toBe("input");
    state.dialog = undefined;
    state.cols = 40;
    state.panel = "members";
    const narrow = View.from(buildView(state));
    expect(narrow.find("layer.left")).toBeUndefined();
    expect(narrow.find("layer.right")).toBeUndefined();
    expect(narrow.find("layer.header.members")?.kind).toBe("el");
    expect(narrow.find("main.older")?.props.role).toBe("messenger.row-sheet-sheet");
    expect(narrow.find("layer.panel.members.mb-Human.identity.name")?.props.spans).toEqual([{ t: "Human", s: "strong" }]);
  });
});
