import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = execFileSync(process.execPath, ["scripts/candy.mjs", "--version"], {
  cwd: root,
  encoding: "utf8",
});
const metadata = JSON.parse(output);

assert.equal(metadata.product, "candy");
assert.equal(typeof metadata.version, "string");
assert.ok(["stable", "candidate", "release"].includes(metadata.channel));
assert.match(metadata.revision ?? "", /^[0-9a-f]{40}$/u);
if (metadata.stableRevision !== null) {
  assert.match(metadata.stableRevision, /^[0-9a-f]{40}$/u);
}
assert.equal(metadata.pinnedNode, "22.23.2");
assert.equal(metadata.piVersion, "0.84.1");
assert.equal(typeof metadata.dirty, "boolean");
assert.ok(
  metadata.rollback === "unavailable-without-an-upstream-revision" ||
    metadata.rollback === "release-revision-not-recorded" ||
    /^git worktree add <recovery-path> [0-9a-f]{40}$/u.test(metadata.rollback) ||
    /^rollback to [0-9a-f]{40} by git worktree$/u.test(metadata.rollback),
  `unexpected rollback guidance: ${JSON.stringify(metadata.rollback)}`,
);

console.log(
  JSON.stringify({
    channel: metadata.channel,
    revision: metadata.revision,
    stableRevision: metadata.stableRevision,
    node: metadata.node,
    piVersion: metadata.piVersion,
  }),
);
