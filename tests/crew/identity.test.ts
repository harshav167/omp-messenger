import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { detectCrewIdentity } from "../../crew/identity.ts";

function context(cwd: string, sessionFile: string | undefined): Pick<ExtensionContext, "cwd" | "sessionManager"> {
  return {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
    } as ExtensionContext["sessionManager"],
  };
}

describe("crew worker identity", () => {
  const cwd = path.join("/tmp", "crew-identity-project");

  it("derives the worker name from an artifact transcript", () => {
    const sessionFile = path.join(cwd, ".pi", "messenger", "crew", "artifacts", "OakBear.jsonl");

    expect(detectCrewIdentity(context(cwd, sessionFile))).toEqual({ name: "OakBear" });
  });

  it("ignores a session transcript outside the crew artifacts directory", () => {
    expect(detectCrewIdentity(context(cwd, path.join(cwd, ".pi", "sessions", "OakBear.jsonl")))).toBeNull();
  });

  it("ignores sessions without a transcript path", () => {
    expect(detectCrewIdentity(context(cwd, undefined))).toBeNull();
  });
});
