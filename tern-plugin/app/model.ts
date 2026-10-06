/**
 * The messenger's state: channels, their members and message logs, and the composer.
 * Pure data and transitions, no I/O, so the view and the key handling are testable
 * without a terminal or a mesh.
 */

import type { AgentRegistration, HistoryEntry } from "../../lib.ts";

/** Messages kept per channel in memory; older ones are paged back in from the server on demand. */
export const CHANNEL_LOG_LIMIT = 2000;

export interface ChannelView {
  name: string;
  joined: boolean;
  members: AgentRegistration[];
  log: HistoryEntry[];
  /** Whether the server has entries older than `log[0]`. */
  hasMore: boolean;
  loadingHistory: boolean;
  historyError?: string;
  following: boolean;
  hasNewer: boolean;
  draft: Composer;
  recipient?: string;
  sending: boolean;
  sendError?: string;
  unread: number;
  /** Unread posts that mention the human (or `@all`). */
  mentions: number;
}

export interface Composer {
  text: string;
  /** Caret, in UTF-16 code units (the editor node's offsets). */
  cursor: number;
  /** Sent drafts, newest last, for Up/Down recall. */
  history: string[];
  /** Index into `history` while recalling; null while editing a fresh draft. */
  recall: number | null;
  /** The draft that was being edited before recall started. */
  stash: string;
  undo: Array<{ text: string; cursor: number }>;
  redo: Array<{ text: string; cursor: number }>;
}

export interface Completion {
  /** UTF-16 offset of the `@` the completion replaces from. */
  start: number;
  query: string;
  options: string[];
  selected: number;
  kind?: "command";
}

export const COMMANDS: Record<string, string> = {
  "/join": "Join a channel",
  "/create": "Create a channel",
  "/delete": "Confirm channel deletion",
  "/dm": "Deliver to one member, recorded in channel history",
  "/settings": "Open Messenger settings",
  "/help": "Show command help",
};

export function createChannel(name: string, joined: boolean): ChannelView {
  return { name, joined, members: [], log: [], hasMore: true, loadingHistory: false, unread: 0, mentions: 0, following: true, hasNewer: false, draft: createComposer(), sending: false };
}

export function createComposer(): Composer {
  return { text: "", cursor: 0, history: [], recall: null, stash: "", undo: [], redo: [] };
}

export function mergeLog(log: HistoryEntry[], entries: readonly HistoryEntry[], keep: "newest" | "oldest" = "newest"): HistoryEntry[] {
  const bySeq = new Map<number, HistoryEntry>();
  for (const entry of log) bySeq.set(entry.seq, entry);
  for (const entry of entries) bySeq.set(entry.seq, entry);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length <= CHANNEL_LOG_LIMIT ? merged : keep === "oldest" ? merged.slice(0, CHANNEL_LOG_LIMIT) : merged.slice(-CHANNEL_LOG_LIMIT);
}

function remember(composer: Composer): void {
  const previous = composer.undo.at(-1);
  if (previous?.text !== composer.text) composer.undo.push({ text: composer.text, cursor: composer.cursor });
  if (composer.undo.length > 100) composer.undo.shift();
  composer.redo = [];
}

export function replaceDraft(composer: Composer, text: string, cursor = text.length): void {
  if (text !== composer.text) remember(composer);
  composer.text = text;
  composer.cursor = Math.max(0, Math.min(cursor, text.length));
  composer.recall = null;
}

export function applyNativeEdit(composer: Composer, edit: { from: number; to: number; text: string; cursor: number; len: number }): boolean {
  if (edit.len !== composer.text.length || edit.from < 0 || edit.to < edit.from || edit.to > edit.len) return false;
  replaceDraft(composer, composer.text.slice(0, edit.from) + edit.text + composer.text.slice(edit.to), edit.cursor);
  return true;
}

export function undoDraft(composer: Composer, redo = false): boolean {
  const source = redo ? composer.redo : composer.undo;
  const target = redo ? composer.undo : composer.redo;
  const previous = source.pop();
  if (!previous) return false;
  target.push({ text: composer.text, cursor: composer.cursor });
  composer.text = previous.text;
  composer.cursor = previous.cursor;
  composer.recall = null;
  return true;
}

/** Insert `text` at the caret. */
export function insertText(composer: Composer, text: string): void {
  if (text) remember(composer);
  composer.text = composer.text.slice(0, composer.cursor) + text + composer.text.slice(composer.cursor);
  composer.cursor += text.length;
  composer.recall = null;
}

/** Start of the word before `from` (Alt+Backspace, Alt+Left). */
function wordStart(text: string, from: number): number {
  let i = from;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

/** End of the word after `from` (Alt+Right). */
function wordEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

/** Step left/right over a whole UTF-16 surrogate pair. */
function stepLeft(text: string, at: number): number {
  if (at <= 0) return 0;
  const low = text.charCodeAt(at - 1);
  return at >= 2 && low >= 0xdc00 && low <= 0xdfff ? at - 2 : at - 1;
}

function stepRight(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const high = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff && at + 1 < text.length ? at + 2 : at + 1;
}

/** Editing keys the composer handles itself; returns false for keys it doesn't use. */
export function editComposer(
  composer: Composer,
  key: { name: string; ctrl: boolean; alt: boolean; meta: boolean; shift: boolean },
): boolean {
  const { text, cursor } = composer;
  const word = key.alt || key.ctrl;
  if (key.name === "backspace" || key.name === "delete" || key.ctrl && ["u", "w", "k"].includes(key.name)) remember(composer);
  switch (key.name) {
    case "backspace": {
      if (key.meta) {
        const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
        composer.text = text.slice(0, lineStart) + text.slice(cursor);
        composer.cursor = lineStart;
      } else {
        const from = word ? wordStart(text, cursor) : stepLeft(text, cursor);
        composer.text = text.slice(0, from) + text.slice(cursor);
        composer.cursor = from;
      }
      composer.recall = null;
      return true;
    }
    case "delete": {
      const to = word ? wordEnd(text, cursor) : stepRight(text, cursor);
      composer.text = text.slice(0, cursor) + text.slice(to);
      composer.recall = null;
      return true;
    }
    case "left":
      composer.cursor = key.meta ? text.lastIndexOf("\n", cursor - 1) + 1 : word ? wordStart(text, cursor) : stepLeft(text, cursor);
      return true;
    case "right": {
      const lineEnd = text.indexOf("\n", cursor);
      composer.cursor = key.meta ? (lineEnd < 0 ? text.length : lineEnd) : word ? wordEnd(text, cursor) : stepRight(text, cursor);
      return true;
    }
    case "home":
      composer.cursor = text.lastIndexOf("\n", cursor - 1) + 1;
      return true;
    case "end": {
      const lineEnd = text.indexOf("\n", cursor);
      composer.cursor = lineEnd < 0 ? text.length : lineEnd;
      return true;
    }
    case "a":
      if (key.ctrl) {
        composer.cursor = text.lastIndexOf("\n", cursor - 1) + 1;
        return true;
      }
      return false;
    case "e":
      if (key.ctrl) {
        const lineEnd = text.indexOf("\n", cursor);
        composer.cursor = lineEnd < 0 ? text.length : lineEnd;
        return true;
      }
      return false;
    case "u":
      if (key.ctrl) {
        const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
        composer.text = text.slice(0, lineStart) + text.slice(cursor);
        composer.cursor = lineStart;
        composer.recall = null;
        return true;
      }
      return false;
    case "w":
      if (key.ctrl) {
        const from = wordStart(text, cursor);
        composer.text = text.slice(0, from) + text.slice(cursor);
        composer.cursor = from;
        composer.recall = null;
        return true;
      }
      return false;
    case "k":
      if (key.ctrl) {
        const lineEnd = text.indexOf("\n", cursor);
        composer.text = text.slice(0, cursor) + (lineEnd < 0 ? "" : text.slice(lineEnd));
        composer.recall = null;
        return true;
      }
      return false;
    default:
      return false;
  }
}

/** Up/Down through sent drafts; only when the caret is on the first/last line. */
export function recallHistory(composer: Composer, direction: -1 | 1): boolean {
  const onFirstLine = !composer.text.slice(0, composer.cursor).includes("\n");
  const onLastLine = !composer.text.slice(composer.cursor).includes("\n");
  if ((direction < 0 && !onFirstLine) || (direction > 0 && !onLastLine)) return false;
  if (composer.history.length === 0) return false;
  if (composer.recall === null) {
    if (direction > 0) return false;
    composer.stash = composer.text;
    composer.recall = composer.history.length - 1;
  } else {
    const next = composer.recall + direction;
    if (next < 0) return true;
    if (next >= composer.history.length) {
      composer.recall = null;
      composer.text = composer.stash;
      composer.cursor = composer.text.length;
      return true;
    }
    composer.recall = next;
  }
  composer.text = composer.history[composer.recall];
  composer.cursor = composer.text.length;
  return true;
}

/** Record a sent draft and clear the composer. */
export function submitComposer(composer: Composer): string {
  const sent = composer.text.trim();
  if (sent && composer.history[composer.history.length - 1] !== sent) composer.history.push(sent);
  if (composer.history.length > 100) composer.history.shift();
  if (composer.text) remember(composer);
  composer.text = "";
  composer.cursor = 0;
  composer.recall = null;
  composer.stash = "";
  return sent;
}

/**
 * The mention being typed at the caret: an `@` at a word start followed by name
 * characters up to the caret. Options are `all` plus the channel's member names
 * (prefix matches first, then substring), excluding the human.
 */
export function findCompletion(composer: Composer, members: readonly string[], self: string): Completion | null {
  const before = composer.text.slice(0, composer.cursor);
  if (before.startsWith("/") && !/\s/.test(before)) {
    const options = Object.keys(COMMANDS).filter(command => command.startsWith(before));
    return options.length ? { kind: "command", start: 0, query: before, options, selected: 0 } : null;
  }
  const match = /(^|[\s(])@([A-Za-z0-9_-]*)$/.exec(before);
  if (!match) return null;
  const query = match[2];
  const start = composer.cursor - query.length - 1;
  const lower = query.toLowerCase();
  const names = ["all", ...members.filter(name => name !== self)];
  const prefix = names.filter(name => name.toLowerCase().startsWith(lower));
  const inner = names.filter(name => !name.toLowerCase().startsWith(lower) && name.toLowerCase().includes(lower));
  const options = [...prefix, ...inner];
  if (options.length === 0) return null;
  if (options.length === 1 && options[0].toLowerCase() === lower) return null;
  return { start, query, options, selected: 0 };
}

/** Replace the mention at the caret with `@name `. */
export function applyCompletion(composer: Composer, completion: Completion, name: string): void {
  if (completion.kind === "command") {
    replaceDraft(composer, `${name} ${composer.text.slice(composer.cursor)}`, name.length + 1);
    return;
  }
  remember(composer);
  const after = composer.text.slice(composer.cursor).replace(/^[A-Za-z0-9_-]*/, "");
  const insert = `@${name} `;
  composer.text = composer.text.slice(0, completion.start) + insert + after.replace(/^ /, "");
  composer.cursor = completion.start + insert.length;
  composer.recall = null;
}

/** Insert `@name ` at the caret (a click on a member), with a separating space when needed. */
export function insertMention(composer: Composer, name: string): void {
  const before = composer.text.slice(0, composer.cursor);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  insertText(composer, `${lead}@${name} `);
}
