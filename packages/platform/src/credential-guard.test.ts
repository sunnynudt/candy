import assert from "node:assert/strict";
import test from "node:test";
import {
  containsCredentialMaterial,
  isCodeLikeValue,
  redactCredentialMaterial,
} from "./credential-guard.js";

/*
 * Every credential-shaped or label-shaped fixture here is assembled from
 * fragments at runtime, so this file itself stays free of the shapes it tests.
 */
const bearer = (): string => ["Bea", "rer ", "a".repeat(24)].join("");
const prefixed = (): string => ["sk", "-", "b".repeat(24)].join("");
const protectedKey = (): string =>
  [
    "-----BEGIN ",
    "PRIVATE",
    " KEY-----\n",
    "c".repeat(32),
    "\n-----END ",
    "PRIVATE",
    " KEY-----",
  ].join("");
const dotted = (): string => ["eyJhbGciOiJIUzI1NiJ9", "d".repeat(12), "f".repeat(12)].join(".");
const label = (): string => ["api", "_key"].join("");
const labeled = (name: string, value: string): string => `${name} = ${value}`;
const labelRedaction = (): RegExp => new RegExp(`${label()} = \\[REDACTED\\]`, "u");

const codeSamples = (): readonly string[] => [
  "private readonly acquireSecretFn: (signal: AbortSignal) => Promise<string>,",
  'this.#secretValue = info.type === "api" + "_key" ? next.key : undefined;',
  ["return lease ? { sec", "ret: lease.value, release: lease.release } : undefined;"].join(""),
  ['type PiCredentialValue = Awaited<ReturnType<Contract["read"]>>;'].join(""),
  "return `http://${host}:${port}/?${ENTRY_QUERY_KEY}=${this.#authValue}`;",
  'const authValue = options.authValue ?? randomBytes(32).toString("base64url");',
  'if (containsCredentialMaterial(message)) throw new Error("forbidden");',
  ["      authoriz", "ation: `Bea${'rer'} ${lease.value}`,"].join(""),
];

test("unambiguous credential shapes stay detected and redacted", () => {
  for (const credential of [bearer(), prefixed(), protectedKey()]) {
    assert.equal(containsCredentialMaterial(credential), true);
    const redacted = redactCredentialMaterial(credential);
    assert.equal(redacted.includes(credential), false);
    assert.match(redacted, /\[REDACTED\]/u);
  }
  const inlineUserInfo = ["https://user:", "p".repeat(12), "@example.invalid/x"].join("");
  assert.equal(containsCredentialMaterial(inlineUserInfo), true);
  assert.match(
    redactCredentialMaterial(inlineUserInfo),
    /^https:\/\/\[REDACTED\]example\.invalid/u,
  );
});

test("labeled values are credential material only when they look like data", () => {
  assert.equal(containsCredentialMaterial(labeled(label(), `"${"d".repeat(24)}"`)), true);
  assert.equal(
    containsCredentialMaterial(labeled("password", ["hunter2", "hunter2"].join(""))),
    true,
  );
  assert.equal(containsCredentialMaterial(labeled("token", dotted())), true);
  assert.match(redactCredentialMaterial(labeled(label(), `"${"d".repeat(24)}"`)), labelRedaction());
});

test("credential-handling source code is not credential material", () => {
  for (const sample of codeSamples()) {
    assert.equal(containsCredentialMaterial(sample), false, sample);
    assert.equal(redactCredentialMaterial(sample), sample);
  }
});

test("active provider secrets are always redacted", () => {
  const activeValue = ["local", "placeholder", "value"].join("-");
  const message = `request failed with ${activeValue} attached`;
  assert.equal(containsCredentialMaterial(message, [activeValue]), true);
  assert.equal(redactCredentialMaterial(message, [activeValue]).includes(activeValue), false);
});

test("isCodeLikeValue classifies syntax, references, and data", () => {
  assert.equal(isCodeLikeValue("(signal: AbortSignal) => Promise<string>"), true);
  assert.equal(isCodeLikeValue("lease.value"), true);
  assert.equal(isCodeLikeValue("Awaited<ReturnType<X>>"), true);
  assert.equal(isCodeLikeValue("undefined"), true);
  assert.equal(isCodeLikeValue('"abcdefgh"'), false);
  assert.equal(isCodeLikeValue(dotted()), false);
  assert.equal(isCodeLikeValue(["hunter2", "hunter2"].join("")), false);
});
