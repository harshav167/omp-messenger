import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveModel, spawnAgents } from "../../crew/agents.ts";
import { setSdk } from "../../crew/sdk.ts";
import { createFakeSdk } from "../helpers/sdk.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

function writeWorkerAgent(cwd: string, model?: string): void {
  const modelLine = model ? `model: ${model}\n` : "";
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
${modelLine}---
You are a test worker.
`);
}

function writeCrewConfig(cwd: string, model: string, thinking?: string): void {
  const configPath = path.join(cwd, ".pi", "messenger", "crew", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    models: { worker: model },
    ...(thinking ? { thinking: { worker: thinking } } : {}),
  }));
}

describe("crew/model override", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
  });

  it("resolveModel follows task, params, role, config, session, and agent priority", () => {
    expect(resolveModel("task", "params", "role", "config", "session", "agent")).toBe("task");
    expect(resolveModel(undefined, "params", "role", "config", "session", "agent")).toBe("params");
    expect(resolveModel(undefined, undefined, "role", "config", "session", "agent")).toBe("role");
    expect(resolveModel(undefined, undefined, undefined, "config", "session", "agent")).toBe("config");
    expect(resolveModel(undefined, undefined, undefined, undefined, "session", "agent")).toBe("session");
    expect(resolveModel(undefined, undefined, undefined, undefined, undefined, "agent")).toBe("agent");
    expect(resolveModel(undefined, undefined, undefined, undefined)).toBeUndefined();
  });

  it("passes a task model override instead of the configured role model", async () => {
    writeWorkerAgent(dirs.cwd, "agent-model");
    writeCrewConfig(dirs.cwd, "config-model");
    const fake = createFakeSdk();
    setSdk(fake.sdk);

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
      modelOverride: "task-model",
    }], dirs.cwd);

    expect(fake.runSubprocess.mock.calls[0]?.[0].modelOverride).toBe("task-model");
  });

  it("passes the configured role model when the task has no override", async () => {
    writeWorkerAgent(dirs.cwd, "agent-model");
    writeCrewConfig(dirs.cwd, "config-model");
    const fake = createFakeSdk();
    setSdk(fake.sdk);

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    expect(fake.runSubprocess.mock.calls[0]?.[0].modelOverride).toBe("config-model");
  });

  it("leaves modelOverride unset so the agent frontmatter model is used", async () => {
    writeWorkerAgent(dirs.cwd, "agent-model");
    const fake = createFakeSdk();
    setSdk(fake.sdk);

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    const invocation = fake.runSubprocess.mock.calls[0]?.[0];
    expect(invocation?.modelOverride).toBeUndefined();
    expect(invocation?.agent.model).toEqual(["agent-model"]);
  });

  it("does not duplicate a thinking level already encoded in the model", async () => {
    writeWorkerAgent(dirs.cwd, "agent-model:high");
    writeCrewConfig(dirs.cwd, "config-model:xhigh", "medium");
    const fake = createFakeSdk();
    setSdk(fake.sdk);

    await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    expect(fake.runSubprocess.mock.calls[0]?.[0].agent.thinkingLevel).toBeUndefined();
  });
});
