import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("Windows real DeepSeek TUI journey skipped: not Windows x64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journeyRoot = await mkdtemp(path.join(os.tmpdir(), "candy-real-journey-"));
const workspace = path.join(journeyRoot, "workspace with spaces");
const appDataRoot = path.join(journeyRoot, "app-data");
const ptyLog = path.join(journeyRoot, "journey.pty.log");
const childPath = path.join(root, "scripts", "trusted-shell-journey-child.mjs");
const environment = {
  ...cleanChildEnvironment(process.env),
  CANDY_APP_DATA_ROOT: appDataRoot,
  CANDY_JOURNEY_WORKSPACE: workspace,
  TERM: "xterm-256color",
};

try {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "src", "value.ts"),
    "export const value: number = 1;\n",
    "utf8",
  );

  await runJourney();
  const valueContent = await readFile(path.join(workspace, "src", "value.ts"), "utf8");
  if (valueContent !== "export const value: number = 2;\n")
    throw new Error(`Real journey did not update value.ts: ${JSON.stringify(valueContent)}`);

  const store = new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
  const tasks = store.list();
  store.close();
  if (tasks.length !== 1 || tasks[0]?.state !== "completed")
    throw new Error(`Real journey task state mismatch: ${JSON.stringify(tasks)}`);

  const credentialFree = await scanFiles(journeyRoot);
  const evidence = {
    sourceRevision: runGit(root, ["rev-parse", "HEAD"]),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    npm: execFileSync(process.execPath, [process.env.npm_execpath, "--version"], {
      encoding: "utf8",
    }).trim(),
    realProvider: "deepseek",
    realPty: true,
    conpty: true,
    workspaceMutation: true,
    taskCompleted: true,
    credentialFree,
  };
  console.log(JSON.stringify(evidence));
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\nPTY log:\n${await readFile(ptyLog, "utf8").catch(() => "<missing>")}`,
    { cause: error },
  );
} finally {
  await rmRetry(journeyRoot);
}

async function runJourney() {
  const spec = {
    exe: process.execPath,
    args: [childPath],
    cwd: journeyRoot,
    cols: 120,
    rows: 30,
    logFile: ptyLog,
    env: {},
  };
  const childProcess = spawn(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "pty-host.ps1"),
    ],
    {
      cwd: root,
      env: { ...environment, CONPTY_SPEC: JSON.stringify(spec) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
    },
  );
  const output = [];
  childProcess.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const stderr = [];
  childProcess.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exited = new Promise((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code, signal) =>
      resolve({ code, signal, stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
  const write = (data) => childProcess.stdin.write(data);

  try {
    await waitForOutput(output, /Candy TUI/u, 60000, "TUI startup");
    write(":profile auto\r");
    await waitForOutput(output, /profile.*auto|auto.*enabled/iu, 30000, "auto profile");
    write(
      "Use the candy_write tool to set the file src/value.ts to exactly `export const value: number = 2;` on one line with a trailing newline. Do not modify any other file and do not run shell commands.\r",
    );
    await waitForOutput(output, /completed/u, 180000, "real DeepSeek turn completion");
    write(":changes\r");
    await waitForOutput(output, /src[\\/]value\.ts|changed|modified/iu, 30000, "changes listing");
    write(":diff\r");
    await waitForOutput(output, /export const value: number = 2/iu, 30000, "diff content");
    write(":quit\r");
    const exit = await waitExit(exited, 30000);
    if (exit.code !== 0)
      throw new Error(`real journey child exited ${exit.code}/${exit.signal}: ${exit.stderr}`);
  } catch (error) {
    await killProcessTree(childProcess.pid ?? 0);
    throw error;
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
    }, 100);
  });
}

function waitExit(exited, timeoutMs) {
  return Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("real journey child did not exit")), timeoutMs),
    ),
  ]);
}

async function killProcessTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // best effort
  }
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
