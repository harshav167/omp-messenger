#!/usr/bin/env bun
/**
 * omp-messenger for Tern: the whole mesh as a native group chat.
 *
 * Runs in a Tern pane over the Tern Surface Protocol: the chat is an inline surface (like an omp
 * session), and settings open as a screen surface over it;
 * talks to the mesh server directly over WebSocket as a human member. It works whether
 * or not any omp session is running: channels, members, history and the live log come
 * from the server.
 *
 *   bun tern-plugin/app/main.ts [--url ws://host:8765] [--token T] [--name you] [--channel main]...
 *
 * URL, token and channels default to the messenger's own config (env, project and
 * ~/.omp/agent/omp-messenger.json, ~/.omp/agent/messenger/mesh.token).
 */

import { userInfo } from "node:os";
import { isValidAgentName, isValidChannelName, type AgentMailMessage, type HistoryEntry } from "../../lib.ts";
import { loadConfig } from "../../config.ts";
import type { ChannelInfo } from "../../mesh/types.ts";
import type { ChannelSnapshot } from "../../mesh/protocol.ts";
import { connect, ui, type Key, type Session, type Surface, type TspEvent } from "@stencil-hq/tern";
import { MessengerMesh, type ConnectionState } from "./mesh.ts";
import {
  applyCompletion,
  applyNativeEdit,
  createChannel,
  createComposer,
  editComposer,
  findCompletion,
  insertMention,
  insertText,
  mergeLog,
  recallHistory,
  replaceDraft,
  submitComposer,
  undoDraft,
  type ChannelView,
  type Completion,
} from "./model.ts";
import { buildView, COMPOSER_ID, idPart, MEMBERS_COLS, SETTINGS_ID, sidebarLayout, STYLESHEET, type ViewState } from "./view.ts";
import { MessengerSettings } from "./settings.ts";

const SURFACE = "omp-messenger";
/** Settings open as a full-screen surface over the inline chat; closing it shows the chat exactly as it was. */
const SETTINGS_SURFACE = "omp-messenger-settings";
const VERSION = "0.17.0";
const NOTICE_MS = 4000;
/** How often idle / online times are redrawn. */
const CLOCK_MS = 10_000;

interface Args {
  url?: string;
  token?: string;
  name?: string;
  channels: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { channels: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--url" && value) args.url = argv[++i];
    else if (flag === "--token" && value) args.token = argv[++i];
    else if (flag === "--name" && value) args.name = argv[++i];
    else if (flag === "--channel" && value) args.channels.push(argv[++i]);
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write("usage: bun tern-plugin/app/main.ts [--url ws://host:port] [--token T] [--name you] [--channel name]...\n");
      process.exit(0);
    }
  }
  return args;
}

function defaultName(): string {
  const raw = process.env.OMP_MESSENGER_HUMAN_NAME ?? userInfo().username;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "");
  return isValidAgentName(cleaned) ? cleaned : "human";
}

class MessengerApp {
  #session: Session | undefined;
  #surface: Surface | undefined;
  readonly #mesh: MessengerMesh;
  readonly #state: ViewState;
  #exitCode = 0;
  #exiting = false;
  #noticeTimer: Timer | undefined;
  #clock: Timer | undefined;
  #settings: MessengerSettings | undefined;
  #settingsSurface: Surface | undefined;

  constructor(private readonly args: Args) {
    const config = loadConfig(process.cwd());
    const url = args.url ?? config.mesh.url ?? "";
    const token = args.token ?? config.mesh.token;
    const channels = (args.channels.length > 0 ? args.channels : config.mesh.channels).filter(isValidChannelName);
    const name = args.name ?? defaultName();

    this.#state = {
      self: name,
      connection: "connecting",
      url,
      channels: channels.map(channel => createChannel(channel, true)),
      active: channels[0] ?? "main",
      composer: createComposer(),
      completion: null,
      stuckThresholdMs: config.stuckThreshold * 1000,
      cols: process.stdout.columns ?? 80,
      hour12: false,
      panel: null,
      sidebars: { channels: true, members: true },
    };
    this.#state.composer = this.#state.channels[0]?.draft ?? createComposer();
    this.#mesh = new MessengerMesh({ url, token, name, channels, cwd: process.cwd() }, {
      state: (state, detail) => this.#onConnection(state, detail),
      welcome: (self, snapshots) => {
        for (const channel of this.#state.channels) channel.joined = snapshots.some(snapshot => snapshot.channel === channel.name);
        this.#state.self = self;
        for (const snapshot of snapshots) {
          const channel = this.#channel(snapshot.channel, true);
          channel.joined = true;
          channel.members = snapshot.peers;
        }
        if (!this.#activeChannel()?.joined) this.#switchTo(snapshots[0]?.channel ?? "");
        for (const channel of this.#state.channels) if (channel.following) void this.#loadHistory(channel, true);
        void this.#discoverChannels();
        this.#render();
      },
      peers: (channelName, peers) => {
        const channel = this.#channel(channelName, false);
        channel.members = peers;
        this.#updateCompletion();
        this.#render();
      },
      log: entry => this.#onLog(entry),
      direct: message => this.#onDirect(message),
      channels: infos => this.#applyChannelList(infos),
      removed: (channel, by, channels, added) => this.#onRemoved(channel, by, channels, added),
      deleted: (channel, by) => {
        this.#forgetChannel(channel);
        if (by !== this.#state.self) this.#notice(`#${channel} was deleted by ${by}`, "info");
      },
    });
  }

  async run(): Promise<number> {
    const session = await connect({ app: "omp-messenger", version: VERSION, features: ["edit", "undo", "send"] });
    if (!session) throw new Error("Messenger needs native program surfaces enabled in a Tern pane.");
    this.#session = session;
    try {
      this.#state.cols = session.caps.cols;
      this.#state.hour12 = session.caps.hour12;
      // Inline, like omp's own sessions: the pane keeps the newest message in view until you scroll up, and holds your place while you read.
      this.#surface = session.open({ id: SURFACE, mode: "inline", title: "Messenger", role: "omp.messenger" });
      this.#surface.stylesheet("main", STYLESHEET);
      this.#refocus();
      if (this.#state.url) this.#mesh.connect();
      else this.#onConnection("rejected", "Open Settings to configure a WebSocket server.");
      this.#clock = setInterval(() => this.#render(), CLOCK_MS);
      for await (const input of session) {
        if (input.type === "key") this.#onKey(input.key);
        else this.#onEvent(input.event);
      }
      return this.#exitCode;
    } finally {
      clearTimeout(this.#noticeTimer);
      clearInterval(this.#clock);
      this.#mesh.close();
      await session.close();
    }
  }

  #render(): void {
    if (this.#exiting) return;
    this.#surface?.render(buildView(this.#state));
    if (this.#settings) this.#settingsSurface?.render({ main: ui.col({}, this.#settings.view()) });
  }


  #onEvent(event: TspEvent): void {
    if ("sf" in event && event.sf && event.sf !== SURFACE && event.sf !== SETTINGS_SURFACE) return;
    if (this.#settings && "id" in event && event.id === SETTINGS_ID) {
      if (event.ev === "action" && "act" in event) {
        if (event.act === "close") {
          if (event.value) this.#settings.editing = undefined;
          else this.#closeSettings();
        } else if (event.act === "page") this.#settings.page = event.value ?? "connection";
        else if (event.act === "settings-save") this.#saveSettings();
        else if (event.act === "settings-add-path") this.#settings.addPath();
        else if (event.act === "settings-remove-path") this.#settings.removePath(event.value);
      } else if (event.ev === "activate" && "item" in event) this.#settings.activate(event.item);
      else if (event.ev === "select" && "item" in event) this.#settings.focus = event.item;
      else if (event.ev === "change" && "item" in event) this.#settings.change(event.item, event.value);
      this.#render();
      return;
    }
    switch (event.ev) {
      case "edit": {
        if (!("id" in event) || !("from" in event)) return;
        const draft = this.#field(event.id);
        if (draft && applyNativeEdit(draft, event)) {
          this.#updateCompletion();
          this.#render();
        }
        return;
      }
      case "undo": {
        if (!("id" in event)) return;
        const draft = this.#field(event.id);
        if (draft && undoDraft(draft)) {
          this.#updateCompletion();
          this.#render();
        }
        return;
      }
      case "focus":
        if ("id" in event && (event.id === COMPOSER_ID && !this.#state.dialog
          || event.id === "layer.dialog.body.input" && this.#state.dialog?.kind === "create")) {
          this.#surface?.focus(event.id);
        }
        return;
      case "select":
      case "activate":
        if ("id" in event && "item" in event) this.#onSelect(event.id, event.item);
        return;
      case "action":
        if ("act" in event && "id" in event) this.#onAction(event.act, event.value, event.id);
        return;
      case "send":
        if ("id" in event && "text" in event && event.id === COMPOSER_ID && this.#canSend()) {
          replaceDraft(this.#state.composer, event.text);
          void this.#submit();
        }
        return;
      case "resize":
        this.#state.cols = this.#session?.caps.cols ?? this.#state.cols;
        this.#render();
        return;
      case "gone":
        if (!("ids" in event)) return;
        if (event.ids.includes(SURFACE)) void this.#quit(0);
        else if (event.ids.includes(SETTINGS_SURFACE)) this.#closeSettings();
        return;
      case "error":
        if ("msg" in event) this.#notice(`Tern: ${event.msg}`, "error");
        return;
    }
  }

  #field(id: string) {
    if (this.#state.dialog?.kind === "create") {
      return id === "layer.dialog.body.input" && this.#state.dialog.operation.state !== "pending" ? this.#state.dialog.input : undefined;
    }
    return !this.#state.dialog && !this.#settings && !this.#state.panel && this.#activeChannel()?.joined && id === COMPOSER_ID ? this.#state.composer : undefined;
  }

  #onSelect(listId: string, itemId: string): void {
    if (listId.endsWith(".rail.list")) {
      const channel = this.#state.channels.find(c => itemId.endsWith(`.ch-${idPart(c.name)}`));
      if (channel) this.#switchTo(channel.name);
      return;
    }
    if (listId === "layer.suggestions.suggest") {
      const name = this.#state.completion?.options.find(option => itemId.endsWith(`.sg-${idPart(option)}`));
      this.#complete(name);
    }
  }

  #onAction(act: string, value: string | undefined, nodeId: string): void {
    if (act === "send-message") { void this.#submit(); return; }
    if (act === "mention" && value) {
      const channel = this.#activeChannel();
      if (!channel) return;
      channel.recipient = undefined;
      insertMention(this.#state.composer, value);
      this.#state.completion = null;
      this.#state.panel = null;
      this.#refocus();
    } else if (act === "complete" && value) {
      this.#complete(value);
    } else if (act === "older") {
      const channel = this.#activeChannel();
      if (channel) void this.#loadHistory(channel, false);
    } else if (act === "new-channel") {
      this.#openCreate();
    } else if (act === "join-channel") {
      if (this.#state.active) void this.#createChannel(this.#state.active);
    } else if (act === "direct" && value) {
      const channel = this.#activeChannel();
      if (channel) channel.recipient = value;
      this.#state.panel = null;
      this.#refocus();
    } else if (act === "group") {
      const channel = this.#activeChannel();
      if (channel) channel.recipient = undefined;
      this.#refocus();
    } else if (act === "channels" || act === "members") {
      // A sidebar that can't fit beside the timeline at this pane width opens as a sheet instead.
      const side = sidebarLayout(this.#state.cols, this.#state.sidebars)[act];
      if (side === "sheet" || (act === "members" && this.#state.cols < MEMBERS_COLS)) {
        this.#state.panel = this.#state.panel === act ? null : act;
        this.#render();
      } else {
        this.#state.sidebars[act] = !this.#state.sidebars[act];
        this.#state.panel = null;
        this.#refocus();
      }
    } else if (act === "close-panel") {
      this.#state.panel = null;
      this.#refocus();
    } else if (act === "settings") {
      this.#openSettings();
    } else if (act === "latest") {
      // Only offered while an older history window is open; Tern's own ↓ returns to the live end otherwise.
      const channel = this.#activeChannel();
      if (channel) void this.#loadHistory(channel, true);
    } else if (act === "delete-channel") {
      // From a rail row's context menu (node `ch-<name>`) or the timeline header's trash icon.
      const fromRow = this.#state.channels.find(c => nodeId.endsWith(`.ch-${idPart(c.name)}`));
      this.#openDelete((fromRow ?? this.#activeChannel())?.name);
    } else if (act === "dialog-confirm") {
      void this.#confirmDialog();
    } else if (act === "dialog-cancel") {
      this.#closeDialog();
    }
  }

  #canSend(): boolean {
    const channel = this.#activeChannel();
    return this.#state.connection === "connected" && channel?.joined === true && !channel.sending && !this.#state.dialog && !this.#settings && !this.#state.panel;
  }

  #saveSettings(): void {
    if (!this.#settings?.save()) return;
    const config = loadConfig(process.cwd());
    const url = this.args.url ?? config.mesh.url;
    if (!url) { this.#settings.error = "The effective configuration has no WebSocket server."; return; }
    this.#closeSettings();
    this.#state.url = url;
    this.#state.stuckThresholdMs = config.stuckThreshold * 1000;
    this.#mesh.reconfigure(url, this.args.token ?? config.mesh.token, this.args.channels.length ? this.args.channels : config.mesh.channels);
    this.#notice("Saved user settings. Reconnecting with effective configuration.", "info");
  }

  #openSettings(): void {
    this.#state.panel = null;
    this.#settings = new MessengerSettings(process.cwd(), this.#state.url);
    this.#settingsSurface ??= this.#session?.open({ id: SETTINGS_SURFACE, mode: "screen", title: "Messenger settings", role: "omp.messenger.settings" });
    this.#render();
  }

  #closeSettings(): void {
    if (!this.#settings) return;
    this.#settings = undefined;
    void this.#settingsSurface?.close({ keep: false });
    this.#settingsSurface = undefined;
    this.#refocus();
  }

  // -- create / delete channel -------------------------------------------------

  #openCreate(initial = ""): void {
    this.#closeSettings();
    this.#state.panel = null;
    const input = createComposer();
    insertText(input, initial);
    this.#state.dialog = { kind: "create", input, operation: { state: "ready" } };
    this.#state.completion = null;
    this.#render();
    this.#surface?.focus("layer.dialog.body.input");
  }

  #openDelete(name: string | undefined): void {
    if (!name) return;
    this.#closeSettings();
    this.#state.panel = null;
    if (name === "main") return this.#notice("#main can't be deleted", "error");
    const channel = this.#state.channels.find(c => c.name === name);
    if (!channel) return this.#notice(`No channel #${name}`, "error");
    const members = channel.members.map(m => m.name).filter(m => m !== this.#state.self);
    this.#state.dialog = { kind: "delete", channel: name, members, operation: { state: "ready" } };
    this.#render();
  }

  #closeDialog(): void {
    if (this.#state.dialog?.operation.state === "pending") return;
    this.#state.dialog = undefined;
    this.#refocus();
  }

  /** Keys while a dialog is open go to it: Enter confirms, Escape cancels, the rest edit its field. */
  #dialogKey(key: Key): void {
    const dialog = this.#state.dialog;
    if (!dialog) return;
    if (dialog.operation.state === "pending") return;
    if (key.name === "escape") return this.#closeDialog();
    if (key.name === "enter") return void this.#confirmDialog();
    if (dialog.kind !== "create") return;
    if (key.name === "z" && (key.meta || key.ctrl)) {
      undoDraft(dialog.input, key.shift);
      return this.#render();
    }
    if (key.name === "paste" || key.name === "text" || (key.text && !key.ctrl && !key.meta)) {
      insertText(dialog.input, (key.text ?? "").replace(/[\r\n]/g, ""));
    } else if (!editComposer(dialog.input, key)) {
      return;
    }
    dialog.operation = { state: "ready" };
    this.#render();
  }

  async #confirmDialog(): Promise<void> {
    const dialog = this.#state.dialog;
    if (!dialog || dialog.operation.state === "pending") return;
    const name = dialog.kind === "create" ? dialog.input.text.trim().replace(/^#/, "") : dialog.channel;
    if (!isValidChannelName(name)) {
      dialog.operation = { state: "error", error: "Use 1–48 lowercase letters, digits, - or _, starting with a letter or digit." };
      return this.#render();
    }
    dialog.operation = { state: "pending" };
    this.#render();
    const error = dialog.kind === "create" ? await this.#createChannel(name) : await this.#deleteChannel(name);
    if (this.#state.dialog !== dialog) return;
    if (error) dialog.operation = { state: "error", error };
    else { dialog.operation = { state: "ready" }; this.#closeDialog(); }
    this.#render();
  }

  /** Joining a channel creates it on the server when it doesn't exist yet. */
  async #createChannel(name: string): Promise<string | undefined> {
    const existed = this.#state.channels.some(c => c.name === name);
    const result = await this.#mesh.join(name);
    if (typeof result === "string") {
      this.#notice(`Couldn't open #${name}: ${result}`, "error");
      return result;
    }
    const channel = this.#channel(name, true);
    channel.joined = true;
    channel.members = result.peers;
    this.#switchTo(name);
    void this.#loadHistory(channel, true);
    this.#notice(existed ? `Joined #${name}` : `Created #${name}`, "success");
  }

  async #deleteChannel(name: string): Promise<string | undefined> {
    const reply = await this.#mesh.deleteChannel(name);
    const error = !reply ? "The mesh did not confirm deletion. Reconnect and check the channel before retrying."
      : reply.ok === false ? reply.error === "protected" ? "#main can't be deleted" : `Deletion failed: ${reply.error}` : undefined;
    if (error) return error;
    if (!reply || reply.ok === false) return;
    this.#forgetChannel(name);
    this.#notice(reply.removed.length > 0 ? `Deleted #${name} — removed and told ${reply.removed.join(", ")}` : `Deleted #${name}`, "success");
  }

  /** Someone (maybe us) deleted a channel this member was in. */
  #onRemoved(name: string, by: string, channels: string[], added: ChannelSnapshot[]): void {
    for (const snapshot of added) {
      const channel = this.#channel(snapshot.channel, true);
      channel.joined = true;
      channel.members = snapshot.peers;
    }
    for (const channel of this.#state.channels) channel.joined = channels.includes(channel.name);
    this.#forgetChannel(name);
    if (by !== this.#state.self) this.#notice(`#${name} was deleted by ${by}`, "info");
  }

  #forgetChannel(name: string): void {
    this.#state.channels = this.#state.channels.filter(c => c.name !== name);
    if (this.#state.active === name) this.#switchTo(this.#state.channels.find(c => c.joined)?.name ?? this.#state.channels[0]?.name ?? "");
    else this.#render();
  }

  #onKey(key: Key): void {
    if (this.#settings) {
      const result = this.#settings.key(key);
      if (result === "close") this.#closeSettings();
      else if (result === "save") this.#saveSettings();
      this.#render();
      return;
    }
    if (this.#state.panel) {
      if (key.name === "escape") { this.#state.panel = null; this.#refocus(); }
      return;
    }
    const composer = this.#state.composer;
    const completion = this.#state.completion;

    if (key.name === "c" && key.ctrl) return void this.#quit(0);
    if (this.#state.dialog) return this.#dialogKey(key);
    if (key.name === "d" && key.ctrl && composer.text === "") return void this.#quit(0);
    if (key.name === "z" && (key.meta || key.ctrl)) {
      undoDraft(composer, key.shift);
      this.#updateCompletion();
      return this.#render();
    }

    if (completion) {
      if (key.name === "up" || (key.name === "p" && key.ctrl)) return this.#moveCompletion(-1);
      if (key.name === "down" || (key.name === "n" && key.ctrl)) return this.#moveCompletion(1);
      if (key.name === "tab" || (key.name === "enter" && !key.shift)) return this.#complete(completion.options[completion.selected]);
      if (key.name === "escape") {
        this.#state.completion = null;
        return this.#render();
      }
    }

    if (key.alt && (key.name === "up" || key.name === "down")) return this.#cycleChannel(key.name === "up" ? -1 : 1);
    if (key.ctrl && key.name === "tab") return this.#cycleChannel(key.shift ? -1 : 1);
    if (key.name === "escape") {
      if (composer.text !== "") {
        replaceDraft(composer, "");
        return this.#render();
      }
      return void this.#quit(0);
    }
    if (key.name === "enter") {
      if (key.shift || key.alt) insertText(composer, "\n");
      else return void this.#submit();
    } else if (key.name === "paste" || key.name === "text" || (key.text && !key.ctrl && !key.meta)) {
      insertText(composer, (key.text ?? "").replace(/\r\n?/g, "\n"));
    } else if (key.name === "space" && !key.ctrl) {
      insertText(composer, " ");
    } else if (key.name === "up" || key.name === "down") {
      if (!recallHistory(composer, key.name === "up" ? -1 : 1)) return;
    } else if (!editComposer(composer, key)) {
      return;
    }
    this.#updateCompletion();
    this.#render();
  }

  // -- composer --------------------------------------------------------------

  #updateCompletion(): void {
    const channel = this.#activeChannel();
    const previous = this.#state.completion;
    const next = findCompletion(this.#state.composer, channel?.members.map(m => m.name) ?? [], this.#state.self);
    if (next && previous && previous.start === next.start) {
      const keep = next.options.indexOf(previous.options[previous.selected]);
      next.selected = keep >= 0 ? keep : 0;
    }
    this.#state.completion = next;
  }

  #moveCompletion(delta: number): void {
    const completion = this.#state.completion as Completion;
    completion.selected = (completion.selected + delta + completion.options.length) % completion.options.length;
    this.#render();
  }

  #complete(name: string | undefined): void {
    const completion = this.#state.completion;
    if (!name) return;
    if (completion) applyCompletion(this.#state.composer, completion, name);
    else insertMention(this.#state.composer, name);
    this.#state.completion = null;
    this.#refocus();
  }

  #refocus(): void {
    this.#render();
    this.#surface?.focus(COMPOSER_ID);
  }

  async #submit(): Promise<void> {
    const channel = this.#activeChannel();
    if (!channel || !this.#canSend()) return;
    const composer = channel.draft;
    const originalDraft = composer.text;
    const recipient = channel.recipient;
    const raw = composer.text.trim();
    if (!raw) return;
    if (raw.startsWith("/")) {
      submitComposer(composer);
      this.#state.completion = null;
      await this.#command(raw);
      return;
    }
    channel.sending = true;
    channel.sendError = undefined;
    this.#mesh.activity();
    this.#render();
    try {
      const result = recipient
        ? await this.#mesh.send(channel.name, recipient, raw)
        : await this.#mesh.post(channel.name, raw);
      if (!result || result.ok === false) {
        channel.sendError = result?.ok === false ? `Not sent: ${result.error}` : "Delivery was not confirmed. Your draft is preserved. Check history before retrying.";
        return;
      }
      if ("entry" in result && channel.following) channel.log = mergeLog(channel.log, [result.entry]);
      if (composer.text === originalDraft) submitComposer(composer);
      if (this.#activeChannel() === channel) this.#state.completion = null;
      this.#notice(recipient ? `Delivered to ${recipient}` : "Posted to channel", "success");
    } finally {
      channel.sending = false;
      this.#render();
    }
  }

  async #command(raw: string): Promise<void> {
    const [command, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest[0]?.replace(/^#/, "");
    switch (command) {
      case "join":
      case "create":
        if (!arg || !isValidChannelName(arg)) return this.#notice(`Usage: /${command} <channel> (lowercase letters, digits, - and _)`, "error");
        await this.#createChannel(arg);
        return;
      case "delete":
        if (!arg) return this.#notice("Usage: /delete <channel>", "error");
        return this.#openDelete(arg);
      case "dm": {
        const to = rest[0]?.replace(/^@/, "");
        const text = rest.slice(1).join(" ");
        if (!to || !text) return this.#notice("Usage: /dm <name> <message>", "error");
        const channel = this.#activeChannel();
        if (!channel) return;
        channel.recipient = to;
        replaceDraft(channel.draft, text);
        await this.#submit();
        return;
      }
      case "settings":
        this.#openSettings();
        return;
      case "help":
        return this.#notice("/create <channel> · /join <channel> · /delete <channel> · /dm <name> <msg> · @name · @all · ⌥↑↓ switch channel", "info");
      default:
        return this.#notice(`Unknown command /${command} (try /help)`, "error");
    }
  }

  // -- channels --------------------------------------------------------------

  #activeChannel(): ChannelView | undefined {
    return this.#state.channels.find(channel => channel.name === this.#state.active);
  }

  #channel(name: string, joined: boolean): ChannelView {
    let channel = this.#state.channels.find(c => c.name === name);
    if (!channel) {
      channel = createChannel(name, joined);
      this.#state.channels = [...this.#state.channels, channel].sort((a, b) => Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name));
    }
    return channel;
  }

  #switchTo(name: string): void {
    this.#state.panel = null;
    this.#state.active = name;
    const channel = this.#activeChannel();
    if (channel) {
      this.#state.composer = channel.draft;
      channel.unread = 0;
      channel.mentions = 0;
      if (channel.log.length === 0 && channel.hasMore) void this.#loadHistory(channel, true);
    }
    this.#state.completion = null;
    this.#refocus();
  }

  #cycleChannel(delta: number): void {
    const channels = this.#state.channels;
    if (channels.length === 0) return;
    const index = channels.findIndex(channel => channel.name === this.#state.active);
    this.#switchTo(channels[(index + delta + channels.length) % channels.length].name);
  }

  async #discoverChannels(): Promise<void> {
    const channels = await this.#mesh.listChannels();
    if (channels) this.#applyChannelList(channels);
  }

  /**
   * Mirror the server's channel list: add new channels, drop ones it no longer has
   * (unless joined or open), and watch all of them so their logs and members stay live.
   */
  #applyChannelList(infos: readonly ChannelInfo[]): void {
    const listed = new Set(infos.map(info => info.name).filter(isValidChannelName));
    for (const name of listed) this.#channel(name, false);
    this.#state.channels = this.#state.channels.filter(c => listed.has(c.name) || c.joined);
    if (!this.#activeChannel()) this.#switchTo(this.#state.channels.find(c => c.joined)?.name ?? this.#state.channels[0]?.name ?? "");
    this.#mesh.watch(this.#state.channels.map(c => c.name));
    this.#render();
  }

  async #loadHistory(channel: ChannelView, newest: boolean): Promise<void> {
    if (channel.loadingHistory || (!newest && !channel.hasMore)) return;
    channel.loadingHistory = true;
    channel.historyError = undefined;
    if (!newest) channel.following = false;
    this.#render();
    const page = await this.#mesh.history(channel.name, newest ? undefined : channel.log[0]?.seq);
    channel.loadingHistory = false;
    if (page?.ok) {
      if (newest) {
        channel.log = mergeLog([], page.entries);
        channel.following = true;
        channel.hasNewer = false;
        channel.unread = 0;
      } else {
        const count = channel.log.length + page.entries.length;
        channel.log = mergeLog(channel.log, page.entries, "oldest");
        channel.hasNewer ||= count > channel.log.length;
      }
      channel.hasMore = page.hasMore;
    } else channel.historyError = page?.ok === false ? page.error : "Couldn't load history. Check the connection and retry.";
    this.#render();
  }

  // -- mesh ------------------------------------------------------------------

  #onConnection(state: ConnectionState, detail?: string): void {
    this.#state.connection = state;
    this.#state.connectionDetail = detail;
    this.#render();
  }

  #onLog(entry: HistoryEntry): void {
    const channel = this.#channel(entry.channel, false);
    const isNew = !channel.log.some(existing => existing.seq === entry.seq);
    if (channel.following) {
      const oldest = channel.log[0]?.seq;
      channel.log = mergeLog(channel.log, [entry]);
      if (oldest !== undefined && channel.log[0]?.seq > oldest) channel.hasMore = true;
    } else channel.hasNewer ||= isNew;
    if (isNew && (entry.channel !== this.#state.active || !channel.following) && entry.from !== this.#state.self) {
      channel.unread++;
      if (entry.mentions.includes(this.#state.self) || entry.mentions.includes("all")) channel.mentions++;
    }
    this.#render();
  }

  #onDirect(message: AgentMailMessage): void {
    // Agents reply to the human with a direct message; the channel log carries it for
    // watched channels. Unwatched ones still surface as a notice.
    if (message.channel && this.#state.channels.some(c => c.name === message.channel)) return;
    this.#notice(`${message.from}: ${message.text.slice(0, 80)}`, "info");
  }

  #notice(text: string, tone: "error" | "success" | "info"): void {
    this.#state.notice = { text, tone };
    clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.#state.notice = undefined;
      this.#render();
    }, NOTICE_MS);
    this.#render();
  }

  // -- exit ------------------------------------------------------------------

  async #quit(code: number, message?: string): Promise<void> {
    if (this.#exiting) return;
    this.#exiting = true;
    this.#exitCode = code;
    this.#mesh.close();
    if (message) process.stderr.write(`${message}\n`);
    await this.#session?.close();
  }
}

try {
  const code = await new MessengerApp(parseArgs(process.argv.slice(2))).run();
  process.exit(code);
} catch (error) {
  process.stderr.write(`omp-messenger: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
