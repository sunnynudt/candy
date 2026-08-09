import path from "node:path";
import { pathToFileURL } from "node:url";
import { PI_COMPATIBILITY_VERSION, listPiPublicExports } from "@candy/pi-adapter";
import { ManualClock } from "@candy/platform";
import {
  CandyRuntime,
  DeterministicAgentEngine,
  TaskController,
  TaskScheduler,
  UnavailableBrowserCapability,
} from "@candy/runtime";

export interface TuiSmokeResult {
  readonly piVersion: string;
  readonly piRootExportCount: number;
  readonly browserAvailable: boolean;
  readonly observationTypes: readonly string[];
}

export interface TuiTaskSmokeResult {
  readonly taskId: string;
  readonly state: string;
  readonly revision: number;
  readonly queued: readonly string[];
  readonly observations: readonly string[];
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

export async function runTuiTaskSmoke(): Promise<TuiTaskSmokeResult> {
  const task = new TaskController("tui-task-smoke", "read-only");
  const scheduler = new TaskScheduler();
  scheduler.enqueue("tui-task-smoke");
  scheduler.startAvailable();
  task.setOwner("tui-smoke-owner", 0);
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(new ManualClock(2_000), "read-only response"),
    new UnavailableBrowserCapability(),
  );
  const observations = await runtime.runReadOnlyTurn(
    { taskId: "tui-task-smoke", prompt: "inspect the fixture" },
    new AbortController().signal,
  );
  const completed = task.transition("completed", 1);
  scheduler.finish("tui-task-smoke");
  return {
    taskId: completed.taskId,
    state: completed.state,
    revision: completed.revision,
    queued: scheduler.queued(),
    observations: observations.map((observation) => observation.type),
  };
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href
  );
}

if (isDirectExecution()) {
  if (process.argv.includes("--smoke-task")) console.log(JSON.stringify(await runTuiTaskSmoke()));
  else if (process.argv.includes("--smoke")) console.log(JSON.stringify(await runTuiSmoke()));
  else throw new Error("The TUI composition root supports only --smoke and --smoke-task.");
}
