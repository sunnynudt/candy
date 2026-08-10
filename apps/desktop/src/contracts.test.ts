import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkspacePath,
  assertValidatorSpec,
  classifyWindowClose,
  isAbsoluteWorkspacePath,
  redactRendererText,
} from "./contracts.js";

test("desktop close behavior distinguishes tray close from explicit quit", () => {
  assert.equal(classifyWindowClose(false), "hide-to-tray");
  assert.equal(classifyWindowClose(true), "quit-and-cancel");
});

test("renderer projection redacts complete credentials", () => {
  assert.equal(redactRendererText("safe fixture-secret", ["fixture-secret"]), "safe [REDACTED]");
});

test("workspace contract accepts platform absolute paths and rejects escapes", () => {
  assert.equal(isAbsoluteWorkspacePath("/Users/test/project"), true);
  assert.equal(isAbsoluteWorkspacePath("C:\\Users\\test\\project"), true);
  assert.equal(isAbsoluteWorkspacePath("relative/project"), false);
  assert.doesNotThrow(() => assertWorkspacePath("/Users/test/project"));
  assert.throws(() => assertWorkspacePath("relative/project"), /absolute/u);
});

test("desktop validator contract accepts an explicit absolute executable without secrets", () => {
  assert.doesNotThrow(() => assertValidatorSpec({ executable: "/usr/bin/env", args: ["true"] }));
  assert.throws(() => assertValidatorSpec({ executable: "npm", args: ["test"] }), /absolute/u);
  assert.throws(
    () => assertValidatorSpec({ executable: "/usr/bin/env", args: ["Bearer sk-fixture-secret"] }),
    /invalid/u,
  );
});
