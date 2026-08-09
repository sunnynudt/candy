import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ApplyChangesGuard,
  AttachmentStore,
  ApprovalPolicy,
  BrowserControlError,
  BrowserRevisionError,
  FixedValidator,
  InMemoryBrowserWorkspace,
  LongRunningTaskRunner,
  ProviderConcurrencyGate,
  SerialMutationLane,
} from "./v1.js";

test("approval policy keeps read-only strict and shell unavailable before native G2", () => {
  const readOnly = new ApprovalPolicy("read-only");
  assert.equal(
    readOnly.decide({
      kind: "workspace.read",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: false,
    }),
    "allow",
  );
  assert.equal(
    readOnly.decide({
      kind: "workspace.write",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "deny",
  );
  assert.equal(
    readOnly.decide({
      kind: "shell",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "unsupported",
  );
  const auto = new ApprovalPolicy("auto");
  assert.equal(
    auto.decide({
      kind: "shell",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "unsupported",
  );
  assert.equal(
    auto.decide({
      kind: "git.publish",
      network: true,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "require_approval",
  );
});

test("mutation lane serializes writes and provider gates are independent", async () => {
  const lane = new SerialMutationLane();
  const order: string[] = [];
  await Promise.all([
    lane.run(async () => {
      order.push("a-start");
      await Promise.resolve();
      order.push("a-end");
    }),
    lane.run(async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  const deepseek = new ProviderConcurrencyGate("deepseek", 1);
  let release!: () => void;
  const first = deepseek.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const second = deepseek.run(async () => "second");
  await Promise.resolve();
  assert.equal(deepseek.active, 1);
  release();
  await first;
  assert.equal(await second, "second");
});

test("attachment store hashes image bytes, keeps binary outside session, and rejects video", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-attachments-"));
  const store = new AttachmentStore(root, () => 100);
  const metadata = await store.put("image", "image/png", new TextEncoder().encode("image-fixture"));
  assert.equal(metadata.id.length, 68);
  assert.equal((await store.get(metadata.id)).metadata.sha256, metadata.sha256);
  await assert.rejects(store.put("video", "video/mp4", new Uint8Array([1])), /unavailable/u);
  assert.equal(await store.cleanupBefore(101), 1);
});

test("browser state rejects stale revisions, disallowed sites, sensitive actions, and honors Take Control", () => {
  const browser = new InMemoryBrowserWorkspace();
  const tab = browser.open("https://fixture.invalid");
  assert.throws(
    () => browser.act(tab.tabId, { type: "click", target: "#x", expectedRevision: 1 }),
    BrowserControlError,
  );
  browser.allowSite("fixture.invalid");
  const allowed = browser.open("https://fixture.invalid");
  assert.throws(
    () => browser.act(allowed.tabId, { type: "click", target: "#x", expectedRevision: 0 }),
    BrowserRevisionError,
  );
  assert.throws(
    () =>
      browser.act(allowed.tabId, {
        type: "submit",
        target: "#x",
        expectedRevision: allowed.revision,
        confirmed: false,
      }),
    BrowserControlError,
  );
  const user = browser.takeControl(allowed.tabId);
  assert.equal(user.control, "user");
  assert.throws(
    () =>
      browser.act(allowed.tabId, { type: "click", target: "#x", expectedRevision: user.revision }),
    BrowserControlError,
  );
});

test("long-running tasks complete only on validator success and stop stalled evidence", async () => {
  const signal = new AbortController().signal;
  const failing = new FixedValidator({
    ok: false,
    fingerprint: "same",
    evidence: "fail",
    durationMs: 1,
  });
  const stalled = await new LongRunningTaskRunner(5, 2).run(async () => undefined, failing, signal);
  assert.deepEqual(stalled.stopReason, "stall_detected");
  const successResult = { ok: true, fingerprint: "pass", evidence: "pass", durationMs: 1 } as const;
  const success = new FixedValidator(successResult);
  const completed = await new LongRunningTaskRunner(5).run(async () => undefined, success, signal);
  assert.deepEqual(completed, {
    completed: true,
    stopReason: "validator_succeeded",
    rounds: 1,
    evidence: [successResult],
  });
});

test("Apply Changes guard fails closed for dirty, changed-base, escaped, and secret-containing patches", () => {
  const guard = new ApplyChangesGuard("C:/workspace");
  const base = {
    targetIsGit: true,
    targetClean: true,
    expectedBase: "a",
    actualBase: "a",
    paths: ["src/a.ts"],
    patchText: "safe",
    activeSecrets: [],
  } as const;
  assert.equal(guard.check(base), "allow");
  assert.equal(guard.check({ ...base, targetClean: false }), "blocked");
  assert.equal(guard.check({ ...base, actualBase: "b" }), "blocked");
  assert.equal(guard.check({ ...base, paths: ["../secret"] }), "blocked");
  assert.equal(guard.check({ ...base, patchText: "canary", activeSecrets: ["canary"] }), "blocked");
});
