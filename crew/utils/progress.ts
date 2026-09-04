/** Crew progress shown while an in-process subagent runs. */

export interface ToolEntry {
  tool: string;
  args: string;
  startMs: number;
  endMs: number;
}

export interface AgentProgress {
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartMs?: number;
  recentTools: ToolEntry[];
  toolCallCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
}

export function createProgress(agent: string): AgentProgress {
  return {
    agent,
    status: "pending",
    recentTools: [],
    toolCallCount: 0,
    tokens: 0,
    durationMs: 0,
  };
}
