import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  type AgentRegistration,
  LOCAL_HOST_ID,
  type MessengerState,
} from "../lib.ts";

export function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

export function getGitBranch(cwd: string): string | undefined {
  try {
    const result = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (result) return result;

    const sha = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return sha ? `@${sha}` : undefined;
  } catch {
    return undefined;
  }
}

export function buildRegistration(
  state: MessengerState,
  ctx: ExtensionContext,
  name: string,
): AgentRegistration {
  const cwd = normalizeCwd(ctx.cwd);
  const now = new Date().toISOString();

  return {
    name,
    pid: process.pid,
    hostId: LOCAL_HOST_ID,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd,
    model: ctx.model?.id ?? "unknown",
    startedAt: now,
    reservations: state.reservations.length > 0 ? state.reservations : undefined,
    gitBranch: getGitBranch(cwd),
    spec: state.spec,
    isHuman: state.isHuman,
    session: { ...state.session },
    activity: { lastActivityAt: now },
    statusMessage: state.statusMessage,
  };
}
