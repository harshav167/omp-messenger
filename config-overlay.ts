/**
 * omp-messenger - Config Overlay Component
 *
 * Edits the user-level settings that decide how this machine joins a mesh
 * (server URL, token, channels) plus the auto-register folder list. Saving mesh
 * settings hands them to the host, which rebuilds the mesh and rejoins.
 */

import type { Component, Focusable, TUI } from "@oh-my-pi/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import {
  getAutoRegisterPaths,
  getStoredMeshSettings,
  matchesAutoRegisterPath,
  saveAutoRegisterPaths,
  saveMeshSettings,
  type StoredMeshSettings,
} from "./config.ts";
import { isValidChannelName, normalizeChannels } from "./lib.ts";

type MeshField = "url" | "token" | "channels";
const MESH_FIELDS: MeshField[] = ["url", "token", "channels"];
const FIELD_LABELS: Record<MeshField, string> = { url: "Server URL", token: "Token", channels: "Channels" };
const FIELD_HINTS: Record<MeshField, string> = {
  url: "ws://host:8765 — empty = local filesystem mesh",
  token: "shared secret from the server's OMP_MESSENGER_MESH_TOKEN",
  channels: "comma-separated, e.g. main,blue",
};

export interface ConfigOverlayCallbacks {
  /** Invoked after mesh settings were written; the host reconnects. */
  onMeshSettingsSaved?: (settings: StoredMeshSettings) => void;
}

export class MessengerConfigOverlay implements Component, Focusable {
  readonly width = 72;
  focused = false;

  private mesh: StoredMeshSettings;
  private savedMesh: StoredMeshSettings;
  private paths: string[];
  /** 0..2 = mesh fields, 3.. = auto-register paths. */
  private cursor = 0;
  private editing: MeshField | null = null;
  private editBuffer = "";
  private pathsDirty = false;
  private statusMessage = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: () => void,
    private cwd: string,
    private callbacks: ConfigOverlayCallbacks = {},
  ) {
    this.mesh = getStoredMeshSettings();
    this.savedMesh = { ...this.mesh, channels: [...this.mesh.channels] };
    this.paths = getAutoRegisterPaths();
  }

  private get meshDirty(): boolean {
    return this.mesh.url !== this.savedMesh.url
      || this.mesh.token !== this.savedMesh.token
      || this.mesh.channels.join(",") !== this.savedMesh.channels.join(",");
  }

  private get rowCount(): number {
    return MESH_FIELDS.length + this.paths.length;
  }

  handleInput(data: string): void {
    if (this.editing) {
      this.handleEditInput(data);
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.persist();
      this.done();
      return;
    }

    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.cursor = Math.min(Math.max(0, this.rowCount - 1), this.cursor + 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "e")) {
      if (this.cursor < MESH_FIELDS.length) {
        const field = MESH_FIELDS[this.cursor];
        this.editing = field;
        this.editBuffer = field === "channels" ? this.mesh.channels.join(",") : this.mesh[field];
        this.statusMessage = "";
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "s")) {
      this.persist();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "a")) {
      this.addCurrentPath();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "d") || matchesKey(data, "backspace")) {
      if (this.cursor >= MESH_FIELDS.length) {
        this.deleteSelectedPath();
      } else {
        const field = MESH_FIELDS[this.cursor];
        if (field === "channels") {
          this.mesh.channels = ["main"];
        } else {
          this.mesh[field] = "";
        }
        this.statusMessage = `Cleared ${FIELD_LABELS[field]}`;
      }
      this.tui.requestRender();
      return;
    }
  }

  private handleEditInput(data: string): void {
    const field = this.editing!;
    if (matchesKey(data, "escape")) {
      this.editing = null;
      this.statusMessage = "Edit cancelled";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      const value = this.editBuffer.trim();
      if (field === "channels") {
        const names = value.split(",").map(name => name.trim()).filter(name => name.length > 0);
        const invalid = names.find(name => !isValidChannelName(name));
        if (invalid) {
          this.statusMessage = `Invalid channel: ${invalid}`;
          this.tui.requestRender();
          return;
        }
        this.mesh.channels = normalizeChannels(names);
      } else {
        if (field === "url" && value && !/^wss?:\/\//.test(value)) {
          this.statusMessage = "URL must start with ws:// or wss://";
          this.tui.requestRender();
          return;
        }
        this.mesh[field] = value;
      }
      this.editing = null;
      this.statusMessage = `${FIELD_LABELS[field]} updated — s to save`;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.editBuffer = this.editBuffer.slice(0, -1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.editBuffer = "";
      this.tui.requestRender();
      return;
    }
    // Printable input only (ignore other control sequences)
    if (data.length >= 1 && !/[\x00-\x1f\x7f]/.test(data) && !data.startsWith("\x1b")) {
      this.editBuffer += data;
      this.tui.requestRender();
    }
  }

  /** Write whatever changed; mesh changes are handed to the host for reconnect. */
  private persist(): void {
    let saved: string[] = [];
    if (this.pathsDirty) {
      saveAutoRegisterPaths(this.paths);
      this.pathsDirty = false;
      saved.push("paths");
    }
    if (this.meshDirty) {
      saveMeshSettings(this.mesh);
      this.savedMesh = { ...this.mesh, channels: [...this.mesh.channels] };
      saved.push("mesh");
      this.callbacks.onMeshSettingsSaved?.({ ...this.mesh });
    }
    this.statusMessage = saved.length > 0
      ? `Saved ${saved.join(" + ")}${saved.includes("mesh") ? " — reconnecting" : ""}`
      : "Nothing to save";
  }

  private addCurrentPath(): void {
    if (this.paths.includes(this.cwd)) {
      this.statusMessage = "Already in list";
      return;
    }
    this.paths.push(this.cwd);
    this.cursor = MESH_FIELDS.length + this.paths.length - 1;
    this.pathsDirty = true;
    this.statusMessage = "Added current folder";
  }

  private deleteSelectedPath(): void {
    const index = this.cursor - MESH_FIELDS.length;
    if (index < 0 || index >= this.paths.length) return;
    const removed = this.paths[index];
    this.paths.splice(index, 1);
    this.cursor = Math.min(this.cursor, Math.max(0, this.rowCount - 1));
    this.pathsDirty = true;
    this.statusMessage = `Removed: ${removed.split("/").pop()}`;
  }

  private fieldDisplay(field: MeshField, innerW: number): string {
    if (this.editing === field) {
      const shown = field === "token" ? "•".repeat(this.editBuffer.length) : this.editBuffer;
      return this.theme.fg("accent", truncateToWidth(shown, innerW - 20) + "▏");
    }
    if (field === "channels") {
      return truncateToWidth(this.mesh.channels.join(","), innerW - 20);
    }
    const value = this.mesh[field];
    if (!value) {
      return this.theme.fg("dim", field === "url" ? "(local filesystem mesh)" : "(none)");
    }
    if (field === "token") return this.theme.fg("dim", "•".repeat(Math.min(12, value.length)) + ` (${value.length} chars)`);
    return truncateToWidth(value, innerW - 20);
  }

  render(_width: number): string[] {
    const w = this.width;
    const innerW = w - 2;
    const lines: string[] = [];
    const isCurrentInList = matchesAutoRegisterPath(this.cwd, this.paths);

    const border = (s: string) => this.theme.fg("dim", s);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");
    const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");
    const divider = () => border("├" + "─".repeat(innerW) + "┤");

    const titleText = " Messenger Config ";
    const borderLen = innerW - titleText.length;
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(border("╭" + "─".repeat(leftBorder)) + this.theme.fg("accent", titleText) + border("─".repeat(rightBorder) + "╮"));

    lines.push(emptyRow());
    const mode = this.mesh.url ? `server ${this.mesh.url}` : "local filesystem";
    lines.push(row(`${this.theme.fg("dim", "Mesh:")} ${mode}${this.meshDirty ? this.theme.fg("warning", "  (unsaved)") : ""}`));
    lines.push(emptyRow());

    for (let i = 0; i < MESH_FIELDS.length; i++) {
      const field = MESH_FIELDS[i];
      const selected = this.cursor === i;
      const marker = selected ? this.theme.fg("accent", "▸") : " ";
      const label = pad(FIELD_LABELS[field], 11);
      lines.push(row(`${marker} ${selected ? this.theme.fg("accent", label) : label} ${this.fieldDisplay(field, innerW)}`));
      if (selected) {
        lines.push(row(this.theme.fg("dim", `    ${FIELD_HINTS[field]}`)));
      }
    }

    lines.push(emptyRow());
    lines.push(divider());
    lines.push(emptyRow());

    const cwdDisplay = truncateToWidth(this.cwd, Math.max(10, innerW - 20));
    lines.push(row(`Current folder: ${cwdDisplay}`));
    lines.push(row(`Auto-register: ${this.theme.fg(isCurrentInList ? "accent" : "dim", isCurrentInList ? "YES" : "NO")}`));
    lines.push(emptyRow());
    lines.push(row(this.theme.fg("dim", "Auto-register paths:")));

    if (this.paths.length === 0) {
      lines.push(row(this.theme.fg("dim", "  (none configured)")));
    } else {
      for (let i = 0; i < this.paths.length; i++) {
        const path = this.paths[i];
        const selected = this.cursor === MESH_FIELDS.length + i;
        const marker = selected ? this.theme.fg("accent", "▸") : " ";
        const suffix = path === this.cwd ? this.theme.fg("dim", " (current)") : "";
        const pathDisplay = truncateToWidth(path, Math.max(10, innerW - 15));
        lines.push(row(`${marker} ${selected ? this.theme.fg("accent", pathDisplay) : pathDisplay}${suffix}`));
      }
    }

    lines.push(emptyRow());
    lines.push(divider());
    lines.push(emptyRow());

    lines.push(this.statusMessage ? row(this.theme.fg("accent", this.statusMessage)) : emptyRow());

    const help = this.editing
      ? "type  Enter apply  Esc cancel  ^U clear"
      : "Enter edit  d clear  a add dir  s save  ↑↓  Esc close";
    lines.push(row(this.theme.fg("dim", help)));
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));

    return lines;
  }

  invalidate(): void {
    this.statusMessage = "";
  }

  dispose(): void {}
}
