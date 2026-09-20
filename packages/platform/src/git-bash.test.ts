import assert from "node:assert/strict";
import test from "node:test";
import { discoverGitBashExecutable, GitBashDiscoveryError } from "./git-bash.js";

function fixtureFilesystem(files: readonly string[], directories: readonly string[] = []) {
  const fileSet = new Set(files.map((value) => value.toLowerCase()));
  const directorySet = new Set(directories.map((value) => value.toLowerCase()));
  return (candidate: string): "file" | "directory" | "missing" => {
    const normalized = candidate.toLowerCase();
    if (fileSet.has(normalized)) return "file";
    if (directorySet.has(normalized)) return "directory";
    return "missing";
  };
}

test("Git Bash discovery accepts a non-default Git installation selected by PATH", () => {
  const bash = "D:\\Developer Tools\\Git\\bin\\bash.exe";
  const probe = fixtureFilesystem(["D:\\Developer Tools\\Git\\cmd\\git.exe", bash]);

  assert.equal(
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: ["D:\\Developer Tools\\Git\\cmd"],
      registryInstallPaths: [],
      fileProbe: probe,
      canonicalize: (candidate) => candidate,
    }),
    bash,
  );
});

test("Git Bash discovery accepts registry installation metadata when PATH is unavailable", () => {
  const bash = "E:\\Git for Windows\\bin\\bash.exe";
  const probe = fixtureFilesystem([bash]);

  assert.equal(
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: [],
      registryInstallPaths: ["E:\\Git for Windows"],
      fileProbe: probe,
      canonicalize: (candidate) => candidate,
    }),
    bash,
  );
});

test("Git Bash discovery prefers the PATH-selected installation over other registry metadata", () => {
  const selected = "D:\\Selected Git\\bin\\bash.exe";
  const probe = fixtureFilesystem([
    "D:\\Selected Git\\cmd\\git.exe",
    selected,
    "C:\\Other Git\\bin\\bash.exe",
  ]);

  assert.equal(
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: ["D:\\Selected Git\\cmd"],
      registryInstallPaths: ["C:\\Other Git"],
      fileProbe: probe,
      canonicalize: (candidate) => candidate,
    }),
    selected,
  );
});

test("Git Bash discovery does not fall back to a POSIX shell on non-Windows", () => {
  const error = expectDiscoveryError(() => discoverGitBashExecutable({ platform: "darwin" }));
  assert.equal(error.failure, "missing");
});

test("Git Bash discovery rejects missing, non-file, and ambiguous candidates", () => {
  const missing = expectDiscoveryError(() =>
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: [],
      registryInstallPaths: [],
      fileProbe: () => "missing",
    }),
  );
  assert.equal(missing.failure, "missing");

  const invalid = expectDiscoveryError(() =>
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: ["C:\\Git\\cmd"],
      registryInstallPaths: [],
      fileProbe: fixtureFilesystem(["C:\\Git\\cmd\\git.exe"]),
      canonicalize: (candidate) => candidate,
    }),
  );
  assert.equal(invalid.failure, "invalid");

  const ambiguous = expectDiscoveryError(() =>
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: [],
      registryInstallPaths: ["C:\\Git One", "D:\\Git Two"],
      fileProbe: fixtureFilesystem(["C:\\Git One\\bin\\bash.exe", "D:\\Git Two\\bin\\bash.exe"]),
      canonicalize: (candidate) => candidate,
    }),
  );
  assert.equal(ambiguous.failure, "ambiguous");
});

function expectDiscoveryError(action: () => unknown): GitBashDiscoveryError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof GitBashDiscoveryError);
    return error;
  }
  assert.fail("Expected Git Bash discovery to fail.");
}

test("Git Bash discovery never accepts a relative or directory executable", () => {
  const error = expectDiscoveryError(() =>
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: [],
      registryInstallPaths: ["relative-git"],
      fileProbe: fixtureFilesystem([], ["C:\\Git\\bin\\bash.exe"]),
    }),
  );
  assert.equal(error.failure, "invalid");
});

test("Git Bash discovery rejects a Bash path redirected outside its Git installation", () => {
  const error = expectDiscoveryError(() =>
    discoverGitBashExecutable({
      platform: "win32",
      pathEntries: ["C:\\Git\\cmd"],
      registryInstallPaths: [],
      fileProbe: fixtureFilesystem([
        "C:\\Git\\cmd\\git.exe",
        "C:\\Git\\bin\\bash.exe",
        "C:\\Other\\bash.exe",
      ]),
      canonicalize: (candidate) =>
        candidate.toLowerCase() === "c:\\git\\bin\\bash.exe" ? "C:\\Other\\bash.exe" : candidate,
    }),
  );
  assert.equal(error.failure, "invalid");
});
