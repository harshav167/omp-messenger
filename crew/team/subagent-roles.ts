/** Discovers omp task-agent roles from the user and project agent directories. */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { TeamRoleDefinition } from "./types.ts";
import { canonicalPackagedTeamRole, isValidTeamName } from "../utils/team-roles.ts";

export interface DiscoverSubagentRoleOptions {
  homeDir?: string;
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out.sort();
}

function splitList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(v => v.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  }
  return trimmed.split(",").map(v => v.trim()).filter(Boolean);
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: content };
  const raw = normalized.slice(4, end);
  const data: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (key) data[key] = value;
  }
  const bodyStart = normalized.indexOf("\n", end + 4);
  return { data, body: bodyStart === -1 ? "" : normalized.slice(bodyStart + 1).trim() };
}

function readRoleFile(filePath: string, sourceLabel: string): TeamRoleDefinition | null {
  const content = fs.readFileSync(filePath, "utf-8");
  const { data, body } = parseFrontmatter(content);
  const rawName = data.name || path.basename(filePath, ".md");
  if (!isValidTeamName(rawName)) return null;
  const name = canonicalPackagedTeamRole(rawName) ?? rawName;

  return {
    name,
    ...(data.description ? { description: data.description } : {}),
    ...(data.model ? { model: data.model } : {}),
    ...(data.thinking ? { thinking: data.thinking } : {}),
    ...(data.skills ? { skills: splitList(data.skills) } : {}),
    ...(body ? { prompt: body.slice(0, 4000) } : {}),
    promptSource: `${sourceLabel}:${name}`,
  };
}

export function discoverSubagentRoles(cwd: string, options?: DiscoverSubagentRoleOptions): Record<string, TeamRoleDefinition> {
  const home = options?.homeDir ?? homedir();
  const sources = [
    { dir: path.join(home, ".omp", "agent", "agents"), label: "subagent:user" },
    { dir: path.join(cwd, ".omp", "agents"), label: "subagent:project" },
  ];

  const roles: Record<string, TeamRoleDefinition> = {};
  for (const source of sources) {
    for (const file of listMarkdownFiles(source.dir)) {
      const role = readRoleFile(file, source.label);
      if (role) roles[role.name] = { ...roles[role.name], ...role };
    }
  }
  return roles;
}
