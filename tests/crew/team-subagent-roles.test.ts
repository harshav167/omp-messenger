import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { discoverSubagentRoles } from "../../crew/team/subagent-roles.ts";
import * as teamStore from "../../crew/team/store.ts";

describe("team subagent role discovery", () => {
  it("merges user, project, and profile role metadata", () => {
    const { cwd } = createTempCrewDirs();
    const home = path.join(cwd, "home");
    const userDir = path.join(home, ".omp", "agent", "agents");
    const projectDir = path.join(cwd, ".omp", "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(path.join(userDir, "worker.md"), `---\r\nname: worker\r\ndescription: User worker\r\nmodel: user-model\r\n---\r\nUser prompt.`);
    fs.writeFileSync(path.join(userDir, "simplifier.md"), `---\nname: simplifier\ndescription: User simplifier\n---\nSimplify project-specific work.`);
    fs.writeFileSync(path.join(userDir, "uppercase-scout.md"), `---\nname: Scout\ndescription: Uppercase scout\n---\nScout prompt.`);
    fs.writeFileSync(path.join(userDir, "bad.md"), `---\nname: __proto__\ndescription: Bad role\n---\nBad prompt.`);
    fs.writeFileSync(path.join(userDir, "bad-object-key.md"), `---\nname: toString\ndescription: Bad object key\n---\nBad prompt.`);
    fs.writeFileSync(path.join(projectDir, "worker.md"), `---\nname: worker\ndescription: Project worker\n---\nProject prompt.`);

    const discovered = discoverSubagentRoles(cwd, { homeDir: home });
    expect(discovered.worker.description).toBe("Project worker");
    expect(discovered.worker.model).toBe("user-model");
    expect(discovered.worker.prompt).toContain("Project prompt");
    expect(discovered.simplifier.description).toBe("User simplifier");
    expect(discovered.scout.description).toBe("Uppercase scout");
    expect(Object.hasOwn(discovered, "__proto__")).toBe(false);
    expect(Object.hasOwn(discovered, "toString")).toBe(false);

    teamStore.saveProfile({ name: "profile", roles: { worker: { model: "profile-model" } } }, home);
    teamStore.setActiveTeam(cwd, "profile", "profile");
    const roles = teamStore.resolveRoles(cwd, { homeDir: home });
    expect(roles.worker.description).toBe("Project worker");
    expect(roles.worker.model).toBe("profile-model");
  });
});
