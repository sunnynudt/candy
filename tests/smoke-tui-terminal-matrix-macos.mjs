import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("macOS TUI terminal matrix skipped: not macOS arm64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixRoot = await mkdtemp(path.join(os.tmpdir(), "candy-tui-terminal-matrix-"));
const child = path.join(root, "tests", "tui-terminal-matrix-child.mjs");
const expectScript = path.join(root, "tests", "smoke-tui-terminal-matrix-macos.exp");
const results = {};

try {
  for (const mode of ["normal", "runtime-failure", "cancel", "startup-failure"]) {
    const appDataRoot = path.join(matrixRoot, mode, "app-data");
    const workspace = path.join(matrixRoot, mode, "workspace");
    const ptyLog = path.join(matrixRoot, `${mode}.pty.log`);
    await mkdir(workspace, { recursive: true });
    const environment = {
      ...cleanChildEnvironment(process.env),
      CANDY_TERMINAL_MATRIX_APP_DATA_ROOT: appDataRoot,
      CANDY_TERMINAL_MATRIX_CHILD: child,
      CANDY_TERMINAL_MATRIX_LAUNCH_DIR: matrixRoot,
      CANDY_TERMINAL_MATRIX_MODE: mode,
      CANDY_TERMINAL_MATRIX_NODE: process.execPath,
      CANDY_TERMINAL_MATRIX_PTY_LOG: ptyLog,
      CANDY_TERMINAL_MATRIX_WORKSPACE: workspace,
      HOME: process.env.HOME ?? os.homedir(),
      TMPDIR: path.join(matrixRoot, mode, "tmp"),
      TERM: "xterm-256color",
      ...(mode === "startup-failure" ? { PI_TUI_DEBUG: "1" } : {}),
    };
    await mkdir(environment.TMPDIR, { recursive: true });
    try {
      await runExpect(expectScript, root, environment);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nPTY log:\n${await readFile(ptyLog, "utf8").catch(() => "<missing>")}`,
        { cause: error },
      );
    }
    const store = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    const tasks = store.list();
    store.close();
    if (mode === "normal") {
      if (tasks.length !== 2 || tasks.some((task) => task.state !== "completed"))
        throw new Error(
          `Normal terminal matrix tasks did not complete: ${JSON.stringify(tasks)}\nPTY log:\n${await readFile(ptyLog, "utf8").catch(() => "<missing>")}`,
        );
      const log = await readFile(ptyLog, "utf8");
      if (!log.includes("terminal-matrix-first-ok") || !log.includes("terminal-matrix-paste-ok"))
        throw new Error("Normal terminal matrix output was missing.");
      results.normalInputPasteResize = true;
    } else if (mode === "startup-failure") {
      if (tasks.length !== 0)
        throw new Error("Startup-failure matrix unexpectedly created a task.");
      results.startupFailure = true;
    } else {
      if (tasks.length !== 1 || tasks[0]?.state !== "interrupted")
        throw new Error(`${mode} terminal matrix task was not interrupted safely.`);
      results[mode === "cancel" ? "ctrlC" : "runtimeFailure"] = true;
    }
    results[`${mode}CredentialFree`] = await scanFiles(path.join(matrixRoot, mode));
  }
  const evidence = {
    sourceRevision: gitCapture(["rev-parse", "HEAD"]),
    macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    architecture: process.arch,
    node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    realPty: true,
    terminalMatrix: results,
  };
  console.log(JSON.stringify(evidence));
} finally {
  await rm(matrixRoot, { recursive: true, force: true });
}

function gitCapture(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function runExpect(script, cwd, env) {
  await new Promise((resolve, reject) => {
    const childProcess = execFile("/usr/bin/expect", ["-f", script], {
      cwd,
      env,
      maxBuffer: 128 * 1024,
    });
    const stderr = [];
    childProcess.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    childProcess.once("error", reject);
    childProcess.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `expect exited ${code ?? "null"}/${signal ?? "none"}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
    });
  });
}

async function scanFiles(directory) {
  const files = [];
  await collect(directory, files);
  const content = Buffer.concat(await Promise.all(files.map((file) => readFile(file)))).toString(
    "utf8",
  );
  return !/Bearer\s+[A-Za-z0-9._~+/=-]{16,}|\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/iu.test(
    content,
  );
}

async function collect(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(entryPath, files);
    else if (entry.isFile()) files.push(entryPath);
  }
}
