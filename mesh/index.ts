/**
 * omp-messenger - Mesh factory
 *
 * Filesystem mesh by default; mesh-server client when `config.mesh.url` is set.
 */

import type { MessengerConfig } from "../config.ts";
import type { MessengerState } from "../lib.ts";
import { createFsMesh } from "./fs.ts";
import { createMeshClient } from "./client.ts";
import type { DeliverFn, Mesh } from "./types.ts";

export interface CreateMeshOptions {
  config: MessengerConfig;
  /** Filesystem mesh root (OMP_MESSENGER_DIR or ~/.omp/agent/messenger). */
  base: string;
  state: MessengerState;
  deliver: DeliverFn;
  onStatusChange?: () => void;
}

export function createMesh({ config, base, state, deliver, onStatusChange }: CreateMeshOptions): Mesh {
  if (config.mesh.url) {
    return createMeshClient({ url: config.mesh.url, token: config.mesh.token, state, deliver, onStatusChange });
  }
  return createFsMesh(base, state, deliver);
}
