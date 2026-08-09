import assert from "node:assert/strict";
import test from "node:test";
import { classifyWindowClose, redactRendererText } from "./contracts.js";

test("desktop close behavior distinguishes tray close from explicit quit", () => {
  assert.equal(classifyWindowClose(false), "hide-to-tray");
  assert.equal(classifyWindowClose(true), "quit-and-cancel");
});

test("renderer projection redacts complete credentials", () => {
  assert.equal(redactRendererText("safe fixture-secret", ["fixture-secret"]), "safe [REDACTED]");
});
