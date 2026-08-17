import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("Windows TUI terminal matrix skipped: not Windows x64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixRoot = await mkdtemp(path.join(os.tmpdir(), "candy-tui-terminal-matrix-"));
const child = path.join(root, "scripts", "tui-terminal-matrix-child.mjs");
const ptyHost = path.join(root, "scripts", "pty-host.ps1");
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
      TMP: path.join(matrixRoot, mode, "tmp"),
      TEMP: path.join(matrixRoot, mode, "tmp"),
      TERM: "xterm-256color",
      ...(mode === "startup-failure" ? { PI_TUI_DEBUG: "1" } : {}),
    };
    await mkdir(environment.TMP, { recursive: true });
    try {
      await runConPty(root, environment, mode);
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
      results.normalInputPaste = true;
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
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    npm: execFileSync(process.execPath, [process.env.npm_execpath, "--version"], {
      encoding: "utf8",
    }).trim(),
    realPty: true,
    conpty: true,
    terminalMatrix: results,
  };
  console.log(JSON.stringify(evidence));
} catch (error) {
  await rmRetry(matrixRoot).catch(() => undefined);
  throw error;
}
await rmRetry(matrixRoot);

async function rmRetry(directory) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

async function runConPty(cwd, env, mode) {
  const spec = {
    exe: env.CANDY_TERMINAL_MATRIX_NODE,
    args: [env.CANDY_TERMINAL_MATRIX_CHILD],
    cwd,
    cols: 120,
    rows: 30,
    logFile: env.CANDY_TERMINAL_MATRIX_PTY_LOG,
    env: {},
  };
  const childProcess = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ptyHost],
    {
      cwd,
      env: { ...env, CONPTY_SPEC: JSON.stringify(spec) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
    },
  );
  const output = [];
  childProcess.stdout.on("data", (chunk) => {
    output.push(chunk.toString("utf8"));
  });
  const stderr = [];
  childProcess.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exited = new Promise((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code, signal) =>
      resolve({ code, signal, stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
  const write = (data) => childProcess.stdin.write(data);

  if (mode === "startup-failure") {
    const exit = await waitExit(exited);
    if (exit.code === 0) throw new Error(`startup-failure fixture exited ${exit.code}`);
    return;
  }
  try {
    await driveMatrixInteraction(childProcess, output, write, mode);
    const exit = await waitExit(exited);
    if (exit.code !== 0)
      throw new Error(`conpty child exited ${exit.code}/${exit.signal}: ${exit.stderr}`);
  } catch (error) {
    await killProcessTree(childProcess.pid ?? 0);
    throw error;
  }
}

async function driveMatrixInteraction(childProcess, output, write, mode) {
  await waitForOutput(output, /Candy TUI/u, 30000, "TUI startup");
  if (mode === "normal") {
    write("中文输入测试\r");
    await waitForOutput(output, /terminal-matrix-first-ok/u, 30000, "Chinese input task");
    write(":new\r");
    await waitForOutput(output, /new task ready/u, 30000, "paste task");
    write("\u001b[200~粘贴内容\n第二行\u001b[201~\r");
    await waitForOutput(output, /terminal-matrix-paste-ok/u, 30000, "bracketed paste task");
    write(":quit\r");
  } else if (mode === "runtime-failure") {
    write("runtime failure fixture\r");
    await waitForOutput(
      output,
      /interrupted: workspace runtime failure fixture/u,
      30000,
      "runtime failure recovery",
    );
    write(":quit\r");
  } else if (mode === "cancel") {
    write("cancel fixture\r");
    await waitForOutput(
      output,
      /created task-[a-z0-9]+ \(queued\)/u,
      30000,
      "cancel task creation",
    );
    write("\u0003");
  } else {
    throw new Error(`unknown terminal matrix mode: ${mode}`);
  }
}

function waitForOutput(output, pattern, timeoutMs, description) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "u");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const text = output.join("");
      if (regex.test(text)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${description}; output tail: ${text.slice(-500)}`));
      }
    }, 50);
  });
}

function waitExit(exited) {
  return Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("conpty child did not exit")), 30000),
    ),
  ]);
}

async function killProcessTree(pid) {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // best effort
  }
}

function gitCapture(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
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
