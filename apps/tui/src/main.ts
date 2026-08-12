import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  PI_COMPATIBILITY_VERSION,
  PiAgentEngine,
  type PiAgentEngineInput,
  type PiAgentObservation,
  listPiPublicExports,
} from "@candy/pi-adapter";
import {
  resolveAppPaths,
  resolveCredential,
  resolveDefaultAppDataRoot,
  SQLiteTaskStore,
  SystemClock,
} from "@candy/platform";
import {
  CandyRuntime,
  DeterministicAgentEngine,
  TaskController,
  TaskScheduler,
  UnavailableBrowserCapability,
} from "@candy/runtime";
import { CandyTuiSurface, type CandyTuiTerminal } from "./pi-tui-surface.js";

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
    new DeterministicAgentEngine(new SystemClock(), "fixture response"),
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
    new DeterministicAgentEngine(new SystemClock(), "read-only response"),
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

export interface InteractiveTuiOptions {
  readonly appDataRoot?: string;
  readonly engine?: TuiAgentEngine;
  readonly terminal?: CandyTuiTerminal;
}

export interface TuiAgentEngine {
  runTurn(input: PiAgentEngineInput, signal: AbortSignal): AsyncIterable<PiAgentObservation>;
  recoverPrompt?(taskId: string, cwd: string): Promise<string | undefined>;
}

export class InteractiveTui {
  readonly #appDataRoot: string;
  readonly #terminal: CandyTuiTerminal | undefined;
  readonly #store: SQLiteTaskStore;
  readonly #scheduler: TaskScheduler;
  readonly #controllers = new Map<string, TaskController>();
  readonly #prompts = new Map<string, string>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #requestedStops = new Map<string, "paused" | "cancelled">();
  readonly #engine: TuiAgentEngine;
  readonly #ownerId = `tui:${process.pid}`;
  #surface: CandyTuiSurface | undefined = undefined;
  #resolveExit: (() => void) | undefined = undefined;
  #closing = false;

  public constructor(options: InteractiveTuiOptions = {}) {
    this.#appDataRoot = options.appDataRoot ?? resolveDefaultAppDataRoot();
    this.#terminal = options.terminal;
    const paths = resolveAppPaths(this.#appDataRoot);
    this.#store = new SQLiteTaskStore(path.join(paths.state, "tasks.sqlite"));
    this.#store.markActiveInterrupted();
    this.#scheduler = new TaskScheduler(3, 5, this.#store);
    this.#engine =
      options.engine ??
      new PiAgentEngine(paths.sessions, async () => {
        const lease = resolveCredential("deepseek");
        return lease ? { secret: lease.value, release: lease.release } : undefined;
      });
  }

  public async run(): Promise<void> {
    this.#surface = new CandyTuiSurface({
      appDataRoot: this.#appDataRoot,
      terminal: this.#terminal,
      onSubmit: (text: string): void => this.handleInput(text),
      onInterrupt: (): void => this.requestExit(),
    });
    this.write("Candy TUI — local-first, one agent per task\n");
    this.write(
      "Enter a prompt, :tasks, :prioritize <task-id>, :pause <task-id>, :resume <task-id>, :cancel <task-id>, or :quit.\n",
    );
    const exitPromise: Promise<void> = new Promise<void>((resolve: () => void): void => {
      this.#resolveExit = resolve;
    });
    try {
      this.#surface.start();
      await exitPromise;
    } finally {
      this.#closing = true;
      for (const task of this.#controllers.values()) {
        const current = task.snapshot();
        if (current.state === "running" || current.state === "waiting_approval")
          task.transition("interrupted", current.revision);
      }
      this.#store.markOwnerInterrupted(this.#ownerId);
      for (const controller of this.#abortControllers.values()) controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.#resolveExit = undefined;
      await this.#surface.stop();
      this.#surface = undefined;
      this.#store.close();
    }
  }

  private handleInput(value: string): void {
    const trimmed: string = value.trim();
    if (trimmed === ":quit") {
      this.requestExit();
    } else if (trimmed === ":tasks") {
      this.printTasks();
    } else if (trimmed.startsWith(":prioritize ")) {
      this.prioritize(trimmed.slice(12).trim());
    } else if (trimmed.startsWith(":pause ")) {
      this.pause(trimmed.slice(7).trim());
    } else if (trimmed.startsWith(":resume ")) {
      this.resume(trimmed.slice(8).trim());
    } else if (trimmed.startsWith(":cancel ")) {
      void this.cancel(trimmed.slice(8).trim());
    } else if (trimmed.length > 0) {
      this.create(trimmed);
    }
  }

  private requestExit(): void {
    this.#resolveExit?.();
  }

  private create(prompt: string): void {
    if (containsCredentialMaterial(prompt)) {
      this.write("prompt rejected: credential-shaped content is forbidden\n");
      return;
    }
    const taskId = `task-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const queueOrder =
      this.#store.queued().reduce((max, task) => Math.max(max, task.queueOrder ?? 0), 0) + 1;
    const metadata = this.#store.create(taskId, "read-only", queueOrder);
    const controller = new TaskController(taskId, "read-only", this.#store);
    this.#controllers.set(taskId, controller);
    this.#prompts.set(taskId, prompt);
    this.#scheduler.enqueue(taskId);
    this.write(`created ${taskId} (${metadata.state})\n`);
    this.drain();
  }

  private drain(): void {
    for (const taskId of this.#scheduler.startAvailable()) {
      if (this.#abortControllers.has(taskId)) continue;
      const task = this.#controllers.get(taskId);
      if (!task || !["queued", "paused", "interrupted"].includes(task.snapshot().state)) continue;
      const running = task.setOwner(this.#ownerId, task.snapshot().revision);
      const abort = new AbortController();
      this.#abortControllers.set(taskId, abort);
      void this.runTask(task, running.revision, abort);
    }
  }

  private async runTask(
    task: TaskController,
    revision: number,
    abort: AbortController,
  ): Promise<void> {
    const taskId = task.snapshot().taskId;
    try {
      const prompt =
        this.#prompts.get(taskId) ?? (await this.#engine.recoverPrompt?.(taskId, process.cwd()));
      if (prompt === undefined) throw new Error("Task prompt is unavailable after restart.");
      for await (const observation of this.#engine.runTurn(
        {
          taskId,
          prompt,
          model: "deepseek-v4-flash",
          cwd: process.cwd(),
          approvalProfile: "read-only",
        },
        abort.signal,
      )) {
        if (observation.type === "assistant.delta") this.write(observation.text);
        if (observation.type === "tool.completed") this.write(`\n[tool ${observation.tool}]\n`);
      }
      const current = task.snapshot();
      if (current.state === "running" && current.revision === revision) {
        const completed = task.transition("completed", revision);
        this.write(`\n${completed.taskId} completed\n`);
      }
    } catch (error) {
      const current = task.snapshot();
      if (current.state === "running") {
        const requestedStop = this.#requestedStops.get(taskId);
        const stopped = task.transition(
          requestedStop ?? (abort.signal.aborted ? "cancelled" : "interrupted"),
          current.revision,
        );
        this.write(`\n${stopped.taskId} ${stopped.state}: ${safeError(error)}\n`);
      }
    } finally {
      this.#abortControllers.delete(taskId);
      this.#requestedStops.delete(taskId);
      this.#scheduler.finish(taskId);
      if (!this.#closing) this.drain();
    }
  }

  private async cancel(taskId: string): Promise<void> {
    const abort = this.#abortControllers.get(taskId);
    if (abort) {
      this.#requestedStops.set(taskId, "cancelled");
      abort.abort();
      return;
    }
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "queued") {
      this.#scheduler.cancelQueued(taskId);
      task.transition("cancelled", task.snapshot().revision);
      this.write(`${taskId} cancelled before start\n`);
    } else {
      this.write(`${taskId} is not an active task\n`);
    }
  }

  private pause(taskId: string): void {
    const abort = this.#abortControllers.get(taskId);
    if (abort) {
      this.#requestedStops.set(taskId, "paused");
      abort.abort();
      return;
    }
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "queued") {
      this.#scheduler.cancelQueued(taskId);
      task.transition("paused", task.snapshot().revision);
      this.write(`${taskId} paused before start\n`);
    } else {
      this.write(`${taskId} is not pausable\n`);
    }
  }

  private prioritize(taskId: string): void {
    const next = this.#scheduler.queued().find((candidate) => candidate !== taskId);
    if (next === undefined) {
      this.write(`${taskId} is already next or is not queued\n`);
      return;
    }
    if (this.#scheduler.moveQueuedBefore(taskId, next)) {
      this.write(`${taskId} moved to the front of the queue\n`);
    } else {
      this.write(`${taskId} is not queued\n`);
    }
  }

  private resume(taskId: string): void {
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "paused" || task?.snapshot().state === "interrupted") {
      this.#scheduler.enqueue(taskId);
      this.write(`${taskId} queued for resume\n`);
      this.drain();
    } else {
      this.write(`${taskId} is not resumable\n`);
    }
  }

  private printTasks(): void {
    for (const task of this.#store.list())
      this.write(`${task.taskId}\t${task.state}\tr${task.revision}\tq${task.queueOrder ?? "-"}\n`);
  }

  private write(value: string): void {
    this.#surface?.appendTranscript(redactTuiOutput(value));
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error && /credentials|cancelled|unavailable/iu.test(error.message))
    return error.message;
  return "runtime error";
}

function containsCredentialMaterial(value: string): boolean {
  return /(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,})/u.test(
    value,
  );
}

function redactTuiOutput(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, `$1[REDACTED]`)
    .replace(/\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/gu, "[REDACTED]");
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
  else await new InteractiveTui().run();
}
