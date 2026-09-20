import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCandyWorkspaceTools } from "@candy/pi-adapter";
import {
  cleanChildEnvironment,
  InMemoryCredentialStore,
  resolveAppPaths,
  SQLiteTaskStore,
} from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("The Windows TUI journey requires Windows 11 x64.");

const journeyRoot = await mkdtemp(path.join(os.tmpdir(), "candy-tui-windows-"));
const workspace = path.join(journeyRoot, "workspace with spaces");
const appDataRoot = path.join(journeyRoot, "app-data");
const initialValue = "export const value: number = 1;\n";
const childEnvironment = cleanChildEnvironment(process.env);

await mkdir(path.join(workspace, "src"), { recursive: true });
await writeFile(path.join(workspace, "src", "value.ts"), initialValue, "utf8");
runGit(workspace, ["init", "-q"]);
runGit(workspace, ["add", "src/value.ts"]);
runGit(workspace, [
  "-c",
  "user.name=Candy Windows Fixture",
  "-c",
  "user.email=candy-windows@example.invalid",
  "commit",
  "-qm",
  "journey baseline",
]);

const beforeHead = runGit(workspace, ["rev-parse", "HEAD"]);
const beforeTree = runGit(workspace, ["write-tree"]);
const beforeCommitCount = runGit(workspace, ["rev-list", "--count", "HEAD"]);
let firstEngineCalls = 0;

try {
  const firstTerminal = new FakeTerminal();
  const firstRun = new InteractiveTui({
    appDataRoot,
    workspacePath: workspace,
    terminal: firstTerminal,
    credentialStore: new InMemoryCredentialStore(),
    credentialEnvironment: {},
    engine: {
      async *runTurn(input, signal) {
        firstEngineCalls += 1;
        if (input.approvalProfile !== "auto")
          throw new Error("Windows journey requires the explicit Auto profile.");
        if (signal.aborted) throw new Error("Windows journey was cancelled.");
        const tools = createCandyWorkspaceTools(
          input.cwd,
          "auto",
          undefined,
          input.fileDeleteApproval,
        );
        const execute = async (name, args) => {
          const tool = tools.find((candidate) => candidate.name === name);
          if (tool === undefined) throw new Error(`Windows journey tool unavailable: ${name}`);
          await tool.execute(`windows-journey-${name}`, args, signal, undefined, {});
          return true;
        };

        yield { type: "turn.started", taskId: input.taskId };
        await execute("candy_list", { path: "." });
        yield { type: "tool.completed", taskId: input.taskId, tool: "candy_list", ok: true };
        await execute("candy_read", { path: "src/value.ts" });
        yield { type: "tool.completed", taskId: input.taskId, tool: "candy_read", ok: true };
        await execute("candy_write", {
          path: "src/created.ts",
          content: "export const created = true;\n",
        });
        yield { type: "tool.completed", taskId: input.taskId, tool: "candy_write", ok: true };
        await execute("candy_edit", {
          path: "src/value.ts",
          edits: [{ oldText: "= 1", newText: "= 2" }],
        });
        yield { type: "tool.completed", taskId: input.taskId, tool: "candy_edit", ok: true };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: "windows journey completed the bounded workspace edit\n",
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    },
  }).run();

  await nextTurn();
  send(firstTerminal, ":profile auto");
  await waitForOutput(firstTerminal, /profile auto: file read\/create\/edit enabled;/u);
  send(firstTerminal, "inspect and repair the Windows fixture");
  const createdOutput = await waitForOutput(firstTerminal, /created (task-[a-z0-9]+)/u);
  const taskId = createdOutput.match(/created (task-[a-z0-9]+)/u)?.[1];
  if (taskId === undefined) throw new Error("Windows journey task id was not projected.");
  await waitForOutput(firstTerminal, new RegExp(`${taskId} completed`, "u"));

  send(firstTerminal, ":changes");
  await waitForOutput(firstTerminal, new RegExp(`changed files: ${taskId}`, "u"));
  send(firstTerminal, ":diff");
  await waitForOutput(firstTerminal, /export const created = true;/u);
  send(firstTerminal, ":apply");
  await waitForOutput(firstTerminal, new RegExp(`applied ${taskId} to Local Workspace`, "u"));
  send(firstTerminal, ":quit");
  await firstRun;

  if (firstEngineCalls !== 1) throw new Error(`Unexpected first-run count: ${firstEngineCalls}`);
  if (
    (await readFile(path.join(workspace, "src", "value.ts"), "utf8")) !==
    "export const value: number = 2;\n"
  )
    throw new Error("Windows journey did not apply the edited file.");
  if (
    (await readFile(path.join(workspace, "src", "created.ts"), "utf8")) !==
    "export const created = true;\n"
  )
    throw new Error("Windows journey did not apply the created file.");
  if (runGit(workspace, ["rev-parse", "HEAD"]) !== beforeHead)
    throw new Error("The Windows journey created a commit.");
  if (runGit(workspace, ["write-tree"]) !== beforeTree)
    throw new Error("The Windows journey changed the Git index.");
  if (runGit(workspace, ["rev-list", "--count", "HEAD"]) !== beforeCommitCount)
    throw new Error("The Windows journey changed the commit count.");
  if (runGit(workspace, ["diff", "--cached"]) !== "")
    throw new Error("The Windows journey staged changes.");

  const secondTerminal = new FakeTerminal();
  let replayCalls = 0;
  const secondRun = new InteractiveTui({
    appDataRoot,
    workspacePath: workspace,
    terminal: secondTerminal,
    credentialStore: new InMemoryCredentialStore(),
    credentialEnvironment: {},
    engine: {
      async *runTurn() {
        replayCalls += 1;
        yield { type: "turn.started", taskId: "unexpected-replay" };
        throw new Error("Restart must not replay the completed prompt.");
      },
    },
  }).run();
  await nextTurn();
  send(secondTerminal, ":tasks");
  await waitForOutput(secondTerminal, new RegExp(`${taskId}.*completed`, "u"));
  send(secondTerminal, `:transcript ${taskId}`);
  await waitForOutput(secondTerminal, /windows journey completed/u);
  send(secondTerminal, ":quit");
  await secondRun;
  if (replayCalls !== 0) throw new Error("Restart replayed the completed prompt.");

  const store = new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
  const metadata = store.get(taskId);
  const transcript = store.transcript(taskId);
  store.close();
  if (metadata?.state !== "completed")
    throw new Error("Windows journey task was not persisted completed.");
  if (!transcript?.some((entry) => entry.role === "user" && entry.text.includes("Windows fixture")))
    throw new Error("Windows journey prompt was not persisted.");
  for (const marker of [
    "列出目录 · candy_list 完成",
    "读取文件 · candy_read 完成",
    "写入文件 · candy_write 完成",
    "编辑文件 · candy_edit 完成",
  ]) {
    if (!transcript?.some((entry) => entry.text.includes(marker)))
      throw new Error(`The Windows journey transcript lacks ${marker} tool evidence.`);
  }
  console.log(
    JSON.stringify({
      platform: process.platform,
      architecture: process.arch,
      taskId,
      applied: true,
      gitIndexUnchanged: true,
      commitUnchanged: true,
      restartReplayed: false,
      fixture: "deterministic-tui-boundary",
    }),
  );
} finally {
  await rm(journeyRoot, { recursive: true, force: true });
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    env: childEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function send(terminal, value) {
  terminal.emitInput(value);
  terminal.emitInput("\r");
}

async function nextTurn() {
  await new Promise((resolve) => globalThis.setImmediate(resolve));
}

async function waitForOutput(terminal, pattern) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const output = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for Windows TUI output: ${pattern}`);
}
