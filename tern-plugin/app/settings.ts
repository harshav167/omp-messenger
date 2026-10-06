import { ui, type Json, type Key, type Node, type PrefsRow } from "@stencil-hq/tern";
import { getAutoRegisterPaths, getStoredMeshSettings, loadConfig, saveAutoRegisterPaths, saveMeshSettings, type StoredMeshSettings } from "../../config.ts";
import { isValidChannelName } from "../../lib.ts";
import { createComposer, editComposer, insertText, type Composer } from "./model.ts";

export class MessengerSettings {
  readonly mesh: StoredMeshSettings;
  readonly paths: string[];
  page = "connection";
  focus = "url";
  editing?: { row: "url" | "token" | "channels"; draft: Composer };
  error = "";
  readonly configuredUrl: string | null;
  constructor(readonly cwd: string, readonly effectiveUrl: string) {
    this.mesh = getStoredMeshSettings();
    this.paths = [...getAutoRegisterPaths()];
    this.configuredUrl = loadConfig(cwd).mesh.url;
  }

  view(): Node {
    const rows: PrefsRow[] = this.page === "connection" ? [
      { id: "url", label: "Server URL", hint: "User-level ws:// or wss:// address. Environment, project, and launch options can override it.", control: { k: "text", value: this.mesh.url, mono: true } },
      { id: "token", label: "Token", hint: "Stored in the existing Messenger token file. Environment and inline config tokens have higher priority.", control: { k: "text", value: this.mesh.token, secret: true } },
      { id: "channels", label: "Default channels", hint: "Comma-separated channel names for new connections.", control: { k: "text", value: this.mesh.channels.join(", ") } },
      { id: "save", label: "Save and reconnect", hint: this.error || `Current app URL is ${this.effectiveUrl}. Effective configured URL is ${this.configuredUrl ?? "local filesystem"}.`, warning: this.error || undefined, control: { k: "action", act: "settings-save", label: "Save" } },
    ] : [
      { id: "add-path", label: "Auto-join this folder in OMP", hint: this.cwd, control: { k: "action", act: "settings-add-path", label: "Add folder" } },
      ...this.paths.map((path, index): PrefsRow => ({ id: `path-${index}`, label: path, hint: "Applies to future OMP sessions. It does not create a channel.", control: { k: "action", act: "settings-remove-path", label: "Remove" } })),
      { id: "save", label: "Save folders", warning: this.error || undefined, control: { k: "action", act: "settings-save", label: "Save" } },
    ];
    return ui.prefs({
      key: "settings", title: "Messenger settings", page: this.page,
      pages: [{ id: "connection", label: "Connection", icon: "server" }, { id: "folders", label: "OMP auto-join", icon: "folder" }],
      lead: "Edits the same user configuration as /messenger config. Project and environment overrides remain in effect.",
      focus: this.focus, editing: this.editing ? { row: this.editing.row, draft: this.editing.draft.text, cursor: this.editing.draft.cursor } : undefined,
      sections: [{ id: "settings", rows }]
    });
  }

  activate(row: string): void {
    this.focus = row;
    if (row !== "url" && row !== "token" && row !== "channels") return;
    const draft = createComposer();
    insertText(draft, row === "channels" ? this.mesh.channels.join(",") : this.mesh[row]);
    this.editing = { row, draft };
  }

  key(key: Key): "close" | "save" | undefined {
    if (this.editing) {
      if (key.name === "escape") this.editing = undefined;
      else if (key.name === "enter") this.commit();
      else if (key.text && !key.ctrl && !key.meta) insertText(this.editing.draft, key.text.replace(/[\r\n]/g, ""));
      else editComposer(this.editing.draft, key);
      return;
    }
    if (key.name === "escape") return "close";
    if (key.name === "s" && (key.ctrl || key.meta)) return "save";
    const names = this.page === "connection" ? ["url", "token", "channels", "save"] : ["add-path", ...this.paths.map((_, index) => `path-${index}`), "save"];
    const index = Math.max(0, names.indexOf(this.focus));
    if (key.name === "up" || key.name === "down") this.focus = names[Math.max(0, Math.min(names.length - 1, index + (key.name === "up" ? -1 : 1)))];
    if (key.name === "tab") { this.page = this.page === "connection" ? "folders" : "connection"; this.focus = this.page === "connection" ? "url" : "add-path"; }
    if (key.name === "enter") {
      if (this.focus === "save") return "save";
      if (this.focus === "add-path") this.addPath();
      else if (this.focus.startsWith("path-")) this.removePath(this.focus);
      else this.activate(this.focus);
    }
  }

  change(row: string | undefined, value: Json | undefined): void {
    if (!row || typeof value !== "string") return;
    if (row === "channels") this.mesh.channels = value.split(",").map(item => item.trim()).filter(Boolean);
    else if (row === "url" || row === "token") this.mesh[row] = value;
  }

  addPath(): void { if (!this.paths.includes(this.cwd)) this.paths.push(this.cwd); }
  removePath(row: string | undefined): void {
    if (!row?.startsWith("path-")) return;
    const index = Number(row.slice(5));
    if (Number.isInteger(index) && index >= 0 && index < this.paths.length) this.paths.splice(index, 1);
  }

  commit(): void {
    if (!this.editing) return;
    this.change(this.editing.row, this.editing.draft.text.trim());
    this.editing = undefined;
  }

  save(): boolean {
    this.commit();
    try {
      if (!/^wss?:\/\//.test(this.mesh.url)) throw new Error("The Tern app requires a ws:// or wss:// server URL.");
      const url = new URL(this.mesh.url);
      if (!url.hostname) throw new Error("Enter a server hostname.");
      if (!this.mesh.channels.length || this.mesh.channels.some(name => !isValidChannelName(name))) throw new Error("Enter valid comma-separated channel names.");
      saveMeshSettings(this.mesh);
      saveAutoRegisterPaths(this.paths);
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
}
