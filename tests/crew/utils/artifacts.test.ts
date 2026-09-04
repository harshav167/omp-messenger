import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureArtifactsDir } from "../../../crew/utils/artifacts.ts";

const roots = new Set<string>();

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-messenger-artifacts-"));
  roots.add(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("crew/utils/artifacts", () => {
  it("removes files older than cleanupDays", () => {
    const dir = createTempDir();
    const oldFile = path.join(dir, "old.jsonl");
    const freshFile = path.join(dir, "fresh.jsonl");
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(freshFile, "fresh");

    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldDate, oldDate);

    ensureArtifactsDir(dir, 7);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });
});
