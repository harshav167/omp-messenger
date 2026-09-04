import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import * as teamStore from "../../crew/team/store.ts";
import * as store from "../../crew/store.ts";

describe("crew/team store", () => {
  let cwd: string;
  let profilesDir: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
    profilesDir = path.join(cwd, "profiles");
    process.env.OMP_MESSENGER_TEAM_PROFILE_DIR = profilesDir;
  });

  afterEach(() => {
    delete process.env.OMP_MESSENGER_TEAM_PROFILE_DIR;
  });

  it("lists built-in sample profiles", () => {
    expect(teamStore.listProfiles().map(p => p.name)).toEqual(["migration-squad", "research-squad", "review-squad"]);
  });

  it("resolves packaged-vocabulary built-in roles including delegate", () => {
    const roles = teamStore.resolveRoles(cwd, { homeDir: path.join(cwd, "home") });

    expect(Object.keys(roles).sort()).toEqual([
      "context-builder",
      "delegate",
      "oracle",
      "planner",
      "researcher",
      "reviewer",
      "scout",
      "worker",
    ]);
    expect(roles.delegate.description).toContain("Lightweight subagent");
    expect(roles.simplifier).toBeUndefined();
    expect(roles["verbosity-cleaner"]).toBeUndefined();
  });

  it("keeps review-squad on packaged/common roles", () => {
    const profile = teamStore.sampleTeamProfile("review-squad");

    expect(Object.keys(profile?.roles ?? {}).sort()).toEqual(["oracle", "reviewer", "scout", "worker"]);
  });

  it("allows non-packaged roles from saved profiles", () => {
    const home = path.join(cwd, "home");
    teamStore.saveProfile({ name: "custom-squad", roles: { simplifier: { description: "Project-specific simplifier" } } }, home);
    teamStore.useProfile(cwd, "custom-squad", home);

    const roles = teamStore.resolveRoles(cwd, { homeDir: home });
    expect(roles.simplifier.description).toBe("Project-specific simplifier");
  });

  it("uses project-local active team state and saves reusable JSON profiles", () => {
    const { team, profile, created } = teamStore.useProfile(cwd, "migration-squad");

    expect(created).toBe(true);
    expect(team.name).toBe("migration-squad");
    expect(team.profile).toBe("migration-squad");
    expect(profile.description).toContain("migrations");
    expect(profile.approval?.labels).toContain("migration");
    expect(profile.roles?.worker?.prompt).toContain("rollback path");
    expect(fs.existsSync(path.join(cwd, ".omp", "messenger", "team", "team.json"))).toBe(true);
    expect(fs.existsSync(path.join(profilesDir, "migration-squad.json"))).toBe(true);
    expect(teamStore.listProfiles().map(p => p.name)).toEqual(["migration-squad", "research-squad", "review-squad"]);
  });

  it("rejects profile names that are not filename-safe", () => {
    expect(teamStore.isValidProfileName("migration-squad")).toBe(true);
    expect(teamStore.isValidProfileName("../outside")).toBe(false);
    expect(teamStore.isValidProfileName("__proto__")).toBe(false);
    expect(teamStore.isValidProfileName("constructor")).toBe(false);
    expect(teamStore.isValidProfileName("toString")).toBe(false);
    expect(() => teamStore.useProfile(cwd, "../outside")).toThrow(/Invalid team profile name/);
    expect(fs.existsSync(path.join(profilesDir, "..", "outside.json"))).toBe(false);
  });

  it("preserves malformed saved profile errors", () => {
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, "broken.json"), "{");

    expect(() => teamStore.listProfiles()).toThrow(/Failed to read Team JSON/);
  });

  it("rejects saved profiles with invalid consumed fields", () => {
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, "bad.json"), JSON.stringify({
      name: "bad",
      approval: { mode: "risk-labels", labels: "auth" },
    }));
    fs.writeFileSync(path.join(profilesDir, "bad-label.json"), JSON.stringify({
      name: "bad-label",
      approval: { mode: "risk-labels", labels: ["auth", ""] },
    }));
    fs.writeFileSync(path.join(profilesDir, "bad-memory.json"), JSON.stringify({
      name: "bad-memory",
      memory: { inject: ["decision", "unknown"] },
    }));

    expect(() => teamStore.useProfile(cwd, "bad")).toThrow(/approval\.labels must be an array/);
    expect(() => teamStore.useProfile(cwd, "bad-label")).toThrow(/approval\.labels entries must be non-empty strings/);
    expect(() => teamStore.useProfile(cwd, "bad-memory")).toThrow(/memory\.inject entries must be one of/);
  });

  it("rejects saved profiles whose name does not match the file name", () => {
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, "alias.json"), JSON.stringify({ name: "other" }));

    expect(() => teamStore.useProfile(cwd, "alias")).toThrow(/profile name must match file name/);
  });

  it("creates and updates charter files", () => {
    const created = teamStore.writeCharter(cwd, "migration-squad", "Ship safely.");
    expect(created).toContain("# migration-squad Charter");
    expect(teamStore.readCharter(cwd)).toContain("Ship safely.");

    const updated = teamStore.updateCharter(cwd, "Prefer small diffs.");
    expect(updated).toContain("Ship safely.");
    expect(updated).toContain("Prefer small diffs.");
  });

  it("stores JSONL memory and markdown rollups", () => {
    const entry = teamStore.noteMemory(cwd, "decision", "Use cursor pagination", "AgentOne", "task-1");

    expect(entry.type).toBe("decision");
    expect(teamStore.listMemory(cwd, "decision")).toHaveLength(1);
    expect(teamStore.memoryCounts(cwd).decision).toBe(1);
    expect(fs.readFileSync(path.join(cwd, ".omp", "messenger", "team", "decisions.md"), "utf-8")).toContain("Use cursor pagination");
  });

  it("skips malformed memory JSONL entries", () => {
    const memoryPath = path.join(cwd, ".omp", "messenger", "team", "memory.jsonl");
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(memoryPath, [
      JSON.stringify({ ts: "2026-01-01T00:00:00Z", agent: "AgentOne", type: "decision", message: "Keep this" }),
      JSON.stringify({ ts: "2026-01-01T00:00:01Z", agent: "AgentOne", type: "invalid", message: "Skip this" }),
      "not json",
    ].join("\n"));

    expect(teamStore.listMemory(cwd).map(entry => entry.message)).toEqual(["Keep this"]);
    expect(teamStore.memoryCounts(cwd)).toEqual({ decision: 1, interface: 0, risk: 0, handoff: 0 });
  });

  it("normalizes approval requirements from active profile risk labels", () => {
    teamStore.useProfile(cwd, "migration-squad");

    const workerApproval = teamStore.approvalForTask(cwd, "worker", ["auth"]);
    const scoutApproval = teamStore.approvalForTask(cwd, "scout", ["auth"]);
    const plannerApproval = teamStore.approvalForTask(cwd, "planner", ["auth"]);
    const oracleApproval = teamStore.approvalForTask(cwd, "oracle", ["auth"]);

    expect(workerApproval).toEqual({ required: true, status: "pending" });
    expect(scoutApproval).toBeUndefined();
    expect(plannerApproval).toBeUndefined();
    expect(oracleApproval).toBeUndefined();
  });

  it("canonicalizes packaged role casing from saved profiles", () => {
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, "case-team.json"), JSON.stringify({
      name: "case-team",
      roles: { Scout: { model: "case-model" } },
      approval: { mode: "risk-labels", labels: ["auth"] },
    }));

    teamStore.useProfile(cwd, "case-team");

    expect(teamStore.resolveRoleName(cwd, "Scout")).toBe("scout");
    expect(teamStore.resolveRoles(cwd).scout.model).toBe("case-model");
    expect(teamStore.approvalForTask(cwd, "Scout", ["auth"])).toBeUndefined();
  });

  it("counts tasks needing lead approval", () => {
    store.createPlan(cwd, "docs/PRD.md");
    store.createTask(cwd, "High risk", "", [], { approval: { required: true, status: "pending" } });
    store.createTask(cwd, "Approved", "", [], { approval: { required: true, status: "approved" } });

    expect(teamStore.needsLeadTasks(cwd).map(t => t.title)).toEqual(["High risk"]);
  });
});
