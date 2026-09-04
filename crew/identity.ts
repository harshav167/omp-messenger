/**
 * Crew - Worker identity
 *
 * In-process crew workers are omp subagent sessions whose session file lives at
 * `<cwd>/.omp/messenger/crew/artifacts/<name>.jsonl`. The extension instance bound
 * to such a session derives its mesh name from that path; no environment
 * variables are involved (they would be process-wide).
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { basename, dirname, join, resolve } from "node:path";
import { getCrewDir } from "./store.ts";

export interface CrewIdentity {
  name: string;
}

export function detectCrewIdentity(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): CrewIdentity | null {
  const file = ctx.sessionManager.getSessionFile?.();
  if (!file || !file.endsWith(".jsonl")) return null;
  const artifacts = resolve(join(getCrewDir(ctx.cwd), "artifacts"));
  if (dirname(resolve(file)) !== artifacts) return null;
  const name = basename(file, ".jsonl");
  return name ? { name } : null;
}
