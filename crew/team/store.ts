import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { Task } from "../types.ts";
import { getTasks } from "../store.ts";
import { discoverSubagentRoles } from "./subagent-roles.ts";
import { normalizeRiskLabels } from "../utils/risk-labels.ts";
import { isTeamEnabled } from "../utils/config.ts";
import { canonicalPackagedTeamRole, isNonEditingTeamRole, isValidTeamName } from "../utils/team-roles.ts";
import { TEAM_MEMORY_TYPES, type TeamMemoryEntry, type TeamMemoryType, type TeamProfile, type TeamPromptContext, type TeamRoleDefinition, type TeamState } from "./types.ts";

const DEFAULT_APPROVAL_LABELS = ["security", "database", "api-contract", "destructive", "migration", "auth", "payment"];
const MEMORY_FILES: Record<TeamMemoryType, string> = {
  decision: "decisions.md",
  interface: "interfaces.md",
  risk: "risks.md",
  handoff: "handoffs.md",
};

const BUILTIN_ROLES: Record<string, TeamRoleDefinition> = {
  "context-builder": { name: "context-builder", description: "Analyzes requirements and codebase, generates context and meta-prompt", thinking: "medium", skills: [] },
  delegate: { name: "delegate", description: "Lightweight subagent that inherits the parent model with no default reads", skills: [] },
  oracle: { name: "oracle", description: "High-context decision-consistency oracle that protects inherited state and prevents drift", thinking: "high", skills: [] },
  planner: { name: "planner", description: "Creates implementation plans from context and requirements", thinking: "high", skills: [] },
  researcher: { name: "researcher", description: "Autonomous web researcher — searches, evaluates, and synthesizes a focused research brief", thinking: "medium", skills: [] },
  reviewer: { name: "reviewer", description: "Versatile review specialist for code diffs, plans, proposed solutions, codebase health, and PR/issue validation", thinking: "high", skills: [] },
  scout: { name: "scout", description: "Fast codebase recon that returns compressed context for handoff", thinking: "low", skills: [] },
  worker: { name: "worker", description: "Implementation agent for normal tasks and approved oracle handoffs", thinking: "high", skills: [] },
};

const SAMPLE_PROFILES: Record<string, TeamProfile> = {
  "migration-squad": {
    name: "migration-squad",
    description: "Scout, implement, and review high-risk migrations with lead approval gates",
    roles: {
      scout: { description: "Map affected schemas, APIs, and rollback paths before implementation" },
      worker: {
        description: "Implement the approved migration in small, reversible steps",
        prompt: "Before editing, confirm the migration plan, rollback path, and affected interfaces are clear. Keep changes narrow and record risky decisions in Team memory.",
      },
      reviewer: { description: "Review migration safety, compatibility, rollback, and tests" },
      oracle: { description: "Resolve ambiguous migration strategy or data-safety questions" },
    },
    approval: { mode: "risk-labels", labels: ["database", "migration", "destructive", "api-contract", "auth", "payment"] },
    memory: { inject: ["decision", "interface", "risk", "handoff"], maxCharsPerType: 4000 },
  },
  "review-squad": {
    name: "review-squad",
    description: "Review and safely polish a change before handoff",
    roles: {
      scout: { description: "Inspect the changed surface and summarize relevant local patterns" },
      reviewer: { description: "Check correctness, integration risks, and missing tests" },
      worker: { description: "Apply approved simplification or polish edits while preserving behavior" },
      oracle: { description: "Resolve ambiguous review findings or tradeoffs before edits" },
    },
    approval: { mode: "risk-labels", labels: ["security", "auth", "payment", "destructive"] },
    memory: { inject: ["decision", "risk", "handoff"], maxCharsPerType: 3000 },
  },
  "research-squad": {
    name: "research-squad",
    description: "Research uncertain areas before planning or implementation",
    roles: {
      researcher: { description: "Gather external references and summarize tradeoffs" },
      scout: { description: "Map the local codebase and existing decisions" },
      planner: { description: "Convert research into dependency-aware Crew tasks" },
      reviewer: { description: "Check that the plan follows the research and project constraints" },
    },
    approval: { mode: "off" },
    memory: { inject: ["decision", "interface", "handoff"], maxCharsPerType: 5000 },
  },
};

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    throw new Error(`Failed to read Team JSON at ${filePath}`, { cause: error });
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
}

function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, filePath);
}

export function getTeamDir(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "team");
}

export function getProfileDir(homeDir = homedir()): string {
  if (homeDir === homedir() && process.env.PI_MESSENGER_TEAM_PROFILE_DIR) return process.env.PI_MESSENGER_TEAM_PROFILE_DIR;
  return path.join(homeDir, ".pi", "agent", "messenger", "team-profiles");
}

function teamPath(cwd: string, file: string): string {
  return path.join(getTeamDir(cwd), file);
}

export function isValidProfileName(name: string): boolean {
  return isValidTeamName(name);
}

function profilePath(name: string, homeDir?: string): string {
  if (!isValidProfileName(name)) throw new Error(`Invalid team profile name: ${name}`);
  return path.join(getProfileDir(homeDir), `${name}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTeamMemoryType(value: unknown): value is TeamMemoryType {
  return typeof value === "string" && TEAM_MEMORY_TYPES.includes(value as TeamMemoryType);
}

function normalizeProfile(raw: unknown, filePath: string, expectedName?: string): TeamProfile {
  if (!isRecord(raw) || typeof raw.name !== "string" || !isValidProfileName(raw.name)) {
    throw new Error(`Invalid Team profile JSON at ${filePath}: profile name must be filename-safe`);
  }
  if (expectedName && raw.name !== expectedName) {
    throw new Error(`Invalid Team profile JSON at ${filePath}: profile name must match file name`);
  }

  const profile: TeamProfile = { name: raw.name };
  if (typeof raw.description === "string") profile.description = raw.description;

  if (raw.roles !== undefined) {
    if (!isRecord(raw.roles)) throw new Error(`Invalid Team profile JSON at ${filePath}: roles must be an object`);
    const roles: Record<string, Partial<TeamRoleDefinition>> = {};
    for (const [name, value] of Object.entries(raw.roles)) {
      const roleName = canonicalPackagedTeamRole(name) ?? name;
      if (!isValidProfileName(name) || !isRecord(value)) {
        throw new Error(`Invalid Team profile JSON at ${filePath}: role ${name} must be an object with a filename-safe name`);
      }
      if (value.skills !== undefined && !Array.isArray(value.skills)) {
        throw new Error(`Invalid Team profile JSON at ${filePath}: role ${name}.skills must be an array`);
      }
      roles[roleName] = {
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        ...(typeof value.model === "string" ? { model: value.model } : {}),
        ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
        ...(Array.isArray(value.skills) ? { skills: value.skills.filter((skill): skill is string => typeof skill === "string") } : {}),
        ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
        ...(typeof value.promptSource === "string" ? { promptSource: value.promptSource } : {}),
      };
    }
    profile.roles = roles;
  }

  if (raw.approval !== undefined) {
    if (!isRecord(raw.approval)) throw new Error(`Invalid Team profile JSON at ${filePath}: approval must be an object`);
    const mode = raw.approval.mode ?? "risk-labels";
    if (mode !== "off" && mode !== "risk-labels") throw new Error(`Invalid Team profile JSON at ${filePath}: approval.mode is invalid`);
    if (raw.approval.labels !== undefined && !Array.isArray(raw.approval.labels)) {
      throw new Error(`Invalid Team profile JSON at ${filePath}: approval.labels must be an array`);
    }
    if (Array.isArray(raw.approval.labels)) {
      for (const label of raw.approval.labels) {
        if (typeof label !== "string" || label.trim().length === 0) {
          throw new Error(`Invalid Team profile JSON at ${filePath}: approval.labels entries must be non-empty strings`);
        }
      }
    }
    profile.approval = {
      mode,
      ...(Array.isArray(raw.approval.labels) ? { labels: normalizeRiskLabels(raw.approval.labels) } : {}),
    };
  }

  if (raw.memory !== undefined) {
    if (!isRecord(raw.memory)) throw new Error(`Invalid Team profile JSON at ${filePath}: memory must be an object`);
    if (raw.memory.inject !== undefined && !Array.isArray(raw.memory.inject)) {
      throw new Error(`Invalid Team profile JSON at ${filePath}: memory.inject must be an array`);
    }
    if (Array.isArray(raw.memory.inject)) {
      for (const type of raw.memory.inject) {
        if (!isTeamMemoryType(type)) {
          throw new Error(`Invalid Team profile JSON at ${filePath}: memory.inject entries must be one of ${TEAM_MEMORY_TYPES.join(", ")}`);
        }
      }
    }
    profile.memory = {
      ...(Array.isArray(raw.memory.inject) ? { inject: raw.memory.inject } : {}),
      ...(typeof raw.memory.maxCharsPerType === "number" && Number.isFinite(raw.memory.maxCharsPerType) ? { maxCharsPerType: raw.memory.maxCharsPerType } : {}),
    };
  }

  return profile;
}

function readProfileFile(filePath: string, expectedName?: string): TeamProfile | null {
  const raw = readJson<unknown>(filePath);
  return raw === null ? null : normalizeProfile(raw, filePath, expectedName);
}

export function sampleTeamProfile(name: string): TeamProfile | null {
  const profile = SAMPLE_PROFILES[name];
  return profile ? structuredClone(profile) : null;
}

export function defaultTeamProfile(name: string): TeamProfile {
  if (!isValidProfileName(name)) throw new Error(`Invalid team profile name: ${name}`);
  return {
    name,
    description: `Team profile ${name}`,
    roles: {
      scout: {},
      worker: {},
      reviewer: {},
      oracle: {},
    },
    approval: { mode: "risk-labels", labels: DEFAULT_APPROVAL_LABELS },
    memory: { inject: ["decision", "interface", "risk"], maxCharsPerType: 4000 },
  };
}

export function getActiveTeam(cwd: string): TeamState | null {
  if (!isTeamEnabled(cwd)) return null;
  return readJson<TeamState>(teamPath(cwd, "team.json"));
}

export function setActiveTeam(cwd: string, name: string, profile?: string): TeamState {
  const now = new Date().toISOString();
  const existing = getActiveTeam(cwd);
  const state: TeamState = {
    name,
    ...(profile ? { profile } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  writeJson(teamPath(cwd, "team.json"), state);
  return state;
}

export function listProfiles(homeDir?: string): TeamProfile[] {
  const profiles = new Map<string, TeamProfile>();
  for (const profile of Object.values(SAMPLE_PROFILES)) profiles.set(profile.name, structuredClone(profile));

  const dir = getProfileDir(homeDir);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter(file => file.endsWith(".json")).sort()) {
      const name = path.basename(file, ".json");
      const profile = readProfileFile(path.join(dir, file), name);
      if (profile) profiles.set(profile.name, profile);
    }
  }

  return Array.from(profiles.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadProfile(name: string, homeDir?: string): TeamProfile | null {
  return readProfileFile(profilePath(name, homeDir), name) ?? sampleTeamProfile(name);
}

export function saveProfile(profile: TeamProfile, homeDir?: string): TeamProfile {
  writeJson(profilePath(profile.name, homeDir), profile);
  return profile;
}

export function useProfile(cwd: string, name: string, homeDir?: string): { team: TeamState; profile: TeamProfile; created: boolean } {
  if (!isValidProfileName(name)) throw new Error(`Invalid team profile name: ${name}`);
  let profile = readProfileFile(profilePath(name, homeDir), name);
  let created = false;
  if (!profile) {
    profile = sampleTeamProfile(name) ?? defaultTeamProfile(name);
    saveProfile(profile, homeDir);
    created = true;
  }
  const team = setActiveTeam(cwd, profile.name, profile.name);
  return { team, profile, created };
}

export function loadActiveProfile(cwd: string, homeDir?: string): TeamProfile | null {
  const team = getActiveTeam(cwd);
  if (!team?.profile) return null;
  return loadProfile(team.profile, homeDir);
}

export function readCharter(cwd: string): string | null {
  return readText(teamPath(cwd, "charter.md"));
}

export function writeCharter(cwd: string, teamName: string, message: string): string {
  const content = `# ${teamName} Charter\n\n${message.trim()}\n`;
  writeText(teamPath(cwd, "charter.md"), content);
  const active = getActiveTeam(cwd);
  setActiveTeam(cwd, teamName, active?.profile);
  return content;
}

export function updateCharter(cwd: string, message: string): string {
  const existing = readCharter(cwd);
  const team = getActiveTeam(cwd);
  const content = existing
    ? `${existing.trimEnd()}\n\n## Update ${new Date().toISOString()}\n\n${message.trim()}\n`
    : `# ${team?.name ?? "Team"} Charter\n\n${message.trim()}\n`;
  writeText(teamPath(cwd, "charter.md"), content);
  if (team) setActiveTeam(cwd, team.name, team.profile);
  return content;
}

function parseMemoryEntry(raw: unknown): TeamMemoryEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.ts !== "string") return null;
  if (typeof raw.agent !== "string") return null;
  if (typeof raw.message !== "string") return null;
  if (!isTeamMemoryType(raw.type)) return null;
  if (raw.taskId !== undefined && typeof raw.taskId !== "string") return null;
  const taskId = typeof raw.taskId === "string" ? raw.taskId : undefined;
  return {
    ts: raw.ts,
    agent: raw.agent,
    type: raw.type,
    message: raw.message,
    ...(taskId ? { taskId } : {}),
  };
}

export function noteMemory(cwd: string, type: TeamMemoryType, message: string, agent: string, taskId?: string): TeamMemoryEntry {
  const entry: TeamMemoryEntry = {
    ts: new Date().toISOString(),
    agent,
    type,
    message,
    ...(taskId ? { taskId } : {}),
  };
  ensureDir(getTeamDir(cwd));
  fs.appendFileSync(teamPath(cwd, "memory.jsonl"), `${JSON.stringify(entry)}\n`);
  fs.appendFileSync(teamPath(cwd, MEMORY_FILES[type]), `- ${entry.ts} (${agent}${taskId ? `, ${taskId}` : ""}): ${message}\n`);
  return entry;
}

export function listMemory(cwd: string, type?: TeamMemoryType, limit?: number): TeamMemoryEntry[] {
  const file = teamPath(cwd, "memory.jsonl");
  if (!fs.existsSync(file)) return [];
  const entries: TeamMemoryEntry[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = parseMemoryEntry(JSON.parse(line));
      if (parsed && (!type || parsed.type === type)) entries.push(parsed);
    } catch {
      // Keep valid memory usable even if a hand-edited JSONL line is malformed.
    }
  }
  return typeof limit === "number" && limit > 0 ? entries.slice(-limit) : entries;
}

export function memoryCounts(cwd: string): Record<TeamMemoryType, number> {
  const counts = Object.fromEntries(TEAM_MEMORY_TYPES.map(type => [type, 0])) as Record<TeamMemoryType, number>;
  for (const entry of listMemory(cwd)) counts[entry.type]++;
  return counts;
}

export function resolveRoles(cwd: string, options?: { homeDir?: string }): Record<string, TeamRoleDefinition> {
  if (!isTeamEnabled(cwd)) return {};
  const roles: Record<string, TeamRoleDefinition> = {};
  for (const [name, role] of Object.entries(BUILTIN_ROLES)) roles[name] = { ...role };

  const discovered = discoverSubagentRoles(cwd, { homeDir: options?.homeDir });
  for (const [name, role] of Object.entries(discovered)) {
    roles[name] = { ...(roles[name] ?? { name }), ...role, name };
  }

  const profile = loadActiveProfile(cwd, options?.homeDir);
  for (const [name, role] of Object.entries(profile?.roles ?? {})) {
    roles[name] = { ...(roles[name] ?? { name }), ...role, name };
  }

  return roles;
}

export { normalizeRiskLabels };

export function resolveRoleName(cwd: string, role: string | undefined): string | undefined {
  if (!isTeamEnabled(cwd)) return undefined;
  const trimmed = role?.trim();
  if (!trimmed) return undefined;

  const roles = resolveRoles(cwd);
  const packaged = canonicalPackagedTeamRole(trimmed);
  if (packaged && roles[packaged]) return packaged;
  if (roles[trimmed]) return trimmed;

  const lower = trimmed.toLowerCase();
  return Object.keys(roles).find(name => name.toLowerCase() === lower);
}

export function canonicalRoleForTask(cwd: string, role: string | undefined): string | undefined {
  const trimmed = role?.trim();
  if (!trimmed) return undefined;
  return resolveRoleName(cwd, trimmed) ?? (getActiveTeam(cwd) ? undefined : trimmed);
}

export function isNonEditingRole(cwd: string, role: string | undefined): boolean {
  return isNonEditingTeamRole(resolveRoleName(cwd, role) ?? role);
}

export function activeApprovalLabels(cwd: string): string[] {
  const profile = loadActiveProfile(cwd);
  if (!getActiveTeam(cwd)) return [];
  if (profile?.approval?.mode === "off") return [];
  return normalizeRiskLabels(profile?.approval?.labels ?? DEFAULT_APPROVAL_LABELS) ?? [];
}

export function approvalForTask(cwd: string, role: string | undefined, riskLabels: string[] | undefined): Task["approval"] | undefined {
  if (!isTeamEnabled(cwd)) return undefined;
  const labels = activeApprovalLabels(cwd);
  const taskLabels = normalizeRiskLabels(riskLabels);
  if (labels.length === 0 || !taskLabels || taskLabels.length === 0) return undefined;
  if (isNonEditingRole(cwd, role)) return undefined;
  const configured = new Set(labels);
  const matching = taskLabels.filter(label => configured.has(label));
  if (matching.length === 0) return undefined;
  return { required: true, status: "pending" };
}

export function taskNeedsApproval(cwd: string, task: Task): boolean {
  return isTeamEnabled(cwd) && task.approval?.required === true && task.approval.status !== "approved";
}

export function taskPendingApproval(cwd: string, task: Task): boolean {
  return isTeamEnabled(cwd) && task.approval?.required === true && task.approval.status === "pending";
}

export function taskNeedsRevision(cwd: string, task: Task): boolean {
  return isTeamEnabled(cwd) && task.approval?.required === true && task.approval.status === "rejected";
}

export function needsLeadTasks(cwd: string): Task[] {
  return getTasks(cwd).filter(task => taskPendingApproval(cwd, task));
}

export function rejectedTasks(cwd: string): Task[] {
  return getTasks(cwd).filter(task => taskNeedsRevision(cwd, task));
}

export function buildTeamPromptContext(cwd: string, task: Task): TeamPromptContext | undefined {
  const team = getActiveTeam(cwd);
  if (!team) return undefined;

  const profile = loadActiveProfile(cwd) ?? undefined;
  const roles = resolveRoles(cwd);
  const roleName = resolveRoleName(cwd, task.role);
  const role = roleName ? roles[roleName] : undefined;
  const charter = readCharter(cwd) ?? undefined;
  const inject = profile?.memory?.inject ?? ["decision", "interface", "risk"];
  const maxChars = profile?.memory?.maxCharsPerType ?? 4000;
  const memory: TeamPromptContext["memory"] = {};

  for (const type of inject) {
    const recent = listMemory(cwd, type, 20);
    const selected: TeamMemoryEntry[] = [];
    let used = 0;
    for (const entry of recent.reverse()) {
      const cost = entry.message.length + 80;
      if (selected.length > 0 && used + cost > maxChars) break;
      selected.unshift(entry);
      used += cost;
    }
    if (selected.length > 0) memory[type] = selected;
  }

  return { team, profile, role, charter, memory };
}
