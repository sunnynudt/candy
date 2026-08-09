import path from "node:path";
import { pathToFileURL } from "node:url";
import { PI_COMPATIBILITY_VERSION, listPiPublicExports } from "@candy/pi-adapter";
import { ManualClock } from "@candy/platform";
import {
  CandyRuntime,
  DeterministicAgentEngine,
  UnavailableBrowserCapability,
} from "@candy/runtime";

export interface TuiSmokeResult {
  readonly piVersion: string;
  readonly piRootExportCount: number;
  readonly browserAvailable: boolean;
  readonly observationTypes: readonly string[];
}

export async function runTuiSmoke(): Promise<TuiSmokeResult> {
  const browser = new UnavailableBrowserCapability();
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(new ManualClock(1_000), "fixture response"),
    browser,
  );
  const observations = await runtime.runReadOnlyTurn(
    { taskId: "smoke-task", prompt: "inspect the fixture" },
    new AbortController().signal,
  );

  return {
    piVersion: PI_COMPATIBILITY_VERSION,
    piRootExportCount: listPiPublicExports().length,
    browserAvailable: browser.available,
    observationTypes: observations.map((observation) => observation.type),
  };
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href
  );
}

if (isDirectExecution()) {
  if (!process.argv.includes("--smoke")) {
    throw new Error("The Phase 1 TUI composition root currently supports only --smoke.");
  }
  console.log(JSON.stringify(await runTuiSmoke()));
}
