import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import { AttachmentStore } from "@candy/runtime";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The real TUI journey requires macOS arm64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journeyRoot = await mkdtemp(path.join(os.tmpdir(), "candy-tui-pty-"));
const workspace = path.join(journeyRoot, "workspace");
const appDataRoot = path.join(journeyRoot, "app-data");
const temporaryRoot = path.join(journeyRoot, "tmp");
const imagePath = path.join(journeyRoot, "fixture.png");
const outsideSentinel = path.join(journeyRoot, "outside-sentinel.txt");
const ptyLog = path.join(journeyRoot, "pty.log");
const resultPath = path.join(journeyRoot, "result.txt");
const childPath = path.join(root, "scripts", "tui-journey-child.mjs");
const expectPath = "/usr/bin/expect";
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const expectedAttachmentId = `att_${digest(imageBytes)}`;
const syntheticSecretCanary = "CANDY_PTY_SYNTHETIC_SECRET_CANARY_7f0b3c6a";
const nativeRunnerPath = path.join(
  root,
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner",
);
const environment = {
  ...cleanChildEnvironment(process.env),
  CANDY_APP_DATA_ROOT: appDataRoot,
  CANDY_SANDBOX_RUNNER: nativeRunnerPath,
  CANDY_JOURNEY_CHILD: childPath,
  CANDY_JOURNEY_EXPECTED_ATTACHMENT: expectedAttachmentId,
  CANDY_JOURNEY_IMAGE: imagePath,
  CANDY_JOURNEY_NODE: process.execPath,
  CANDY_JOURNEY_PTY_LOG: ptyLog,
  CANDY_JOURNEY_RESULT: resultPath,
  CANDY_JOURNEY_WORKSPACE: workspace,
  HOME: path.join(journeyRoot, "home"),
  TMPDIR: temporaryRoot,
  TERM: "xterm-256color",
};

const initialValue = "export const value: number = 1;\n";
const outsideBefore = "outside fixture remains unchanged\n";

await mkdir(path.join(workspace, "src"), { recursive: true });
await mkdir(temporaryRoot, { recursive: true });
await writeFile(path.join(workspace, "src", "value.ts"), initialValue, "utf8");
await writeFile(path.join(workspace, "remove-deny.txt"), "keep after denial\n", "utf8");
await writeFile(path.join(workspace, "remove-approve.txt"), "delete after approval\n", "utf8");
await writeFile(imagePath, imageBytes);
await writeFile(outsideSentinel, outsideBefore, "utf8");
execFileSync("git", ["init", "-q", workspace], { env: environment });
execFileSync("git", ["-C", workspace, "config", "user.email", "candy-tui@example.invalid"], {
  env: environment,
});
execFileSync("git", ["-C", workspace, "config", "user.name", "Candy TUI Fixture"], {
  env: environment,
});
execFileSync(
  "git",
  ["-C", workspace, "add", "src/value.ts", "remove-deny.txt", "remove-approve.txt"],
  {
    env: environment,
  },
);
execFileSync("git", ["-C", workspace, "commit", "-qm", "journey baseline"], {
  env: environment,
});

const beforeHead = gitCapture(["-C", workspace, "rev-parse", "HEAD"]);
const beforeTree = gitCapture(["-C", workspace, "write-tree"]);
const beforeCommitCount = gitCapture(["-C", workspace, "rev-list", "--count", "HEAD"]);
const outsideDigest = digest(await readFile(outsideSentinel));

try {
  await runExpect();
  const result = parseResult(await readFile(resultPath, "utf8"));
  const taskId = result.task_id;
  const attachmentId = result.attachment_id;
  const validatorStatus = result.validator_status;
  if (!/^task-[a-z0-9]+$/u.test(taskId)) throw new Error("Journey task id is invalid.");
  if (!/^att_[a-f0-9]{64}$/u.test(attachmentId))
    throw new Error("Journey attachment id is invalid.");
  if (validatorStatus !== "pass" && validatorStatus !== "blocked")
    throw new Error(`Unexpected validator status: ${validatorStatus}`);

  const value = await readFile(path.join(workspace, "src", "value.ts"), "utf8");
  if (value !== "export const value: number = 3;\n")
    throw new Error("Final edit was not persisted.");
  if (
    (await readFile(path.join(workspace, "src", "created.ts"), "utf8")) !==
    "export const created = true;\n"
  )
    throw new Error("Created file was not persisted.");
  if ((await readFile(path.join(workspace, "remove-deny.txt"), "utf8")) !== "keep after denial\n")
    throw new Error("Denied deletion did not preserve its target.");
  await assertMissing(path.join(workspace, "remove-approve.txt"));

  const afterHead = gitCapture(["-C", workspace, "rev-parse", "HEAD"]);
  const afterTree = gitCapture(["-C", workspace, "write-tree"]);
  const afterCommitCount = gitCapture(["-C", workspace, "rev-list", "--count", "HEAD"]);
  if (afterHead !== beforeHead || afterCommitCount !== beforeCommitCount)
    throw new Error("The TUI journey created a commit.");
  if (afterTree !== beforeTree) throw new Error("The TUI journey changed the Git index.");
  if (gitCapture(["-C", workspace, "diff", "--cached"]) !== "")
    throw new Error("The TUI journey staged changes.");
  if (digest(await readFile(outsideSentinel)) !== outsideDigest)
    throw new Error("A workspace-external sentinel changed.");

  const store = new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
  const metadata = store.get(taskId);
  const transcript = store.transcript(taskId);
  const run = store.getRun(taskId);
  if (metadata?.state !== "completed") throw new Error("The task did not recover as completed.");
  if (metadata.model !== "MiniMax-M3") throw new Error("The task model was not persisted.");
  if (metadata.approvalProfile !== "auto") throw new Error("The Auto profile was not persisted.");
  if (metadata.attachmentIds.length !== 1 || metadata.attachmentIds[0] !== attachmentId)
    throw new Error("The attachment id was not persisted.");
  if (metadata.validator?.executable !== "/usr/bin/true")
    throw new Error("The explicit validator was not persisted.");
  if (
    !transcript?.some(
      (entry) => entry.role === "user" && entry.text === "inspect and repair the fixture",
    )
  )
    throw new Error("The first prompt was not restored.");
  if (
    !transcript?.some(
      (entry) => entry.role === "user" && entry.text === "repair the remaining fixture",
    )
  )
    throw new Error("The second prompt was not restored.");
  if (!transcript?.some((entry) => entry.text.includes("fixture turn 1")))
    throw new Error("The first assistant transcript was not restored.");
  if (!transcript?.some((entry) => entry.text.includes("fixture turn 2")))
    throw new Error("The second assistant transcript was not restored.");
  if (!transcript?.some((entry) => entry.text.includes("candy_list:ok")))
    throw new Error("The list tool result was not persisted.");
  if (!transcript?.some((entry) => entry.text.includes("candy_delete:error")))
    throw new Error("The denied delete result was not persisted.");
  if (!transcript?.some((entry) => entry.text.includes("candy_delete:ok")))
    throw new Error("The approved delete result was not persisted.");
  if (validatorStatus === "pass" && run?.stopReason !== "validator_succeeded")
    throw new Error("The validator pass was not persisted.");
  store.close();

  const attachment = await new AttachmentStore(resolveAppPaths(appDataRoot).attachments).get(
    attachmentId,
  );
  if (
    attachment.metadata.mimeType !== "image/png" ||
    Buffer.compare(attachment.content, imageBytes) !== 0
  )
    throw new Error("The persisted image attachment was not restored.");

  const ptyOutput = await readFile(ptyLog);
  assertNoSensitiveJourneyData(ptyOutput, await collectFiles(appDataRoot), syntheticSecretCanary);
  if (!ptyOutput.includes("\u001b[?1049h") || !ptyOutput.includes("\u001b[?1049l"))
    throw new Error("Alternate-screen enter/exit was not observed.");
  if (!ptyOutput.includes("\u001b[?25l") || !ptyOutput.includes("\u001b[?25h"))
    throw new Error("Cursor hide/show restoration was not observed.");
  const diff = execFileSync("git", ["-C", workspace, "diff", "--", "."], {
    env: environment,
    encoding: "utf8",
  });
  assertNoSensitiveJourneyData(Buffer.from(diff), [], syntheticSecretCanary);

  console.log(
    JSON.stringify({
      architecture: process.arch,
      macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
      taskId,
      model: metadata.model,
      attachmentId,
      validator: validatorStatus,
      transcriptEntries: transcript.length,
      gitIndexUnchanged: afterTree === beforeTree,
      commitUnchanged: afterHead === beforeHead,
      alternateScreenRestored: true,
      cursorRestored: true,
      fixture: "deterministic",
    }),
  );
} finally {
  await rm(journeyRoot, { recursive: true, force: true });
}

async function runExpect() {
  await new Promise((resolve, reject) => {
    const child = execFile(
      expectPath,
      ["-f", path.join(root, "scripts", "smoke-tui-journey-macos.exp")],
      {
        cwd: root,
        env: environment,
        maxBuffer: 64 * 1024,
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`expect exited ${code ?? "null"}/${signal ?? "none"}: ${stderr.trim()}`));
    });
  });
}

function gitCapture(args) {
  return execFileSync("git", args, { cwd: root, env: environment, encoding: "utf8" }).trim();
}

function parseResult(value) {
  return Object.fromEntries(
    value
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Journey result is malformed.");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function assertMissing(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Expected deleted file to be absent: ${path.basename(filePath)}`);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function assertNoSensitiveJourneyData(ptyOutput, appDataFiles, syntheticSecret) {
  const values = [
    ptyOutput,
    ...(await Promise.all(appDataFiles.map((filePath) => readFile(filePath)))),
  ];
  const credentialPattern =
    /Bearer\s+[A-Za-z0-9._~+/=-]{16,}|\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/iu;
  if (
    values.some(
      (value) =>
        credentialPattern.test(value.toString("utf8")) ||
        value.toString("utf8").includes(syntheticSecret),
    )
  )
    throw new Error("Credential-shaped content entered TUI journey evidence.");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
