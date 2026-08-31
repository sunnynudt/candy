import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { AttachmentStore } from "@candy/runtime";
import { cleanChildEnvironment, resolveDefaultAppDataRoot } from "@candy/platform";

if (process.platform !== "win32") {
  console.log("Windows attachment recovery smoke skipped: not Windows");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appServer = path.join(root, "apps", "app-server", "dist", "main.js");
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-attachment-recovery-windows-"));
const workspace = path.join(fixtureRoot, "workspace");
const localAppData = path.join(fixtureRoot, "local-app-data");
const taskId = "windows-attachment-recovery";
await mkdir(workspace);

function command(commandId, expectedRevision, value) {
  return {
    v: 1,
    kind: "command",
    commandId,
    taskId,
    expectedRevision,
    command: value,
  };
}

async function startServer() {
  const environment = cleanChildEnvironment(process.env);
  environment.LOCALAPPDATA = localAppData;
  environment.APPDATA = localAppData;
  environment.CANDY_DETERMINISTIC_RECOVERY_SMOKE = "1";
  const child = spawn(process.execPath, [appServer], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return {
    child,
    lines,
  };
}

async function waitForSnapshot(server, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error("Windows attachment recovery did not emit the expected snapshot."));
    }, 10_000);
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        const snapshot =
          parsed.kind === "event" && parsed.event?.type === "snapshot"
            ? parsed.event.snapshot
            : undefined;
        if (snapshot !== undefined && predicate(snapshot)) {
          globalThis.clearTimeout(timeout);
          server.lines.off("line", onLine);
          resolve(snapshot);
        }
      } catch {
        // Ignore unrelated diagnostics; the protocol assertion remains JSONL-only.
      }
    };
    server.lines.on("line", onLine);
  });
}

async function stopServer(server) {
  server.lines.close();
  server.child.stdin.end();
  await new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      server.child.kill();
      resolve();
    }, 2_000);
    server.child.once("exit", () => {
      globalThis.clearTimeout(timeout);
      resolve();
    });
  });
}

try {
  const appDataRoot = resolveDefaultAppDataRoot("win32", {
    LOCALAPPDATA: localAppData,
    APPDATA: localAppData,
  });
  const attachmentStore = new AttachmentStore(path.join(appDataRoot, "attachments"));
  const attachment = await attachmentStore.put(
    "image",
    "image/png",
    Buffer.from("windows-restart-image-fixture"),
  );

  const first = await startServer();
  try {
    const createdPromise = waitForSnapshot(first, (snapshot) => snapshot.state === "queued");
    first.child.stdin.write(
      `${JSON.stringify(
        command("attachment-create", 0, {
          type: "task.create",
          prompt: "Windows attachment restart fixture",
          approvalProfile: "read-only",
          workspacePath: workspace,
          model: "MiniMax-M3",
          attachmentIds: [attachment.id],
        }),
      )}\n`,
    );
    const created = await createdPromise;
    assert.deepEqual(created.attachmentIds, [attachment.id]);
  } finally {
    await stopServer(first);
  }

  assert.equal((await attachmentStore.getImagePayload(attachment.id)).data.length > 0, true);

  const second = await startServer();
  try {
    const restoredPromise = waitForSnapshot(second, (snapshot) => snapshot.state === "queued");
    second.child.stdin.write(
      `${JSON.stringify(command("attachment-snapshot", 0, { type: "snapshot" }))}\n`,
    );
    const restored = await restoredPromise;
    assert.deepEqual(restored.attachmentIds, [attachment.id]);

    const completedPromise = waitForSnapshot(second, (snapshot) => snapshot.state === "completed");
    second.child.stdin.write(
      `${JSON.stringify(command("attachment-run", 0, { type: "task.run" }))}\n`,
    );
    const completed = await completedPromise;
    assert.deepEqual(completed.attachmentIds, [attachment.id]);
  } finally {
    await stopServer(second);
  }

  console.log(
    "Windows attachment recovery smoke passed: persisted image attachment resolved after app-server restart",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
