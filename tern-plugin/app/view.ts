import { html, span, ui, type Node, type ViewInput } from "@stencil-hq/tern";
import { computeStatus, type AgentRegistration, type AgentStatus, type HistoryEntry } from "../../lib.ts";
import { COMMANDS, type ChannelView, type Composer, type Completion } from "./model.ts";
import type { ConnectionState } from "./mesh.ts";

export type Operation = { state: "ready" } | { state: "pending" } | { state: "error"; error: string };
export type Dialog =
  | { kind: "create"; input: Composer; operation: Operation }
  | { kind: "delete"; channel: string; members: string[]; operation: Operation };

export interface ViewState {
  self: string;
  connection: ConnectionState;
  connectionDetail?: string;
  url: string;
  channels: ChannelView[];
  active: string;
  composer: Composer;
  completion: Completion | null;
  notice?: { text: string; tone: "error" | "success" | "info" };
  stuckThresholdMs: number;
  cols: number;
  hour12: boolean;
  panel: "channels" | "members" | null;
  sidebars: { channels: boolean; members: boolean };
  settings?: Node;
  dialog?: Dialog;
}

export function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, ch => `.${ch.codePointAt(0)?.toString(16)}`);
}

const STATUS_TONE: Record<ConnectionState, string> = {
  connected: "success", connecting: "pending", reconnecting: "warning", rejected: "error",
};
const AGENT_TONE: Record<AgentStatus, string> = {
  active: "success", idle: "warning", away: "muted", stuck: "error",
};

function button(key: string, label: string, action: string, style = "", disabled = false): Node {
  return html.button({ key, class: `messenger-button ${style}${disabled ? " disabled" : ""}`, attrs: { "aria-disabled": disabled }, actions: disabled ? undefined : { click: action } }, label);
}

function rail(state: ViewState, root = "layer.rail"): Node {
  return ui.col({ key: "rail", role: "messenger.rail", gap: "sm" },
    ui.row({ key: "head", justify: "between", align: "center" },
      ui.text({ key: "title", spans: [span("Channels", "muted strong")] }),
      button("new", "+ New", "new-channel")),
    ui.list({ key: "list", selected: `${root}.list.ch-${idPart(state.active)}`, empty: "No channels" },
      state.channels.map(channel => ui.item({
        key: `ch-${idPart(channel.name)}`,
        label: [span(`#${channel.name}`, channel.unread ? "strong" : "")],
        icon: "hash",
        detail: channel.joined ? undefined : "watching",
        value: channel.mentions ? `@${channel.mentions}` : channel.unread ? String(channel.unread) : undefined,
        title: `${channel.members.length} members`,
        actions: channel.name === "main" ? undefined : { menu: ["delete-channel"] },
      }))),
  );
}

function messageNode(entry: HistoryEntry, previous: HistoryEntry | undefined, state: ViewState): Node {
  const grouped = previous?.from === entry.from && previous.kind === entry.kind && previous.to === entry.to
    && Date.parse(entry.timestamp) - Date.parse(previous.timestamp) < 300_000;
  const mine = entry.from === state.self;
  const mentioned = entry.mentions.includes(state.self) || entry.mentions.includes("all");
  const date = new Date(entry.timestamp);
  const time = Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: state.hour12 });
  return ui.col({ key: `m${entry.seq}`, role: entry.kind === "dm" ? "messenger.dm" : mentioned ? "messenger.mention" : "messenger.message", gap: "xs" },
    grouped ? null : ui.row({ key: "head", gap: "sm", align: "baseline" },
      ui.text({ key: "from", spans: [span(entry.from, mine ? "accent strong" : "strong")], actions: mine ? undefined : { click: `mention=${entry.from}`, menu: [`mention=${entry.from}`, "copy"] } }),
      entry.kind === "dm" ? ui.text({ key: "to", spans: [span(`to ${entry.to ?? "?"}`, "muted")] }) : null,
      ui.text({ key: "time", spans: [span(time, "dim")], title: entry.timestamp })),
    ui.md({ key: "body", text: entry.text, marks: entry.mentions.map(name => span(`@${name}`, "accent strong")) }));
}

function timeline(state: ViewState, channel: ChannelView | undefined, role: string): Node {
  return ui.col({ role },
    !channel ? ui.text({ key: "empty", text: "Choose a channel" })
      : channel.hasMore ? button("older", channel.loadingHistory ? "Loading…" : "Load older messages", "older", "", channel.loadingHistory) : null,
    channel?.historyError ? ui.text({ key: "error", text: channel.historyError, tone: "error" }) : null,
    channel?.hasNewer ? ui.text({ key: "newer", text: "Viewing older history. Jump to latest to see new messages.", tone: "muted" }) : null,
    channel?.log.length === 0 ? ui.text({ key: "empty", text: "No messages yet. Mention @all to reach everyone.", tone: "muted" }) : null,
    channel?.log.map((entry, index) => messageNode(entry, channel.log[index - 1], state)) ?? []);
}

function memberNode(member: AgentRegistration, state: ViewState): Node {
  const last = member.activity?.lastActivityAt ?? member.startedAt;
  const status = computeStatus(last, false, (member.reservations?.length ?? 0) > 0, state.stuckThresholdMs).status;
  const idle = Math.max(0, Date.now() - Date.parse(last));
  const age = Math.max(0, Date.now() - Date.parse(member.startedAt));
  const human = member.model === "human";
  return ui.card({ key: `mb-${idPart(member.name)}`, role: "messenger.member", tone: AGENT_TONE[status] },
    ui.row({ key: "identity", role: "messenger.member-head", gap: "sm", align: "center" },
      ui.icon({ key: "icon", name: human ? "user" : "sparkle", tone: AGENT_TONE[status], aria: human ? "Human member" : "Agent member" }),
      ui.text({
        key: "name", role: "messenger.member-name", grow: 1, spans: [span(member.name, "strong")], wrap: "none", truncate: "end",
        actions: member.name === state.self ? undefined : { click: `mention=${member.name}`, menu: [`mention=${member.name}`, `direct=${member.name}`] },
        title: [member.model, member.cwd, member.gitBranch].filter(Boolean).join(" · ")
      }),
      ui.badge({ key: "status", text: status, tone: AGENT_TONE[status] })),
    ui.text({ key: "type", text: human ? "Human" : member.model.split("/").at(-1) ?? "Agent", tone: "muted", wrap: "none", truncate: "end" }),
    member.statusMessage ? ui.text({ key: "detail", text: member.statusMessage, tone: "muted", lines: 1 }) : null,
    ui.row({ key: "idle", role: "messenger.member-metric", justify: "between", gap: "sm", align: "center" },
      ui.text({ key: "label", text: "Since activity", tone: "muted", wrap: "none" }),
      Number.isFinite(idle) ? ui.elapsed({ key: "value", age: idle, aria: "Time since activity" }) : ui.text({ key: "unknown", text: "Unknown" })),
    ui.row({ key: "session", role: "messenger.member-metric", justify: "between", gap: "sm", align: "center" },
      ui.text({ key: "label", text: "Session age", tone: "muted", wrap: "none" }),
      Number.isFinite(age) ? ui.elapsed({ key: "value", age, aria: "Session age" }) : ui.text({ key: "unknown", text: "Unknown" })),
    member.name === state.self ? null : button("direct", "Message individually", `direct=${member.name}`));
}

function members(state: ViewState, channel: ChannelView | undefined): Node {
  return ui.col({ key: "members", role: "messenger.members", gap: "sm" },
    ui.text({ key: "head", text: "Members", tone: "muted" }),
    button("all", "Mention @all", "mention=all"),
    channel?.members.length ? channel.members.map(member => memberNode(member, state)) : ui.text({ key: "empty", text: "Nobody here yet", tone: "muted" }));
}

function suggestions(state: ViewState): Node | null {
  const completion = state.completion;
  if (!completion) return null;
  return ui.overlay({ key: "suggestions", anchor: { caret: "dock.composer" }, size: "sm" },
    ui.list({ key: "suggest", selected: `layer.suggestions.suggest.sg-${idPart(completion.options[completion.selected] ?? "")}`, max: { lines: 6 } },
      completion.options.map(name => ui.item({ key: `sg-${idPart(name)}`, label: completion.kind === "command" ? name : `@${name}`, detail: completion.kind === "command" ? COMMANDS[name] : name === "all" ? "Everyone in this channel" : "Mention this member", actions: { click: `complete=${name}` } }))));
}

function dialogNode(dialog: Dialog): Node {
  const pending = dialog.operation.state === "pending";
  const error = dialog.operation.state === "error" ? ui.text({ key: "error", text: dialog.operation.error, tone: "error" }) : null;
  return ui.overlay({ key: "dialog", head: dialog.kind === "create" ? "New channel" : `Delete #${dialog.channel}?`, anchor: "center", size: "md", modal: true },
    dialog.kind === "create" ? ui.col({ key: "body", gap: "sm" },
      ui.text({ key: "hint", text: "Use lowercase letters, digits, - and _. You join the channel when you create it.", tone: "muted" }),
      ui.input({ key: "input", text: dialog.input.text, cursor: dialog.input.cursor, placeholder: "channel-name", prompt: "#", readonly: pending, aria: "Channel name" }))
      : ui.col({ key: "body", gap: "sm" },
        ui.text({ key: "members", text: dialog.members.length ? `${dialog.members.join(", ")} will be removed and notified.` : "No other members are in this channel." }),
        ui.text({ key: "warning", text: "This deletes the channel history for everyone. Members left without a channel move to #main.", tone: "warning" })),
    error,
    ui.row({ key: "actions", justify: "end", gap: "sm" },
      button("cancel", "Cancel", "dialog-cancel", "", pending),
      button("confirm", pending ? "Working…" : dialog.kind === "create" ? "Create" : "Delete channel", "dialog-confirm", dialog.kind === "create" ? "primary" : "danger", pending)));
}

export function buildView(state: ViewState): ViewInput {
  const channel = state.channels.find(item => item.name === state.active);
  const writable = channel?.joined === true && state.connection === "connected";
  const ready = writable && !channel.sending && !state.dialog && !state.settings && !state.panel;
  const narrow = state.cols < 90;
  const medium = state.cols < 125;
  const showChannels = !narrow && state.sidebars.channels;
  const showMembers = !medium && state.sidebars.members;
  const layout = `${showChannels ? "c" : ""}${showMembers ? "m" : ""}` || "none";
  const regionRole = `messenger.center-${layout}`;
  const panel = state.panel ? ui.overlay({ key: "panel", head: state.panel === "channels" ? "Channels" : "Members", modal: true, size: "md" },
    button("close", "Close", "close-panel"),
    state.panel === "channels" ? rail(state, "layer.panel.rail") : members(state, channel)) : null;
  return {
    main: timeline(state, channel, regionRole),
    dock: ui.col({ role: regionRole },
      channel?.recipient ? ui.row({ key: "recipient", gap: "sm" },
        ui.text({ key: "name", text: `To ${channel.recipient}. Only this member receives delivery. Recorded in channel history.`, tone: "warning" }),
        button("group", "Back to group", "group")) : null,
      channel?.sendError ? ui.text({ key: "send-error", text: channel.sendError, tone: "error" }) : null,
      ui.editor({
        key: "composer", text: state.composer.text, cursor: state.composer.cursor,
        placeholder: !channel ? "Choose a channel" : channel.joined ? channel.recipient ? `Message ${channel.recipient}` : `Message #${channel.name}` : `Join #${channel.name} to post`,
        prompt: channel ? `#${channel.name} ` : "", maxLines: 8, readonly: channel?.joined !== true,
        sendable: ready, aria: "Message",
        ghost: state.completion?.options[state.completion.selected]?.slice(state.completion.query.length)
      }),
      ui.row({ key: "send-controls", gap: "sm", justify: "end" },
        button("latest", channel?.hasNewer ? `Jump to latest${channel.unread ? ` (${channel.unread} new)` : ""}` : "Jump to latest", "latest", "", !channel),
        button("all", "Mention @all", "mention=all", "", !writable),
        button("send", channel?.sending ? "Sending…" : "Send", "send-message", "primary", !ready || !state.composer.text.trim())),
      ui.status({ key: "status" },
        ui.seg({ key: "connection", icon: "broadcast", text: state.connection === "connected" ? state.url : state.connectionDetail ?? state.connection, tone: STATUS_TONE[state.connection], priority: 2 }),
        ui.seg({ key: "self", icon: "user", text: state.self, priority: 3 }),
        state.notice ? ui.seg({ key: "notice", text: state.notice.text, tone: state.notice.tone, priority: 5 }) : null,
        ui.seg({ key: "keys", side: "right", text: "Enter send · Shift+Enter newline · Tab complete", priority: 1 }))),
    layer: ui.col({},
      ui.row({ key: "toolbar", role: "messenger.toolbar", gap: "sm", align: "center" },
        button("channels", showChannels ? "Hide channels" : "Show channels", "channels"),
        button("new", "New channel", "new-channel"),
        button("members", showMembers ? "Hide members" : "Show members", "members"),
        button("settings", "Settings", "settings")),
      channel ? ui.row({ key: "header", role: `messenger.header-${layout}`, justify: "between", align: "center", gap: "sm" },
        ui.text({ key: "name", spans: [span(`#${channel.name}`, "strong")] }),
        ui.text({ key: "count", spans: [span(`${channel.members.length} members${channel.joined ? "" : " · watching"}`, "muted")] }),
        channel.joined ? null : button("join", "Join channel", "join-channel", "primary", state.connection !== "connected"),
        channel.name === "main" ? null : button("delete", "Delete", "delete-channel")) : null,
      showChannels ? rail(state) : null,
      showMembers ? members(state, channel) : null,
      state.settings ?? (state.dialog ? dialogNode(state.dialog) : panel ?? suggestions(state))),
  };
}

export const STYLESHEET = `
[data-role='messenger.toolbar'] { position: absolute; top: 0; left: 0; right: 0; height: 36px; padding: 0 8px; background: var(--page); border-bottom: 1px solid var(--l2); pointer-events: auto; }
[data-role^='messenger.header-'] { position: absolute; top: 36px; height: 38px; padding: 0 8px; background: var(--page); border-bottom: 1px solid var(--l2); pointer-events: auto; }
[data-role='messenger.header-cm'], [data-role='messenger.header-c'] { left: 180px; }
[data-role='messenger.header-m'], [data-role='messenger.header-none'] { left: 0; }
[data-role='messenger.header-cm'], [data-role='messenger.header-m'] { right: 230px; }
[data-role='messenger.header-c'], [data-role='messenger.header-none'] { right: 0; }
[data-role='messenger.rail'], [data-role='messenger.members'] { position: absolute; top: 36px; bottom: 0; box-sizing: border-box; min-height: 0; padding: 8px; overflow-y: auto; overscroll-behavior: contain; background: var(--page); pointer-events: auto; }
[data-role='messenger.rail'] { left: 0; width: 180px; border-right: 1px solid var(--l2); }
[data-role='messenger.members'] { right: 0; width: 230px; min-width: 0; border-left: 1px solid var(--l2); }
[data-id='layer.panel.rail'], [data-id='layer.panel.members'] { position: static; width: auto; border: none; max-height: 60vh; }
[data-role='messenger.message'], [data-role='messenger.mention'], [data-role='messenger.dm'] { padding: 6px 8px; border-radius: 6px; }
[data-role='messenger.mention'] { background: rgb(from var(--accent) r g b / 8%); }
[data-role='messenger.dm'] { background: var(--l1); }
[data-role='messenger.member'] { border: 1px solid var(--l2); border-left: 3px solid var(--tc); border-radius: 8px; background: var(--l1); }
[data-role='messenger.member'] > .sf-card-body { gap: 8px; }
[data-role='messenger.member-head'] { min-width: 0; }
[data-role='messenger.member-name'] { min-width: 0; font-weight: 700; color: var(--t1); font-size: 14px; }
[data-role='messenger.member-metric'] { white-space: nowrap; }
.messenger-button { padding: 4px 10px; border-radius: 6px; background: var(--l1); }
.messenger-button:hover { background: var(--l2); }
.messenger-button.disabled { opacity: 0.45; cursor: default; }
.messenger-button.primary { background: var(--accent-fill); color: #fff; }
.messenger-button.danger { background: rgb(from var(--bad) r g b / 85%); color: #fff; }
`;
