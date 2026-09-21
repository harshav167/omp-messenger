/**
 * Verifies the extension's self-contained omp_messenger renderers against a real
 * initialized pi-tui theme: merged call/result frames (no duplicated body), hub-style
 * send cards, and a status-line fallback so every action renders visibly. Runs under
 * Bun (`bun test tests/bun`); the Node suite mocks pi-tui because it needs the Bun
 * global.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import piMessengerExtension from "../../index.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type ToolDef = {
	name: string;
	renderCall?: (args: unknown, options: unknown, uiTheme: unknown) => { render(width: number): string[] };
	renderResult?: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: unknown,
		uiTheme: unknown,
		args?: unknown,
	) => { render(width: number): string[] };
};

const pi = {
	registerTool(def: ToolDef) {
		tool = def;
	},
	registerCommand() {},
	registerMessageRenderer() {},
	registerShortcut() {},
	on() {},
	getFlag() {},
	appendEntry() {},
	events: { emit() {}, on() {} },
};

let tool: ToolDef;

beforeAll(() => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-render-home-"));
	process.env.PI_MESSENGER_DIR = path.join(home, "messenger");
	initThemeSync("unicode", false, "dark");
	piMessengerExtension(pi as never);
});

afterAll(() => {
	delete process.env.PI_MESSENGER_DIR;
});

describe("omp_messenger tool renderers", () => {
	test("registered with the merged call+result contract", () => {
		expect(tool?.name).toBe("omp_messenger");
		expect(typeof tool.renderCall).toBe("function");
		expect(typeof tool.renderResult).toBe("function");
		// mergeCallAndResult makes the result frame REPLACE the pending frame,
		// so the message body is rendered exactly once.
		expect((tool as Record<string, unknown>).mergeCallAndResult).toBe(true);
	});

	test("pending send shows the header plus a dim single-line body preview", () => {
		const lines = tool
			.renderCall!({ action: "send", to: "researcher", message: "line one\nline two" }, { expanded: false }, theme)
			.render(120);
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("IRC");
		expect(lines[0]).toContain("researcher");
		// Multi-line bodies collapse into one preview line while the call runs.
		expect(lines[1]).toContain("│");
		expect(lines[1]).toContain("line one line two");
	});

	test("delivered send renders the IRC card: target, delivery state, quoted body", () => {
		const lines = tool
			.renderResult!(
				{
					content: [{ type: "text", text: "Sent to researcher." }],
					details: { action: "send", sent: ["researcher"], failed: [], message: "quorum reached" },
				},
				{ expanded: false },
				theme,
				{ action: "send", to: "researcher", message: "quorum reached" },
			)
			.render(120);
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("IRC");
		expect(lines[0]).toContain("researcher");
		expect(lines[0]).toContain("delivered");
		expect(lines[1]).toContain("│");
		expect(lines[1]).toContain("quorum reached");
	});

	test("broadcast result summarizes delivery counts", () => {
		const lines = tool
			.renderResult!(
				{
					content: [{ type: "text", text: "Broadcast to 2 agent(s)." }],
					details: {
						action: "broadcast",
						sent: ["a", "b"],
						failed: [{ name: "c", error: "offline" }],
						message: "status?",
					},
				},
				{ expanded: false },
				theme,
				{ action: "broadcast", to: ["a", "b", "c"], message: "status?" },
			)
			.render(120);
		expect(lines[0]).toContain("all");
		expect(lines[0]).toContain("2 delivered");
		expect(lines[0]).toContain("1 failed");
	});

	test("failed send renders the error state with the reason", () => {
		const lines = tool
			.renderResult!(
				{
					content: [{ type: "text", text: "Failed to send: researcher not found" }],
					details: { action: "send", sent: [], failed: [{ name: "ghost", error: "agent not found" }] },
					isError: true,
				},
				{ expanded: false },
				theme,
				{ action: "send", to: "ghost", message: "ping" },
			)
			.render(120);
		expect(lines[0]).toContain("ghost");
		expect(lines.some((line) => line.includes("agent not found"))).toBe(true);
	});

	test("non-messaging actions fall back to a status line so every call is visible", () => {
		const pending = tool.renderCall!({ action: "channels" }, { expanded: false }, theme).render(120);
		expect(pending.length).toBe(1);
		expect(pending[0]).toContain("IRC channels");

		const result = tool
			.renderResult!(
				{ content: [{ type: "text", text: "Left the mesh." }], details: { action: "leave", agent: "w1" } },
				{ expanded: false },
				theme,
				{ action: "leave" },
			)
			.render(120);
		expect(result[0]).toContain("IRC leave");
		expect(result.some((line) => line.includes("Left the mesh."))).toBe(true);
	});
});
