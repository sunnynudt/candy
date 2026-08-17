import { performance } from "node:perf_hooks";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuiEntrypoint = path.join(root, "apps", "tui", "dist", "main.js");
const runs = 10;
const markerTimeoutMs = 10_000;

if (!path.isAbsolute(tuiEntrypoint)) throw new Error("TUI entrypoint path is invalid.");

const coldStart = await measureColdStart();
const projection = await measureProjection();
const cancellation = await measureCancellation();
const concurrency = await measureConcurrency();

const revision = runCapture("git", ["rev-parse", "HEAD"]);
const lockfileDigest = await sha256Lockfile();
const host = `${process.platform} ${process.arch}`;
const report = [
  "# Candy TUI Responsiveness Measurement",
  "",
  `- Timestamp: ${new Date().toISOString()}`,
  `- Source revision: \`${revision}\``,
  `- Lockfile SHA-256: \`${lockfileDigest}\``,
  `- Host: \`${host}\``,
  `- Node: \`${process.version}\``,
  `- Runs per metric: ${runs}`,
  "",
  "This is a deterministic TUI-only measurement. It uses Candy-owned temporary app-data and an injected local engine; it does not access Provider credentials, the OS credential store, public network, Desktop, Browser, or Trusted Shell.",
  "",
  "| Metric | Target | p95 | Result | Samples (ms) |",
  "| --- | ---: | ---: | --- | --- |",
  metricRow("TUI cold start to usable smoke prompt", 2_000, coldStart),
  metricRow("TUI event to visible projection", 200, projection),
  metricRow("User cancellation to provider stop request", 2_000, cancellation),
  metricRow("Three concurrent tasks: maximum event gap", 1_000, concurrency.gaps),
  "",
  "## Three-task event delivery",
  "",
  `- Event-loss runs: ${concurrency.eventLossRuns.length === 0 ? "none" : concurrency.eventLossRuns.join(", ")}`,
  `- Completed task sets: ${concurrency.completedRuns}/${runs}`,
  "",
  "## Separate platform gate",
  "",
  "- Process-tree cancellation for Trusted Shell is not measured here; it remains a separate platform-native G2 gate and is measured only where Shell is enabled and accepted.",
  "- Provider stream-stop latency and Provider first-token/completion latency are not measured by this local fixture.",
  "",
].join("\n");

const outputRoot = path.join(root, "out", "acceptance", "tui");
await mkdir(outputRoot, { recursive: true });
const reportPath = path.join(outputRoot, `${process.platform}-responsiveness-latest.md`);
await writeFile(reportPath, report, "utf8");
console.log(
  `TUI responsiveness ${allPass(coldStart, projection, cancellation, concurrency.gaps) ? "passed" : "failed"}: report=${path.relative(root, reportPath)}`,
);

if (!allPass(coldStart, projection, cancellation, concurrency.gaps)) process.exitCode = 1;

async function measureColdStart() {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await execFileAsync(process.execPath, [tuiEntrypoint, "--smoke"], {
      cwd: root,
      env: cleanChildEnvironment(process.env),
      maxBuffer: 64 * 1024,
    });
    samples.push(Math.round(performance.now() - started));
  }
  return summarize(samples, 2_000);
}

async function measureProjection() {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "candy-tui-projection-"));
    const terminal = new FakeTerminal();
    const marker = `projection-marker-${index}`;
    let emittedAt = 0;
    try {
      const engine = {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          emittedAt = performance.now();
          yield { type: "assistant.delta", taskId: input.taskId, text: marker };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      };
      const runPromise = new InteractiveTui({
        appDataRoot: rootPath,
        terminal,
        engine,
      }).run();
      await waitFor(() => terminal.started);
      terminal.emitInput(`projection ${index}`);
      terminal.emitInput("\r");
      await waitFor(() => terminal.writes.join("").includes(marker));
      samples.push(Math.round(performance.now() - emittedAt));
      terminal.emitInput("\x03");
      await runPromise;
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
  return summarize(samples, 200);
}

async function measureCancellation() {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "candy-tui-cancel-"));
    const terminal = new FakeTerminal();
    let stopRequestedAt = 0;
    try {
      const engine = {
        async *runTurn(input, signal) {
          yield { type: "turn.started", taskId: input.taskId };
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener("abort", onAbort);
              stopRequestedAt = performance.now();
              reject(new Error("fixture cancellation"));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
            void resolve;
          });
        },
      };
      const runPromise = new InteractiveTui({
        appDataRoot: rootPath,
        terminal,
        engine,
      }).run();
      await waitFor(() => terminal.started);
      terminal.emitInput(`cancel ${index}`);
      terminal.emitInput("\r");
      await waitFor(() => /created (task-[a-z0-9]+)/u.test(terminal.writes.join("")));
      const outputBeforeCancel = terminal.writes.join("");
      const taskId = outputBeforeCancel.match(/created (task-[a-z0-9]+)/u)?.[1];
      if (taskId === undefined) throw new Error("Cancellation fixture task id was not created.");
      const cancelStarted = performance.now();
      terminal.emitInput(`:cancel ${taskId}`);
      terminal.emitInput("\r");
      await waitFor(() => stopRequestedAt > 0);
      samples.push(Math.round(stopRequestedAt - cancelStarted));
      await waitFor(() => terminal.writes.join("").includes(`${taskId} cancelled`));
      terminal.emitInput("\x03");
      await runPromise;
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
  return summarize(samples, 2_000);
}

async function measureConcurrency() {
  const gaps = [];
  const eventLossRuns = [];
  let completedRuns = 0;
  for (let index = 0; index < runs; index += 1) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "candy-tui-concurrency-"));
    const terminal = new FakeTerminal();
    let active = 0;
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const engine = {
        async *runTurn(input) {
          active += 1;
          const marker = `concurrency-marker-${active}`;
          yield { type: "turn.started", taskId: input.taskId };
          if (active === 3) release();
          await barrier;
          yield {
            type: "assistant.delta",
            taskId: input.taskId,
            text: marker,
          };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      };
      const runPromise = new InteractiveTui({
        appDataRoot: rootPath,
        terminal,
        engine,
      }).run();
      await waitFor(() => terminal.started);
      const createdIds = [];
      for (let taskIndex = 0; taskIndex < 3; taskIndex += 1) {
        terminal.emitInput(`:new concurrency ${taskIndex}`);
        terminal.emitInput("\r");
        await waitFor(() => {
          const matches = [...terminal.writes.join("").matchAll(/created (task-[a-z0-9]+)/gu)].map(
            (match) => match[1],
          );
          return matches.length > createdIds.length;
        });
        const ids = [...terminal.writes.join("").matchAll(/created (task-[a-z0-9]+)/gu)].map(
          (match) => match[1],
        );
        createdIds.push(ids.at(-1));
      }
      const markerTimes = [];
      for (let taskIndex = 1; taskIndex <= 3; taskIndex += 1) {
        const marker = `concurrency-marker-${taskIndex}`;
        let found = false;
        try {
          found = await waitFor(() => terminal.writes.join("").includes(marker));
        } catch (error) {
          throw new Error(
            `Concurrency marker ${marker} missing; active=${active}; output=${terminal.writes.join("")}`,
            { cause: error },
          );
        }
        if (found) markerTimes.push(performance.now());
      }
      const missing = createdIds.some((taskId) => taskId === undefined);
      if (missing || markerTimes.length !== 3) eventLossRuns.push(index + 1);
      else {
        completedRuns += 1;
        gaps.push(
          Math.round(
            Math.max(
              ...markerTimes.slice(1).map((time, markerIndex) => time - markerTimes[markerIndex]),
              0,
            ),
          ),
        );
      }
      terminal.emitInput("\x03");
      await runPromise;
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
  if (gaps.length !== runs)
    eventLossRuns.push(...Array.from({ length: runs - gaps.length }, (_, index) => index + 1));
  return {
    gaps: summarize(
      gaps.length === runs
        ? gaps
        : [...gaps, ...Array(runs - gaps.length).fill(Number.MAX_SAFE_INTEGER)],
      1_000,
    ),
    eventLossRuns,
    completedRuns,
  };
}

function metricRow(name, target, metric) {
  return `| ${name} | <= ${target} ms | ${metric.p95} ms | ${metric.pass ? "Pass" : "Fail"} | ${metric.samples.join(", ")} |`;
}

function summarize(samples, target) {
  if (
    samples.length !== runs ||
    samples.some((sample) => !Number.isSafeInteger(sample) || sample < 0)
  ) {
    throw new Error("TUI responsiveness fixture returned an invalid ten-run metric.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return { samples, p95, pass: p95 <= target };
}

function allPass(...metrics) {
  return metrics.every((metric) => metric.pass);
}

async function waitFor(predicate) {
  const started = performance.now();
  while (performance.now() - started < markerTimeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(1);
  }
  throw new Error(`TUI responsiveness fixture timed out: ${String(predicate())}`);
}

function runCapture(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function sha256Lockfile() {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(await readFile(path.join(root, "package-lock.json")))
    .digest("hex");
}
