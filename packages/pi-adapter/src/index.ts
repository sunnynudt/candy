import * as piSdk from "@earendil-works/pi-coding-agent";

export const PI_COMPATIBILITY_VERSION = "0.84.1" as const;

export function listPiPublicExports(): readonly string[] {
  return Object.keys(piSdk).sort();
}
