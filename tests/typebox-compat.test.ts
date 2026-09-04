import { describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));

vi.mock("typebox", () => ({
  Type: {
    Optional: (schema: unknown) => schema,
    String: (schema: unknown) => schema,
    Number: (schema: unknown) => schema,
    Boolean: (schema: unknown) => schema,
    Any: (schema: unknown) => schema,
    Array: (schema: unknown) => schema,
    Object: (schema: unknown) => schema,
    Literal: (value: string) => ({ const: value }),
    Union: (items: unknown[], options: unknown) => ({ anyOf: items, ...options as object }),
  },
}));

describe("typebox compatibility", () => {
  it("loads without Type.Unsafe", async () => {
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    };

    const { default: piMessengerExtension } = await import("../index.ts");
    piMessengerExtension(pi as any);

    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "pi_messenger" }));
  });
});
