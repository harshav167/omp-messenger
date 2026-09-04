import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProgress as SdkProgress, SingleResult as SdkSingleResult } from "@oh-my-pi/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { spawnAgents } from "../../crew/agents.ts";
import { setSdk } from "../../crew/sdk.ts";
import type { Sdk } from "../../crew/sdk.ts";
import { createFakeSdk } from "../helpers/sdk.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a test worker.
`);
}

function sdkProgress(id: string, retryFailure?: SdkProgress["retryFailure"]): SdkProgress {
  return {
    index: 0,
    id,
    agent: "crew-worker",
    agentSource: "user",
    status: "running",
    task: "Implement task",
    currentTool: "edit",
    currentToolArgs: "a.ts",
    currentToolStartMs: 1,
    recentTools: [{ tool: "edit", args: "a.ts", endMs: 1 }],
    recentOutput: [],
    toolCount: 1,
    requests: 1,
    tokens: 120,
    cost: 0,
    durationMs: 5,
    retryFailure,
  };
}

function sdkResult(options: Parameters<Sdk["runSubprocess"]>[0]): SdkSingleResult {
  return {
    index: options.index,
    id: options.id,
    agent: options.agent.name,
    agentSource: "user",
    task: options.task,
    exitCode: 0,
    output: "done",
    stderr: "",
    truncated: false,
    durationMs: 9,
    tokens: 120,
    requests: 1,
    outputPath: path.join(options.artifactsDir ?? "", `${options.id}.md`),
  };
}

describe("crew SDK agent execution", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    writeWorkerAgent(dirs.cwd);
  });

  it("maps SDK progress and artifacts into the crew result", async () => {
    const fake = createFakeSdk();
    fake.runSubprocess.mockImplementation(async options => {
      options.onProgress?.(sdkProgress(options.id));
      return sdkResult(options);
    });
    setSdk(fake.sdk);

    const [result] = await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    const invocation = fake.runSubprocess.mock.calls[0]?.[0];
    expect(result?.exitCode).toBe(0);
    expect(result?.output).toBe("done");
    expect(result?.progress.tokens).toBe(120);
    expect(result?.artifactPaths?.transcript).toBe(path.join(dirs.crewDir, "artifacts", `${invocation?.id}.jsonl`));
    expect(invocation?.enableIrc).toBe(false);
    expect(invocation?.keepAlive).toBe(false);
    expect(invocation?.preloadedExtensionPaths?.[0]).toMatch(/\/index\.ts$/);
  });

  it("aborts after a terminal retry failure and preserves its error", async () => {
    const fake = createFakeSdk();
    fake.runSubprocess.mockImplementation(async options => {
      const retryFailure = { attempt: 3, errorMessage: "quota" };
      options.onProgress?.(sdkProgress(options.id, retryFailure));
      return {
        ...sdkResult(options),
        exitCode: 1,
        aborted: true,
        retryFailure,
      };
    });
    setSdk(fake.sdk);

    const [result] = await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    const invocation = fake.runSubprocess.mock.calls[0]?.[0];
    expect(invocation?.signal?.aborted).toBe(true);
    expect(result?.exitCode).toBe(143);
    expect(result?.error).toBe("quota");
  });
});
