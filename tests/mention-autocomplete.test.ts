import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oh-my-pi/pi-tui", () => ({
  matchesKey: (data: string, key: string) => {
    if (key === "escape") return data === "\x1b";
    if (key === "enter") return data === "\r";
    if (key === "backspace") return data === "\x7f" || data === "\b";
    if (key === "tab") return data === "\t";
    if (key === "shift+tab") return data === "\x1b[Z";
    return false;
  },
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));

import { createCrewViewState, handleMessageInput, type CrewViewState } from "../overlay-actions.ts";
import type { MessengerState } from "../lib.ts";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { Mesh } from "../mesh/types.ts";

vi.mock("../crew/live-progress.ts", () => ({
  getLiveWorkers: () => new Map([
    ["task-1", { name: "jade-elk", taskId: "task-1" }],
  ]),
  hasLiveWorkers: () => false,
  onLiveWorkersChanged: () => () => {},
}));

vi.mock("../feed.ts", () => ({
  logFeedEvent: vi.fn(),
  readFeedEvents: () => [],
}));

vi.mock("../crew/registry.ts", () => ({
  hasActiveWorker: () => false,
}));

const mesh = {
  peers: () => [
    { name: "coral-fox" },
    { name: "amber-wolf" },
    { name: "crimson-bear" },
  ],
  send: vi.fn(async (to: string, text: string) => ({
    ok: true,
    message: {
      id: "m",
      from: "me",
      to,
      text,
      timestamp: new Date().toISOString(),
      replyTo: null,
    },
  })),
  claims: () => ({}),
} as unknown as Mesh;

function makeState(): MessengerState {
  return {
    agentName: "me",
    scopeToFolder: false,
    chatHistory: new Map(),
    broadcastHistory: [],
  } as MessengerState;
}

function makeTui(): TUI {
  return { requestRender: vi.fn() } as unknown as TUI;
}

function sendTab(vs: CrewViewState, state: MessengerState, targetMesh: Mesh, tui: TUI) {
  handleMessageInput("\t", vs, state, targetMesh, "/tmp/cwd", tui);
}

function sendShiftTab(vs: CrewViewState, state: MessengerState, targetMesh: Mesh, tui: TUI) {
  handleMessageInput("\x1b[Z", vs, state, targetMesh, "/tmp/cwd", tui);
}

function type(char: string, vs: CrewViewState, state: MessengerState, targetMesh: Mesh, tui: TUI) {
  handleMessageInput(char, vs, state, targetMesh, "/tmp/cwd", tui);
}

describe("mention autocomplete", () => {
  let vs: CrewViewState;
  let state: MessengerState;
  let tui: TUI;

  beforeEach(() => {
    vs = createCrewViewState();
    vs.inputMode = "message";
    state = makeState();
    tui = makeTui();
  });

  it("tab completes first matching agent after @", () => {
    vs.messageInput = "@";
    sendTab(vs, state, mesh, tui);
    expect(vs.messageInput).toMatch(/^@\S+ $/);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    expect(vs.mentionIndex).toBe(0);
  });

  it("cycles through candidates on repeated tab", () => {
    vs.messageInput = "@";
    sendTab(vs, state, mesh, tui);
    const first = vs.messageInput;
    sendTab(vs, state, mesh, tui);
    const second = vs.messageInput;
    expect(second).not.toBe(first);
    expect(vs.mentionIndex).toBe(1);
  });

  it("shift+tab cycles backwards", () => {
    vs.messageInput = "@";
    sendTab(vs, state, mesh, tui);
    sendTab(vs, state, mesh, tui);
    const atTwo = vs.messageInput;
    sendShiftTab(vs, state, mesh, tui);
    const backOne = vs.messageInput;
    expect(vs.mentionIndex).toBe(0);
    expect(backOne).not.toBe(atTwo);
  });

  it("filters candidates by typed prefix", () => {
    vs.messageInput = "@cor";
    sendTab(vs, state, mesh, tui);
    expect(vs.messageInput).toBe("@coral-fox ");
  });

  it("includes live workers in candidates", () => {
    vs.messageInput = "@jade";
    sendTab(vs, state, mesh, tui);
    expect(vs.messageInput).toBe("@jade-elk ");
  });

  it("includes @all in candidates", () => {
    vs.messageInput = "@al";
    sendTab(vs, state, mesh, tui);
    expect(vs.messageInput).toBe("@all ");
  });

  it("does not complete when input has a space (message already started)", () => {
    vs.messageInput = "@coral-fox hey";
    sendTab(vs, state, mesh, tui);
    expect(vs.messageInput).toBe("@coral-fox hey");
  });

  it("resets candidates on backspace", () => {
    vs.messageInput = "@cor";
    sendTab(vs, state, mesh, tui);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    type("\b", vs, state, mesh, tui);
    expect(vs.mentionCandidates).toEqual([]);
    expect(vs.mentionIndex).toBe(-1);
  });

  it("resets candidates on new character typed", () => {
    vs.messageInput = "@";
    sendTab(vs, state, mesh, tui);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    type("x", vs, state, mesh, tui);
    expect(vs.mentionCandidates).toEqual([]);
  });

  it("wraps around at end of candidates list", () => {
    vs.messageInput = "@";
    sendTab(vs, state, mesh, tui);
    const count = vs.mentionCandidates.length;
    for (let i = 0; i < count; i++) sendTab(vs, state, mesh, tui);
    expect(vs.mentionIndex).toBe(0);
  });
});

describe("message delivery notifications", () => {
  it("shows the existing success notification when the mesh accepts a direct message", async () => {
    const viewState = createCrewViewState();
    const state = makeState();
    const tui = makeTui();
    viewState.inputMode = "message";
    viewState.messageInput = "@coral-fox hello";

    handleMessageInput("\r", viewState, state, mesh, "/tmp/cwd", tui);
    await Promise.resolve();

    expect(viewState.notification?.message).toBe("✓ Sent to coral-fox");
    clearTimeout(viewState.notificationTimer ?? undefined);
  });

  it("shows the mesh error when a direct message is rejected", async () => {
    const viewState = createCrewViewState();
    const state = makeState();
    const tui = makeTui();
    const rejectedMesh = {
      ...mesh,
      send: vi.fn(async () => ({ ok: false as const, error: "unreachable" as const })),
    };
    viewState.inputMode = "message";
    viewState.messageInput = "@coral-fox hello";

    handleMessageInput("\r", viewState, state, rejectedMesh, "/tmp/cwd", tui);
    await Promise.resolve();

    expect(viewState.notification?.message).toBe("✗ Failed: unreachable");
    clearTimeout(viewState.notificationTimer ?? undefined);
  });

  it("counts only accepted sends in the broadcast success notification", async () => {
    const viewState = createCrewViewState();
    const state = makeState();
    const tui = makeTui();
    const partiallyAcceptedMesh = {
      ...mesh,
      send: vi.fn(async (to: string, text: string) => {
        if (to !== "coral-fox") return { ok: false as const, error: "not_found" as const };
        return {
          ok: true as const,
          message: {
            id: "accepted",
            from: "me",
            to,
            text,
            timestamp: new Date().toISOString(),
            replyTo: null,
          },
        };
      }),
    };
    viewState.inputMode = "message";
    viewState.messageInput = "hello";

    handleMessageInput("\r", viewState, state, partiallyAcceptedMesh, "/tmp/cwd", tui);
    await new Promise<void>(resolve => queueMicrotask(resolve));

    expect(viewState.notification?.message).toBe("✓ Broadcast to 1 peer");
    clearTimeout(viewState.notificationTimer ?? undefined);
  });
});
