/** Crew artifact directory maintenance and metadata output. */

import * as fs from "node:fs";
import * as path from "node:path";

export function ensureArtifactsDir(dir: string, cleanupDays?: number): void {
  fs.mkdirSync(dir, { recursive: true });
  if (cleanupDays === undefined || cleanupDays <= 0) return;

  const cutoff = Date.now() - cleanupDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name);
    if (extension !== ".md" && extension !== ".jsonl" && extension !== ".json") continue;
    const filePath = path.join(dir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue;
      throw error;
    }
  }
}

export function writeMetadata(filePath: string, metadata: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}
