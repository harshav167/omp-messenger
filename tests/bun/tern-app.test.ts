import { describe, expect, it } from "bun:test";
import type { HistoryEntry } from "../../lib.ts";
import { View, type Session, type ViewInput } from "@stencil-hq/tern";
import { MessengerApp } from "../../tern-plugin/app/main.ts";
import { buildView, COMPOSER_ID, STYLESHEET, type ViewState } from "../../tern-plugin/app/view.ts";
import {
  applyCompletion,
  applyNativeEdit,
  createChannel,
  createComposer,
  editComposer,
  chatTranscript,
  clipboardSequence,
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
    const completion = findCompletion(
      composer,
      ["Storm", "Rogue", "harsha", "Gambit-Stark"],
      "harsha",
    );
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
      seq,
      id: `m${seq}`,
      channel: "main",
      kind: "post",
      from: "A",
      to: null,
      mentions: [],
      text: String(seq),
      timestamp: "",
      replyTo: null,
    });
    const recent = Array.from({ length: 2000 }, (_, index) => entry(index + 201));
    const older = Array.from({ length: 200 }, (_, index) => entry(index + 1));
    const window = mergeLog(recent, older, "oldest");
    expect(window.slice(0, 200).map((message) => message.seq)).toEqual(
      older.map((message) => message.seq),
    );
    expect(window.at(-1)?.seq).toBe(2000);
    const newest = mergeLog(window, [entry(2201)]);
    expect(newest.at(-1)?.seq).toBe(2201);
  });

  it("merges logs by sequence: deduplicated, ordered", () => {
    const entry = (seq: number): HistoryEntry => ({
      seq,
      id: `m${seq}`,
      channel: "main",
      kind: "post",
      from: "A",
      to: null,
      mentions: [],
      text: String(seq),
      timestamp: "",
      replyTo: null,
    });
    expect(mergeLog([entry(3), entry(1)], [entry(2), entry(3)]).map((e) => e.seq)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("copying the chat", () => {
  const at = (iso: string) => new Date(iso).getTime();
  const entry = (seq: number, patch: Partial<HistoryEntry>): HistoryEntry => ({
    seq,
    id: `m${seq}`,
    channel: "main",
    kind: "post",
    from: "Storm",
    to: null,
    mentions: [],
    text: "",
    timestamp: "2026-10-08T09:05:00.000Z",
    replyTo: null,
    ...patch,
  });

  it("writes every message oldest first with its date, sender, recipient and every line of its text", () => {
    const stamp = (iso: string) => {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const text = chatTranscript(
      "main",
      [
        entry(2, {
          kind: "dm",
          from: "harsha",
          to: "Storm",
          text: "just you",
          timestamp: "2026-10-08T09:06:00.000Z",
        }),
        entry(1, { text: "first line\nsecond line" }),
      ],
      at("2026-10-08T10:00:00.000Z"),
    );
    expect(text).toBe(
      [
        `#main · 2 messages · copied ${stamp("2026-10-08T10:00:00.000Z")}`,
        "",
        `[${stamp("2026-10-08T09:05:00.000Z")}] Storm: first line`,
        "  second line",
        `[${stamp("2026-10-08T09:06:00.000Z")}] harsha → Storm (individual): just you`,
        "",
      ].join("\n"),
    );
  });

  it("says when a channel has no messages", () => {
    expect(chatTranscript("quiet", [], at("2026-10-08T10:00:00.000Z"))).toStartWith(
      "#quiet · 0 messages",
    );
  });

  it("hands the text to the terminal clipboard as one OSC 52 write that survives non-ASCII text", () => {
    const sequence = clipboardSequence("héllo 🌍");
    expect(sequence.startsWith("\x1b]52;c;")).toBe(true);
    expect(sequence.endsWith("\x1b\\")).toBe(true);
    expect(Buffer.from(sequence.slice(7, -2), "base64").toString("utf8")).toBe("héllo 🌍");
  });
});

function chatState(cols: number): ViewState {
  const channel = createChannel("main", true);
  channel.members = [
    {
      name: "Storm",
      pid: 1,
      hostId: "local",
      sessionId: "s",
      cwd: "/repo",
      model: "claude-opus",
      isHuman: false,
      startedAt: new Date().toISOString(),
      activity: { lastActivityAt: new Date().toISOString(), currentActivity: "editing view.ts" },
      session: { tokens: 0, toolCalls: 0, filesModified: [] },
    },
  ];
  return {
    self: "harsha",
    connection: "connected",
    url: "ws://localhost",
    channels: [channel, createChannel("creative", false)],
    active: "main",
    composer: channel.draft,
    completion: null,
    stuckThresholdMs: 300_000,
    cols,
    hour12: false,
    panel: null,
    sidebars: { channels: true, members: true },
  };
}

it("ignores non-string action values and gates fonts on both surfaces", async () => {
  for (const hasFont of [false, true]) {
    const opened: Array<Record<string, unknown>> = [];
    const rendered: Record<string, ViewInput> = {};
    const snapshots: string[] = [];
    const drafts: string[] = [];
    const inputs = [
      {
        type: "event",
        event: { sf: "omp-messenger", ev: "action", id: "x", act: "mention", value: 42 },
      },
      {
        type: "event",
        event: { sf: "omp-messenger", ev: "action", id: "x", act: "mention", value: "Storm" },
      },
      {
        type: "event",
        event: { sf: "omp-messenger", ev: "action", id: "layer.header.settings", act: "settings" },
      },
      {
        type: "event",
        event: {
          sf: "omp-messenger-settings",
          ev: "action",
          id: "main.settings",
          act: "page",
          value: { bad: true },
        },
      },
      {
        type: "event",
        event: {
          sf: "omp-messenger-settings",
          ev: "action",
          id: "main.settings",
          act: "page",
          value: "folders",
        },
      },
    ];
    const session = {
      caps: { cols: 160, hour12: false, features: hasFont ? ["font"] : [] },
      open(options: { id: string }) {
        opened.push(options);
        return {
          stylesheet() {},
          focus() {},
          close() {},
          render(view: ViewInput) {
            rendered[options.id] = view;
          },
        };
      },
      async close() {},
      async *[Symbol.asyncIterator]() {
        for (const input of inputs) {
          yield input;
          const chat = rendered["omp-messenger"];
          if (chat) drafts.push(String(View.from(chat).find(COMPOSER_ID)?.props.text));
          const view = rendered["omp-messenger-settings"];
          if (view) snapshots.push(String(View.from(view).find("main.settings")?.props.page));
        }
      },
    };
    const app = new MessengerApp(
      { name: "harsha", url: "", token: "", channels: ["main"] },
      "k".repeat(43),
    );
    await app.run(session as unknown as Session);
    expect(drafts.slice(0, 2)).toEqual(["", "@Storm "]);
    expect(snapshots).toEqual(["connection", "connection", "folders"]);
    expect(opened.map((options) => options.font)).toEqual(
      hasFont ? ["sans", "sans"] : [undefined, undefined],
    );
    expect(opened.map((options) => options.mode)).toEqual(["inline", "screen"]);
    expect(opened[0]?.title).toBe("Messenger");
    expect(opened[0]?.closable).toBeUndefined();
  }
});

describe("native message and controls", () => {
  it("keeps message semantics and actionable native controls", () => {
    const state = chatState(160);
    state.channels[0].log = [
      {
        seq: 1,
        id: "1",
        channel: "main",
        kind: "dm",
        from: "Storm",
        to: "harsha",
        mentions: ["harsha"],
        text: "hello",
        timestamp: "2026-10-08T09:05:00Z",
        replyTo: null,
      },
      {
        seq: 2,
        id: "2",
        channel: "main",
        kind: "dm",
        from: "Storm",
        to: "harsha",
        mentions: [],
        text: "again",
        timestamp: "2026-10-08T09:06:00Z",
        replyTo: null,
      },
    ];
    const actions: string[] = [];
    const view = View.from(
      buildView(state, undefined, (action, entry) => actions.push(`${action}:${entry.text}`)),
    );
    expect(view.find("main.m1.msg")?.kind).toBe("message");
    expect(view.find("main.m1.msg")?.props).toMatchObject({
      author: "Storm",
      role: "messenger.dm",
      continued: false,
    });
    expect(view.find("main.m2.msg")?.props.continued).toBe(true);
    expect(view.find("main.m1.msg.body")?.props.text).toBe("hello");
    expect(view.find("main.m1.msg")?.props.actions).toEqual([
      { act: "copy-message", icon: "copy", title: "Copy message" },
      { act: "mention-author", icon: "user", title: "Mention Storm" },
    ]);
    view.find("main.m1.msg")?.node.handlers?.onAction?.["copy-message"]?.({
      ev: "action",
      sf: "omp-messenger",
      id: "main.m1.msg",
      act: "copy-message",
      raw: {},
    });
    view.find("main.m1.msg")?.node.handlers?.onAction?.["mention-author"]?.({
      ev: "action",
      sf: "omp-messenger",
      id: "main.m1.msg",
      act: "mention-author",
      raw: {},
    });
    expect(actions).toEqual(["copy:hello", "mention:hello"]);
    expect(view.find("dock.chat.send-controls.send")?.kind).toBe("button");
    expect(view.find("dock.chat.send-controls.send")?.props.disabled).toBeTruthy();
    expect(view.find("dock.chat.send-controls.send")?.props).toMatchObject({
      disabled: "Write a message first",
      icon: "send",
      keys: ["Enter"],
      variant: "primary",
    });
    state.composer.text = "ready";
    let sent = 0;
    const enabled = View.from(
      buildView(state, undefined, undefined, () => {
        sent++;
      }),
    );
    enabled.find("dock.chat.send-controls.send")?.node.handlers?.onClick?.({
      ev: "action",
      sf: "omp-messenger",
      id: "dock.chat.send-controls.send",
      act: "click",
      raw: {},
    });
    expect(sent).toBe(1);
    state.channels[0].sending = true;
    expect(View.from(buildView(state)).find("dock.chat.send-controls.send")?.props).toMatchObject({
      busy: true,
      disabled: "Chat is not ready to send",
    });
  });
});

describe("chat layout", () => {
  it("keeps the header and the sidebars fixed beside the scrolling timeline, never over it", () => {
    const state = chatState(160);
    state.channels[0].log = [
      {
        seq: 1,
        id: "m1",
        channel: "main",
        kind: "post",
        from: "Storm",
        to: null,
        mentions: [],
        text: "hello",
        timestamp: new Date().toISOString(),
        replyTo: null,
      },
    ];
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
    expect(wide.find(`${storm}.identity.status`)?.props).toMatchObject({
      text: "active",
      tone: "success",
    });
    expect(wide.find(`${storm}.about`)?.props.text).toBe("claude-opus");
    expect(wide.find(`${storm}.activity`)?.props.text).toBe("editing view.ts");
    expect(wide.find(`${storm}.idle.label`)?.props.text).toBe("Since activity");
    expect(wide.find(`${storm}.idle.value`)?.kind).toBe("elapsed");
    expect(wide.find(`${storm}.session.label`)?.props.text).toBe("Session age");
    expect(wide.find(`${storm}.session.value`)?.kind).toBe("elapsed");
    expect(wide.find(`${storm}.direct`)?.props).toMatchObject({
      text: "Message individually",
      variant: "quiet",
    });
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
          for (const id of [
            "main.older",
            "dock.chat",
            "layer.header",
            "layer.left",
            "layer.right",
          ]) {
            const role = view.find(id)?.props.role;
            if (typeof role === "string") roles.add(role);
          }
        }
      }
    }
    expect([...roles].sort()).toEqual([
      "messenger.dock-open-open",
      "messenger.dock-open-slim",
      "messenger.dock-sheet-sheet",
      "messenger.dock-slim-open",
      "messenger.dock-slim-slim",
      "messenger.header-open-open",
      "messenger.header-open-slim",
      "messenger.header-sheet-sheet",
      "messenger.header-slim-open",
      "messenger.header-slim-slim",
      "messenger.row-open-open",
      "messenger.row-open-slim",
      "messenger.row-sheet-sheet",
      "messenger.row-slim-open",
      "messenger.row-slim-slim",
      "messenger.side-left-open",
      "messenger.side-left-slim",
      "messenger.side-right-open",
      "messenger.side-right-slim",
    ]);
    for (const role of roles) expect(STYLESHEET).toContain(`[data-role='${role}']`);
  });
});

describe("native views", () => {
  it("renders a human without reservations and keeps the composer unavailable under a modal", () => {
    const channel = createChannel("main", true);
    channel.members = [
      {
        name: "Human",
        pid: 1,
        hostId: "local",
        sessionId: "session",
        cwd: "/repo",
        model: "human",
        isHuman: true,
        startedAt: new Date().toISOString(),
        activity: { lastActivityAt: new Date().toISOString() },
        session: { tokens: 0, toolCalls: 0, filesModified: [] },
      },
    ];
    const state: ViewState = {
      self: "Human",
      connection: "connected",
      url: "ws://localhost",
      channels: [channel],
      active: "main",
      composer: channel.draft,
      completion: null,
      stuckThresholdMs: 300_000,
      cols: 150,
      hour12: false,
      panel: null,
      sidebars: { channels: true, members: true },
    };
    const normal = View.from(buildView(state));
    expect(normal.find("layer.right.members.mb-Human.identity.name")?.props.spans).toEqual([
      { t: "Human", s: "strong" },
    ]);
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
    expect(narrow.find("layer.header.members")?.kind).toBe("button");
    expect(narrow.find("layer.header.members")?.props.actions).toEqual({ click: "members" });
    expect(narrow.find("main.older")?.props.role).toBe("messenger.row-sheet-sheet");
    expect(narrow.find("layer.panel.members.mb-Human.identity.name")?.props.spans).toEqual([
      { t: "Human", s: "strong" },
    ]);
  });
});
