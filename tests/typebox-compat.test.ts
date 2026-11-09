import { describe, expect, it, vi } from "vitest";
import * as zod from "@oh-my-pi/omptype/zod";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));

describe("registered messenger schema", () => {
  it("accepts the supported optional fields and rejects invalid enum values", async () => {
    const pi = {
      pi: { getAgentDir: () => process.cwd() },
      zod,
      on: vi.fn(),
      registerTool: vi.fn((_definition: unknown) => {}),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    };

    // Load after the mocked runtime modules are installed.
    const { default: extension } = await import("../index.ts");
    extension(pi as unknown as Parameters<typeof extension>[0]);

    const definition = pi.registerTool.mock.calls[0]?.[0] as unknown as {
      name: string;
      parameters: { safeParse: (value: unknown) => { success: boolean } };
    };
    expect(definition.name).toBe("omp_messenger");
    expect(definition.parameters.safeParse({ action: "work", autonomous: true }).success).toBe(
      true,
    );
    expect(definition.parameters.safeParse({ type: "handoff", paths: ["a.ts"] }).success).toBe(
      true,
    );
    expect(definition.parameters.safeParse({ type: "invalid" }).success).toBe(false);
  });
});
