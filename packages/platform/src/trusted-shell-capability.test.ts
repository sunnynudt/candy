import assert from "node:assert/strict";
import test from "node:test";
import {
  getWindowsTrustedShellCapabilityStatus,
  isTrustedShellAutoAvailable,
  isWindowsTrustedShellAutoAvailable,
} from "./trusted-shell-capability.js";

test("Windows Trusted Shell rejects non-Windows and non-x64 hosts", () => {
  assert.equal(
    getWindowsTrustedShellCapabilityStatus({ platform: "darwin", architecture: "arm64" }).available,
    false,
  );
  assert.equal(
    getWindowsTrustedShellCapabilityStatus({ platform: "win32", architecture: "ia32" }).reason,
    "Windows Trusted Shell Auto requires an x64 host.",
  );
});

test("Windows Trusted Shell requires Git Bash and an accepted native containment gate", () => {
  const unavailable = getWindowsTrustedShellCapabilityStatus({
    platform: "win32",
    architecture: "x64",
    discoverBash: () => {
      throw new Error("missing fixture Bash");
    },
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, "Git for Windows Bash could not be validated.");

  const gated = getWindowsTrustedShellCapabilityStatus({
    platform: "win32",
    architecture: "x64",
    discoverBash: () => "D:\\Git\\bin\\bash.exe",
  });
  assert.equal(gated.available, false);
  assert.equal(gated.bashPath, "D:\\Git\\bin\\bash.exe");
  assert.match(gated.reason, /native workspace and network containment gate/u);
});

test("the production Windows gate cannot be enabled by host environment state", () => {
  assert.equal(isWindowsTrustedShellAutoAvailable(), false);
});

test("the production Trusted Shell gate stays closed until independent G2 approval", () => {
  assert.equal(isTrustedShellAutoAvailable(), false);
});
