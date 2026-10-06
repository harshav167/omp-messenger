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

/** The composer's node id: the controller focuses it and reads its edits, and mention suggestions anchor to its caret. */
export const COMPOSER_ID = "dock.chat.composer";
/** Below this pane width (columns) both sidebars become sheets opened from the header. */
const NARROW_COLS = 80;
/** Below this pane width the members panel stays a slim strip; expanding it opens a sheet. */
export const MEMBERS_COLS = 100;

/** How a sidebar shows: a full panel, a slim strip that reopens it, or a sheet opened from the header. */
type Side = "open" | "slim" | "sheet";

export function sidebarLayout(cols: number, sidebars: ViewState["sidebars"]): { channels: Side; members: Side } {
  if (cols < NARROW_COLS) return { channels: "sheet", members: "sheet" };
  return {
    channels: sidebars.channels ? "open" : "slim",
    members: sidebars.members && cols >= MEMBERS_COLS ? "open" : "slim",
  };
}

/** Panel widths; the timeline and dock reserve the same widths so nothing draws under a panel. */
const SIDE_WIDTH: Record<"channels" | "members", Record<Side, string>> = {
  channels: { open: "15em", slim: "3em", sheet: "0px" },
  members: { open: "18em", slim: "3em", sheet: "0px" },
};

function button(key: string, label: string, action: string, style = "", disabled = false): Node {
  return html.button({ key, class: `messenger-button ${style}${disabled ? " disabled" : ""}`, attrs: { "aria-disabled": disabled }, actions: disabled ? undefined : { click: action } }, label);
}

function rail(state: ViewState, root: string, collapsible: boolean): Node {
  return ui.col({ key: "rail", gap: "sm" },
    ui.row({ key: "head", gap: "sm", align: "center" },
      ui.text({ key: "title", spans: [span("Channels", "muted strong")], grow: 1 }),
      button("new", "+ New", "new-channel"),
      collapsible ? html.button({ key: "collapse", class: "messenger-button icon", title: "Collapse channels", actions: { click: "channels" } }, "«") : null),
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
  return ui.col({ key: "msg", role: entry.kind === "dm" ? "messenger.dm" : mentioned ? "messenger.mention" : "messenger.message", gap: "xs" },
    grouped ? null : ui.row({ key: "head", gap: "sm", align: "baseline" },
      ui.text({ key: "from", spans: [span(entry.from, mine ? "accent strong" : "strong")], actions: mine ? undefined : { click: `mention=${entry.from}`, menu: [`mention=${entry.from}`, "copy"] } }),
      entry.kind === "dm" ? ui.text({ key: "to", spans: [span(`to ${entry.to ?? "?"}`, "muted")] }) : null,
      ui.text({ key: "time", spans: [span(time, "dim")], title: entry.timestamp })),
    ui.md({ key: "body", text: entry.text, marks: entry.mentions.map(name => span(`@${name}`, "accent strong")) }));
}

/**
 * The transcript as `main`'s own children, one row per entry like omp's transcript: Tern lays out, anchors
 * and follows `main` child by child, and the inset role keeps each row clear of the panels.
 */
function transcript(state: ViewState, channel: ChannelView | undefined, insets: string): Node[] {
  const role = `messenger.row-${insets}`;
  const rows: (Node | null)[] = [
    !channel ? ui.text({ key: "choose", role, text: "Choose a channel" })
      : channel.hasMore ? ui.col({ key: "older", role }, button("button", channel.loadingHistory ? "Loading…" : "Load older messages", "older", "", channel.loadingHistory)) : null,
    channel?.historyError ? ui.text({ key: "error", role, text: channel.historyError, tone: "error" }) : null,
    channel?.hasNewer ? ui.text({ key: "newer", role, text: "Viewing older history. Jump to latest to see new messages.", tone: "muted" }) : null,
    channel?.log.length === 0 ? ui.text({ key: "empty", role, text: "No messages yet. Mention @all to reach everyone.", tone: "muted" }) : null,
    ...(channel?.log.map((entry, index) => ui.col({ key: `m${entry.seq}`, role }, messageNode(entry, channel.log[index - 1], state))) ?? []),
  ];
  return rows.filter(row => row !== null);
}

/** One member: identity and status, what it is, what it's doing, and live activity / session timers. */
function memberBlock(member: AgentRegistration, state: ViewState): Node {
  const last = member.activity?.lastActivityAt ?? member.startedAt;
  const status = computeStatus(last, false, (member.reservations?.length ?? 0) > 0, state.stuckThresholdMs).status;
  const tone = AGENT_TONE[status];
  const idle = Date.now() - Date.parse(last);
  const age = Date.now() - Date.parse(member.startedAt);
  const human = member.model === "human";
  const self = member.name === state.self;
  const kind = human ? "human" : member.model.split("/").at(-1) ?? "agent";
  return ui.col({ key: `mb-${idPart(member.name)}`, role: "messenger.member", gap: "xs", title: [member.cwd, member.gitBranch].filter(Boolean).join(" · ") },
    ui.row({ key: "identity", gap: "sm", align: "center" },
      ui.icon({ key: "icon", name: human ? "user" : "sparkle", tone, aria: human ? "Human member" : "Agent member" }),
      ui.text({
        key: "name", grow: 1, spans: [span(member.name, "strong")], wrap: "none", truncate: "end",
        actions: self ? undefined : { click: `mention=${member.name}`, menu: [`mention=${member.name}`, `direct=${member.name}`] },
      }),
      ui.badge({ key: "status", text: status, tone })),
    ui.text({ key: "about", text: self ? `You · ${kind}` : kind, tone: "muted", wrap: "none", truncate: "end" }),
    member.activity?.currentActivity ? ui.text({ key: "activity", text: member.activity.currentActivity, tone: "muted", wrap: "none", truncate: "end" }) : null,
    member.statusMessage ? ui.text({ key: "doing", text: member.statusMessage, tone: "muted", wrap: "none", truncate: "end" }) : null,
    ui.row({ key: "idle", role: "messenger.member-metric", justify: "between", gap: "sm", align: "center" },
      ui.text({ key: "label", text: "Since activity", tone: "muted", wrap: "none" }),
      Number.isFinite(idle) ? ui.elapsed({ key: "value", age: Math.max(0, idle), aria: "Time since activity" }) : ui.text({ key: "unknown", text: "Unknown" })),
    ui.row({ key: "session", role: "messenger.member-metric", justify: "between", gap: "sm", align: "center" },
      ui.text({ key: "label", text: "Session age", tone: "muted", wrap: "none" }),
      Number.isFinite(age) ? ui.elapsed({ key: "value", age: Math.max(0, age), aria: "Session age" }) : ui.text({ key: "unknown", text: "Unknown" })),
    self ? null : button("direct", "Message individually", `direct=${member.name}`, "subtle"));
}

function members(state: ViewState, channel: ChannelView | undefined, collapsible: boolean): Node {
  return ui.col({ key: "members", gap: "sm" },
    ui.row({ key: "head", gap: "sm", align: "center" },
      ui.text({ key: "title", spans: [span(`Members · ${channel?.members.length ?? 0}`, "muted strong")], grow: 1 }),
      collapsible ? html.button({ key: "collapse", class: "messenger-button icon", title: "Collapse members", actions: { click: "members" } }, "»") : null),
    channel?.members.length ? channel.members.map(member => memberBlock(member, state)) : ui.text({ key: "empty", text: "Nobody here yet", tone: "muted" }));
}

function header(state: ViewState, channel: ChannelView | undefined, layout: { channels: Side; members: Side }, insets: string): Node {
  // Tern's own ↓ returns an inline transcript to its live end; this button only leaves an older history window.
  return ui.row({ key: "header", role: `messenger.header-${insets}`, gap: "sm", align: "center" },
    layout.channels === "sheet" ? button("channels", "Channels", "channels") : null,
    ui.text({ key: "name", spans: [span(channel ? `#${channel.name}` : "No channel", "strong")], wrap: "none", truncate: "end" }),
    ui.text({ key: "count", spans: [span(channel ? `${channel.members.length} members${channel.joined ? "" : " · watching"}` : "", "muted")], grow: 1, wrap: "none", truncate: "end" }),
    channel && !channel.joined ? button("join", "Join channel", "join-channel", "primary", state.connection !== "connected") : null,
    channel?.hasNewer ? button("latest", `Jump to latest${channel.unread ? ` (${channel.unread} new)` : ""}`, "latest") : null,
    button("settings", "Settings", "settings"),
    channel && channel.name !== "main" ? button("delete", "Delete", "delete-channel") : null,
    layout.members === "sheet" ? button("members", "Members", "members") : null);
}

function suggestions(state: ViewState): Node | null {
  const completion = state.completion;
  if (!completion) return null;
  return ui.overlay({ key: "suggestions", anchor: { caret: COMPOSER_ID }, size: "sm" },
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

/** The settings page's node id on its own screen surface; its events carry this id. */
export const SETTINGS_ID = "main.settings";

export function buildView(state: ViewState): ViewInput {
  const channel = state.channels.find(item => item.name === state.active);
  const writable = channel?.joined === true && state.connection === "connected";
  const ready = writable && !channel.sending && !state.dialog && !state.panel;
  const layout = sidebarLayout(state.cols, state.sidebars);
  const insets = `${layout.channels}-${layout.members}`;
  const panel = state.panel ? ui.overlay({ key: "panel", head: state.panel === "channels" ? "Channels" : "Members", modal: true, size: "md" },
    button("close", "Close", "close-panel"),
    state.panel === "channels" ? rail(state, "layer.panel.rail", false) : members(state, channel, false)) : null;
  return {
    main: ui.col({}, transcript(state, channel, insets)),
    dock: ui.col({},
      ui.col({ key: "chat", role: `messenger.dock-${insets}`, gap: "xs" },
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
          button("all", "Mention @all", "mention=all", "", !writable),
          button("send", channel?.sending ? "Sending…" : "Send", "send-message", "primary", !ready || !state.composer.text.trim())),
        ui.status({ key: "status" },
          ui.seg({ key: "connection", icon: "broadcast", text: state.connection === "connected" ? state.url : state.connectionDetail ?? state.connection, tone: STATUS_TONE[state.connection], priority: 2 }),
          ui.seg({ key: "self", icon: "user", text: state.self, priority: 3 }),
          state.notice ? ui.seg({ key: "notice", text: state.notice.text, tone: state.notice.tone, priority: 5 }) : null,
          ui.seg({ key: "keys", side: "right", text: "Enter send · Shift+Enter newline · Tab complete", priority: 1 })))),
    layer: ui.col({},
      header(state, channel, layout, insets),
      layout.channels === "sheet" ? null : ui.col({ key: "left", role: `messenger.side-left-${layout.channels}`, gap: "sm" },
        layout.channels === "open" ? rail(state, "layer.left.rail", true)
          : ui.col({ key: "strip", gap: "sm", align: "center" },
            html.button({ key: "expand", class: "messenger-button icon", title: "Show channels", actions: { click: "channels" } }, "»"),
            html.button({ key: "new", class: "messenger-button icon", title: "New channel", actions: { click: "new-channel" } }, "+"))),
      layout.members === "sheet" ? null : ui.col({ key: "right", role: `messenger.side-right-${layout.members}`, gap: "sm" },
        layout.members === "open" ? members(state, channel, true)
          : ui.col({ key: "strip", gap: "sm", align: "center" },
            html.button({ key: "expand", class: "messenger-button icon", title: "Show members", actions: { click: "members" } }, "«"),
            ui.text({ key: "count", text: String(channel?.members.length ?? 0), tone: "muted", title: "Members in this channel" }))),
      state.dialog ? dialogNode(state.dialog) : panel ?? suggestions(state)),
  };
}

// Every layout `sidebarLayout` can produce, so the sheet styles exactly the reachable insets.
const LAYOUTS = [...new Map([NARROW_COLS - 1, MEMBERS_COLS - 1, MEMBERS_COLS].flatMap(cols =>
  [true, false].flatMap(channels => [true, false].map(members => sidebarLayout(cols, { channels, members }))))
  .map(layout => [`${layout.channels}-${layout.members}`, layout] as const)).values()];
// Scoped sheets can't style region elements (.sf-main), so every transcript row and the dock's column
// reserve the panels' widths; the header bar sits between the panels in the layer.
const INSET_RULES = LAYOUTS.flatMap(({ channels: left, members: right }) => [
  `[data-role='messenger.row-${left}-${right}'], [data-role='messenger.dock-${left}-${right}'] { padding-left: calc(${SIDE_WIDTH.channels[left]} + 12px); padding-right: calc(${SIDE_WIDTH.members[right]} + 12px); }`,
  `[data-role='messenger.header-${left}-${right}'] { left: ${SIDE_WIDTH.channels[left]}; right: ${SIDE_WIDTH.members[right]}; }`,
]);
const SIDE_RULES = (["open", "slim"] as const).flatMap(side => [
  `[data-role='messenger.side-left-${side}'] { width: ${SIDE_WIDTH.channels[side]}; }`,
  `[data-role='messenger.side-right-${side}'] { width: ${SIDE_WIDTH.members[side]}; }`,
]);

export const STYLESHEET = `
/* Inline surfaces center main's children on the chat skin's 720px measure; rows and the dock span the pane. */
[data-role^='messenger.row-'], [data-role^='messenger.dock-'] { box-sizing: border-box; width: 100% !important; max-width: none !important; margin-left: 0 !important; margin-right: 0 !important; }
[data-role^='messenger.row-']:first-child { padding-top: 56px; }
[data-role^='messenger.row-']:last-child { padding-bottom: 12px; }
${INSET_RULES.join("\n")}
[data-role^='messenger.header-'] { position: absolute; top: 0; z-index: 1; height: 44px; box-sizing: border-box; padding: 0 12px; background: var(--pop-bg); backdrop-filter: blur(32px) saturate(190%); border-bottom: 1px solid var(--l2); pointer-events: auto; }
[data-role^='messenger.side-'] { position: absolute; top: 0; bottom: 0; box-sizing: border-box; padding: 8px 6px; overflow-y: auto; overscroll-behavior: contain; background: var(--panel); pointer-events: auto; }
[data-role^='messenger.side-left-'] { left: 0; border-right: 1px solid var(--l2); }
[data-role^='messenger.side-right-'] { right: 0; border-left: 1px solid var(--l2); }
${SIDE_RULES.join("\n")}
[data-role='messenger.message'], [data-role='messenger.mention'], [data-role='messenger.dm'] { padding: 6px 8px; border-radius: 6px; }
[data-role='messenger.mention'] { background: rgb(from var(--accent) r g b / 8%); }
[data-role='messenger.dm'] { background: var(--l1); }
[data-role='messenger.member'] { padding: 8px 6px; border-radius: 6px; border-bottom: 1px solid var(--l2); }
[data-role='messenger.member']:last-child { border-bottom: none; }
[data-role='messenger.member']:hover { background: var(--l1); }
[data-role='messenger.member-metric'] { white-space: nowrap; font-variant-numeric: tabular-nums; }
.messenger-button.subtle { align-self: flex-start; margin-top: 2px; padding: 2px 8px; background: transparent; color: var(--accent); }
.messenger-button.subtle:hover { background: var(--l1); }
.messenger-button { padding: 4px 10px; border-radius: 6px; background: var(--l1); white-space: nowrap; }
.messenger-button.icon { padding: 4px 8px; }
.messenger-button:hover { background: var(--l2); }
.messenger-button.disabled { opacity: 0.45; cursor: default; }
.messenger-button.primary { background: var(--accent-fill); color: #fff; }
.messenger-button.danger { background: var(--bad-fill); color: #fff; }
`;
