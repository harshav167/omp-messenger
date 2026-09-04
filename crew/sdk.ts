/**
 * Crew - omp SDK access
 *
 * The extension receives the runtime's root SDK namespace; crew modules reach
 * it through this accessor instead of importing the package, which would create
 * a second module instance.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type Sdk = ExtensionAPI["pi"];

let sdk: Sdk | null = null;

export function setSdk(api: Sdk): void {
  sdk = api;
}

export function getSdk(): Sdk {
  if (!sdk) {
    throw new Error("pi-messenger crew requires the oh-my-pi runtime (SDK not injected)");
  }
  return sdk;
}
