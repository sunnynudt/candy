import assert from "node:assert/strict";
import { KeyringCredentialStore } from "@candy/platform";

if (process.platform !== "win32") {
  console.log("Windows Credential Manager smoke skipped: not Windows");
  process.exit(0);
}

const store = new KeyringCredentialStore();
const fixtureValues = [
  "candy-windows-credential-fixture-one",
  "candy-windows-credential-fixture-two",
];
const rows = [];

for (const name of ["deepseek", "minimax-cn"]) {
  const before = store.has(name);
  if (before === "present") {
    rows.push(`${name}: before=present untouched=true`);
    continue;
  }

  let fixtureWritten = false;
  try {
    store.set(name, fixtureValues[0]);
    fixtureWritten = true;
    const afterSet = store.has(name);
    store.replace(name, fixtureValues[1]);
    const afterReplace = store.has(name);
    store.delete(name);
    const afterDelete = store.has(name);
    assert.deepEqual(
      { before, afterSet, afterReplace, afterDelete },
      { before: "absent", afterSet: "present", afterReplace: "present", afterDelete: "absent" },
    );
    rows.push(`${name}: absent->present->present->absent`);
    fixtureWritten = false;
  } finally {
    if (fixtureWritten && store.has(name) === "present") store.delete(name);
  }
}

console.log(`Windows Credential Manager lifecycle smoke passed: ${rows.join("; ")}`);
