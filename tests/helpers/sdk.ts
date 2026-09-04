import { vi } from "vitest";
import type { Sdk } from "../../crew/sdk.ts";

export function createFakeSdk() {
  const registry = new Map<string, { status: "running" | "idle" | "parked" | "aborted" }>();
  const runSubprocess = vi.fn(async (options: Parameters<Sdk["runSubprocess"]>[0]) => {
    registry.set(options.id, { status: "running" });
    const result = {
      index: options.index,
      id: options.id,
      agent: options.agent.name,
      agentSource: "user" as const,
      task: options.task,
      exitCode: 0,
      output: "",
      stderr: "",
      truncated: false,
      durationMs: 1,
      tokens: 0,
      requests: 1,
    };
    if (options.keepAlive) registry.set(options.id, { status: "idle" });
    else registry.delete(options.id);
    return result;
  });
  const runSubagentFollowUpTurn = vi.fn(async (options: Parameters<Sdk["runSubagentFollowUpTurn"]>[0]) => ({
    index: 0,
    id: options.id,
    agent: options.agent.name,
    agentSource: "user" as const,
    task: options.message,
    exitCode: 0,
    output: "",
    stderr: "",
    truncated: false,
    durationMs: 1,
    tokens: 0,
    requests: 1,
  }));
  const sdk = {
    runSubprocess,
    runSubagentFollowUpTurn,
    AgentRegistry: {
      global: () => ({
        get: (id: string) => registry.get(id),
        list: () => [...registry.values()],
      }),
    },
    MAIN_AGENT_ID: "Main",
  } as unknown as Sdk;

  return { sdk, registry, runSubprocess, runSubagentFollowUpTurn };
}
