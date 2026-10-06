import { describe, expect, it } from "bun:test";
import type { HistoryEntry } from "../../lib.ts";
import { View } from "@stencil-hq/tern";
import { buildView, type ViewState } from "../../tern-plugin/app/view.ts";
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
    expect(normal.find("layer.members.mb-Human.identity.name")?.props.spans).toEqual([{ t: "Human", s: "strong" }]);
    expect(normal.find("layer.members.mb-Human.idle.label")?.props.text).toBe("Since activity");
    expect(normal.find("layer.members.mb-Human.session.label")?.props.text).toBe("Session age");
    expect(normal.find("dock.composer")?.props.sendable).toBe(true);
    channel.draft.text = "Keep this unsent draft";
    state.sidebars.channels = false;
    const withoutChannels = View.from(buildView(state));
    expect(withoutChannels.find("layer.rail")).toBeUndefined();
    expect(withoutChannels.find("layer.members.mb-Human")).toBeDefined();
    state.sidebars.members = false;
    const collapsed = View.from(buildView(state));
    expect(collapsed.find("layer.members")).toBeUndefined();
    expect(collapsed.find("dock.composer")?.props.text).toBe("Keep this unsent draft");
    expect(collapsed.find("dock.composer")?.props.sendable).toBe(true);
    state.dialog = { kind: "create", input: createComposer(), operation: { state: "ready" } };
    const modal = View.from(buildView(state));
    expect(modal.find("dock.composer")?.props.sendable).toBe(false);
    expect(modal.find("layer.dialog.body.input")?.kind).toBe("input");
    state.dialog = undefined;
    state.cols = 40;
    state.panel = "members";
    const narrow = View.from(buildView(state));
    expect(narrow.find("layer.panel.members.mb-Human.identity.name")?.props.spans).toEqual([{ t: "Human", s: "strong" }]);
  });
});
