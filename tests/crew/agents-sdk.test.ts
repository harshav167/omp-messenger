import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentProgress as SdkProgress,
  SingleResult as SdkSingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { shutdownAllWorkers, spawnAgents } from "../../crew/agents.ts";
import { setSdk } from "../../crew/sdk.ts";
import { autonomousState } from "../../crew/state.ts";
import { findWorkerByTask } from "../../crew/registry.ts";
import { getLiveWorkers } from "../../crew/live-progress.ts";
import type { Sdk } from "../../crew/sdk.ts";
import { createFakeSdk } from "../helpers/sdk.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".omp", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a test worker.
`,
  );
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
    fake.runSubprocess.mockImplementation(async (options) => {
      options.onProgress?.(sdkProgress(options.id));
      return sdkResult(options);
    });
    setSdk(fake.sdk);

    const [result] = await spawnAgents(
      [
        {
          agent: "crew-worker",
          task: "Implement task",
          taskId: "task-1",
        },
      ],
      dirs.cwd,
    );

    const invocation = fake.runSubprocess.mock.calls[0]?.[0];
    expect(result?.exitCode).toBe(0);
    expect(result?.output).toBe("done");
    expect(result?.progress.tokens).toBe(120);
    expect(result?.artifactPaths?.transcript).toBe(
      path.join(dirs.crewDir, "artifacts", `${invocation?.id}.jsonl`),
    );
    expect(invocation?.enableIrc).toBe(false);
    expect(invocation?.keepAlive).toBe(false);
    expect(invocation?.preloadedExtensionPaths?.[0]).toMatch(/\/index\.ts$/);
  });

  it("passes the invoking agent identity to the SDK", async () => {
    const fake = createFakeSdk();
    fake.runSubprocess.mockImplementation(async (options) => sdkResult(options));
    setSdk(fake.sdk);
    await spawnAgents([{ agent: "crew-worker", task: "Implement task" }], dirs.cwd, {
      parentAgentId: "Main.Child",
    });
    expect(fake.runSubprocess.mock.calls[0]?.[0].parentAgentId).toBe("Main.Child");
  });

  it("aborts after a terminal retry failure and preserves its error", async () => {
    const fake = createFakeSdk();
    fake.runSubprocess.mockImplementation(async (options) => {
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

    const [result] = await spawnAgents(
      [
        {
          agent: "crew-worker",
          task: "Implement task",
          taskId: "task-1",
        },
      ],
      dirs.cwd,
    );

    const invocation = fake.runSubprocess.mock.calls[0]?.[0];
    expect(invocation?.signal?.aborted).toBe(true);
    expect(result?.exitCode).toBe(143);
    expect(result?.error).toBe("quota");
  });

  it("does not start queued agents after the owning session is aborted", async () => {
    const fake = createFakeSdk();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    fake.runSubprocess.mockImplementation(async (options) => {
      markStarted();
      const { promise, resolve } = Promise.withResolvers<SdkSingleResult>();
      const finish = (): void => {
        resolve({ ...sdkResult(options), exitCode: 143, aborted: true });
      };
      if (options.signal?.aborted) finish();
      else options.signal?.addEventListener("abort", finish, { once: true });
      return promise;
    });
    setSdk(fake.sdk);
    const owner = new AbortController();
    const previousConcurrency = autonomousState.concurrency;
    autonomousState.concurrency = 1;
    try {
      const running = spawnAgents(
        [
          { agent: "crew-worker", task: "First task", taskId: "task-1" },
          { agent: "crew-worker", task: "Queued task", taskId: "task-2" },
        ],
        dirs.cwd,
        { ownerSessionId: "session-a", ownerSignal: owner.signal },
      );
      await started;
      owner.abort();
      const results = await running;

      expect(fake.runSubprocess).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
      expect(results[0]?.progress.status).toBe("cancelled");
      expect(results[1]).toMatchObject({
        taskId: "task-2",
        exitCode: 143,
        wasGracefullyShutdown: true,
        progress: { status: "cancelled" },
      });
    } finally {
      autonomousState.concurrency = previousConcurrency;
    }
  });

  it("cleans up an owned agent that has no task id", async () => {
    const fake = createFakeSdk();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    fake.runSubprocess.mockImplementation(async (options) => {
      markStarted();
      const { promise, resolve } = Promise.withResolvers<SdkSingleResult>();
      const finish = (): void => {
        resolve({ ...sdkResult(options), exitCode: 143, aborted: true });
      };
      if (options.signal?.aborted) finish();
      else options.signal?.addEventListener("abort", finish, { once: true });
      return promise;
    });
    setSdk(fake.sdk);

    const running = spawnAgents(
      [{ agent: "crew-worker", task: "Review without a task id" }],
      dirs.cwd,
      { ownerSessionId: "session-a" },
    );
    await started;
    shutdownAllWorkers(dirs.cwd, "session-a");
    const [result] = await running;

    expect(fake.runSubprocess.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(result?.exitCode).toBe(143);
  });

  it("keeps replacement registry and progress entries when an old worker settles", async () => {
    const fake = createFakeSdk();
    const first = Promise.withResolvers<SdkSingleResult>();
    const second = Promise.withResolvers<SdkSingleResult>();
    const invocations: Array<Parameters<Sdk["runSubprocess"]>[0]> = [];
    fake.runSubprocess.mockImplementation((options) => {
      invocations.push(options);
      return invocations.length === 1 ? first.promise : second.promise;
    });
    setSdk(fake.sdk);

    const oldRun = spawnAgents(
      [{ agent: "crew-worker", task: "Old run", taskId: "task-1" }],
      dirs.cwd,
      { ownerSessionId: "old-session" },
    );
    const replacementRun = spawnAgents(
      [{ agent: "crew-worker", task: "Replacement run", taskId: "task-1" }],
      dirs.cwd,
      { ownerSessionId: "new-session" },
    );
    await Promise.resolve();
    const oldInvocation = invocations[0]!;
    const replacementInvocation = invocations[1]!;
    oldInvocation.onProgress?.(sdkProgress(oldInvocation.id));

    expect(getLiveWorkers(dirs.cwd).get("task-1")?.name).toBe(replacementInvocation.id);
    first.resolve({ ...sdkResult(oldInvocation), exitCode: 143, aborted: true });
    await oldRun;

    expect(findWorkerByTask(dirs.cwd, "task-1")?.name).toBe(replacementInvocation.id);
    expect(getLiveWorkers(dirs.cwd).get("task-1")?.name).toBe(replacementInvocation.id);

    second.resolve(sdkResult(replacementInvocation));
    await replacementRun;
    expect(findWorkerByTask(dirs.cwd, "task-1")).toBeNull();
    expect(getLiveWorkers(dirs.cwd).has("task-1")).toBe(false);
  });
});
