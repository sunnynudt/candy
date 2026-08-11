import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CandyPiSessionStore, PiAgentEngine } from "@candy/pi-adapter";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The Runtime session-remap smoke requires macOS arm64.");
}

const root = await mkdtemp(path.join(os.tmpdir(), "candy-runtime-session-remap-"));
const sessionRoot = path.join(root, "candy-app-data", "sessions");
const sourceWorkspace = path.join(root, "source-workspace");
const remappedWorkspace = path.join(root, "remapped-workspace");
const taskId = "task-session-remap";

try {
  await mkdir(sourceWorkspace, { recursive: true });
  await mkdir(remappedWorkspace, { recursive: true });
  const store = new CandyPiSessionStore(sessionRoot);
  const created = await store.create(taskId, sourceWorkspace);
  const originalContent = await readFile(created.sessionFile, "utf8");
  const header = JSON.parse(originalContent.split(/\r?\n/u, 1)[0]);
  if (header.type !== "session" || header.cwd !== sourceWorkspace) {
    throw new Error("Candy session did not persist the source workspace header.");
  }
  if (!created.sessionFile.startsWith(`${sessionRoot}${path.sep}`)) {
    throw new Error("Candy session escaped the Candy-owned app-data root.");
  }

  const engine = new PiAgentEngine(sessionRoot, async () => undefined);
  const recoveredPrompt = await engine.recoverPrompt(taskId, remappedWorkspace);
  if (recoveredPrompt !== "Candy Runtime proof session") {
    throw new Error("Runtime did not recover the persisted prompt after workspace remap.");
  }

  const reloaded = await store.reload(created, remappedWorkspace);
  if (reloaded.sessionFile !== created.sessionFile || reloaded.sessionId !== created.sessionId) {
    throw new Error("Workspace remap did not preserve the Candy session identity.");
  }
  if (reloaded.cwd !== remappedWorkspace) {
    throw new Error("Workspace remap did not select the receiving workspace.");
  }
  const remappedContent = await readFile(created.sessionFile, "utf8");
  if (remappedContent !== originalContent) {
    throw new Error("Workspace remap rewrote persisted session history.");
  }
  const sessionFiles = await readdir(path.dirname(created.sessionFile));
  if (sessionFiles.length !== 1) {
    throw new Error("Workspace remap created an unexpected second session file.");
  }
  console.log("macOS Runtime session-remap smoke ok: Candy session identity and history preserved");
} finally {
  await rm(root, { recursive: true, force: true });
}
