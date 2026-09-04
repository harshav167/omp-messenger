/**
 * Pi Messenger - Configuration
 * 
 * Priority (highest to lowest):
 * 1. Project: .omp/omp-messenger.json
 * 2. Extension-specific: ~/.omp/agent/omp-messenger.json
 * 3. Main settings: ~/.omp/agent/settings.json → "messenger" key
 * 4. Defaults
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidChannelName } from "./lib.ts";

export interface MeshConfig {
  /** ws:// or wss:// URL of a pi-messenger-mesh server; null → filesystem mesh. */
  url: string | null;
  /** Shared secret sent in the hello frame. */
  token: string;
  /** Channel joined by default (explicit `join { channel }` wins). */
  channel: string;
}

export interface MessengerConfig {
  autoRegister: boolean;
  autoRegisterPaths: string[];
  scopeToFolder: boolean;
  contextMode: "full" | "minimal" | "none";
  registrationContext: boolean;
  replyHint: boolean;
  senderDetailsOnFirstContact: boolean;
  nameTheme: string;
  nameWords?: { adjectives: string[]; nouns: string[] };
  feedRetention: number;
  stuckThreshold: number;
  stuckNotify: boolean;
  stuckWakeAgent: string | null;
  autoStatus: boolean;
  autoOverlay: boolean;
  autoOverlayPlanning: boolean;
  crewEventsInFeed: boolean;
  mesh: MeshConfig;
}

const DEFAULT_CONFIG: MessengerConfig = {
  autoRegister: false,
  autoRegisterPaths: [],
  scopeToFolder: false,
  contextMode: "full",
  registrationContext: true,
  replyHint: true,
  senderDetailsOnFirstContact: true,
  nameTheme: "default",
  feedRetention: 50,
  stuckThreshold: 900,
  stuckNotify: true,
  stuckWakeAgent: null,
  autoStatus: true,
  autoOverlay: true,
  autoOverlayPlanning: true,
  crewEventsInFeed: true,
  mesh: { url: null, token: "", channel: "main" },
};

/**
 * Env wins over file config. `token` may be `$NAME` (env indirection); an empty
 * token falls back to `~/.omp/agent/messenger/mesh.token`.
 */
function resolveMeshConfig(raw: unknown): MeshConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const fileUrl = typeof obj.url === "string" && obj.url.length > 0 ? obj.url : null;
  const url = process.env.OMP_MESSENGER_MESH_URL || fileUrl;

  let token = process.env.OMP_MESSENGER_MESH_TOKEN || (typeof obj.token === "string" ? obj.token : "");
  if (token.startsWith("$")) {
    token = process.env[token.slice(1)] ?? "";
  }
  if (!token) {
    const tokenFile = join(homedir(), ".omp", "agent", "messenger", "mesh.token");
    if (existsSync(tokenFile)) {
      try {
        token = readFileSync(tokenFile, "utf-8").trim();
      } catch {
        token = "";
      }
    }
  }

  const channel = isValidChannelName(obj.channel) ? obj.channel : "main";
  return { url, token, channel };
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function matchesAutoRegisterPath(cwd: string, paths: string[]): boolean {
  const normalizedCwd = cwd.replace(/\/+$/, ""); // Remove trailing slashes
  
  for (const pattern of paths) {
    const expanded = expandHome(pattern).replace(/\/+$/, "");
    
    // Simple glob support: trailing /* matches any subdirectory
    if (expanded.endsWith("/*")) {
      const base = expanded.slice(0, -2);
      if (normalizedCwd === base || normalizedCwd.startsWith(base + "/")) {
        return true;
      }
    } else if (expanded.endsWith("*")) {
      // Prefix match: /path/prefix* matches /path/prefix-anything
      const prefix = expanded.slice(0, -1);
      if (normalizedCwd.startsWith(prefix)) {
        return true;
      }
    } else {
      // Exact match
      if (normalizedCwd === expanded) {
        return true;
      }
    }
  }
  
  return false;
}

export function saveAutoRegisterPaths(paths: string[]): void {
  const configPath = join(homedir(), ".omp", "agent", "omp-messenger.json");
  let existing: Record<string, unknown> = {};
  
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Start fresh if malformed
    }
  }
  
  existing.autoRegisterPaths = paths;
  
  const dir = join(homedir(), ".omp", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2));
}

export function getAutoRegisterPaths(): string[] {
  const configPath = join(homedir(), ".omp", "agent", "omp-messenger.json");
  if (!existsSync(configPath)) return [];
  
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return Array.isArray(config.autoRegisterPaths) ? config.autoRegisterPaths : [];
  } catch {
    return [];
  }
}

function buildConfig(projectConfig?: Partial<MessengerConfig> | null): MessengerConfig {
  const extensionGlobalPath = join(homedir(), ".omp", "agent", "omp-messenger.json");
  const mainSettingsPath = join(homedir(), ".omp", "agent", "settings.json");

  // Load from main settings.json (lowest priority of the three sources)
  let settingsConfig: Partial<MessengerConfig> = {};
  const mainSettings = readJsonFile(mainSettingsPath);
  if (mainSettings && typeof mainSettings.messenger === "object" && mainSettings.messenger !== null) {
    settingsConfig = mainSettings.messenger as Partial<MessengerConfig>;
  }

  // Load extension-specific global config
  const extensionConfig = readJsonFile(extensionGlobalPath) as Partial<MessengerConfig> | null;

  const merged = { 
    ...DEFAULT_CONFIG, 
    ...settingsConfig,
    ...(extensionConfig ?? {}), 
    ...(projectConfig ?? {}) 
  };

  const nameWords = (merged as Record<string, unknown>).nameWords as { adjectives: string[]; nouns: string[] } | undefined;

  const sharedFields = {
    nameTheme: typeof merged.nameTheme === "string" ? merged.nameTheme : DEFAULT_CONFIG.nameTheme,
    nameWords: nameWords && Array.isArray(nameWords.adjectives) && Array.isArray(nameWords.nouns) ? nameWords : undefined,
    feedRetention: typeof merged.feedRetention === "number" ? merged.feedRetention : DEFAULT_CONFIG.feedRetention,
    stuckThreshold: typeof merged.stuckThreshold === "number" ? merged.stuckThreshold : DEFAULT_CONFIG.stuckThreshold,
    stuckNotify: merged.stuckNotify !== false,
    stuckWakeAgent:
      typeof merged.stuckWakeAgent === "string" && merged.stuckWakeAgent.length > 0
        ? merged.stuckWakeAgent
        : null,
    autoStatus: merged.autoStatus !== false,
    autoOverlay: merged.autoOverlay !== false,
    autoOverlayPlanning: merged.autoOverlayPlanning !== false,
    crewEventsInFeed: merged.crewEventsInFeed !== false,
    mesh: resolveMeshConfig((merged as Record<string, unknown>).mesh),
  };

  if (merged.contextMode === "none") {
    return {
      autoRegister: merged.autoRegister === true,
      autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
      scopeToFolder: merged.scopeToFolder === true,
      contextMode: "none",
      registrationContext: false,
      replyHint: false,
      senderDetailsOnFirstContact: false,
      ...sharedFields,
    };
  }

  if (merged.contextMode === "minimal") {
    return {
      autoRegister: merged.autoRegister === true,
      autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
      scopeToFolder: merged.scopeToFolder === true,
      contextMode: "minimal",
      registrationContext: false,
      replyHint: true,
      senderDetailsOnFirstContact: false,
      ...sharedFields,
    };
  }

  return {
    autoRegister: merged.autoRegister === true,
    autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
    scopeToFolder: merged.scopeToFolder === true,
    contextMode: "full",
    registrationContext: merged.registrationContext !== false,
    replyHint: merged.replyHint !== false,
    senderDetailsOnFirstContact: merged.senderDetailsOnFirstContact !== false,
    ...sharedFields,
  };
}

export function loadGlobalConfig(): MessengerConfig {
  return buildConfig();
}

export function loadConfig(cwd: string): MessengerConfig {
  const projectPath = join(cwd, ".omp", "omp-messenger.json");
  const projectConfig = readJsonFile(projectPath) as Partial<MessengerConfig> | null;
  return buildConfig(projectConfig);
}
