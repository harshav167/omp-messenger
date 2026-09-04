import { describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-tui", () => ({
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import * as store from "../../crew/store.ts";
import * as teamStore from "../../crew/team/store.ts";
import { renderStatusBar, renderTaskList } from "../../overlay-render.ts";
import { createCrewViewState } from "../../overlay-actions.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

describe("Team overlay render signals", () => {
  it("shows active team, rejected count, role labels, and approval markers", () => {
    const { cwd } = createTempCrewDirs();
    teamStore.setActiveTeam(cwd, "migration-squad", "migration-squad");
    store.createPlan(cwd, "docs/PRD.md");
    store.createTask(cwd, "Update auth", "", [], {
      role: "worker",
      approval: { required: true, status: "rejected" },
    });

    const status = renderStatusBar(theme, cwd, 200);
    const tasks = renderTaskList(theme, cwd, 200, 10, createCrewViewState()).join("\n");

    expect(status).toContain("Team: migration-squad");
    expect(status).toContain("Rejected: 1");
    expect(tasks).toContain("[worker]");
    expect(tasks).toContain("[rejected]");
  });
});
