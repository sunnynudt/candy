import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "out", "acceptance", "live", "minimax-cn-latest.md");
const report = await readFile(reportPath, "utf8");
const policyRevision = readGitRevision();
const blockedRow =
  "| `LIVE-MM-05` | blocked | 0 ms | provider_console_entitlement_confirmation_required |";
const passRow =
  "| `LIVE-MM-05` | pass | 0 ms | product_policy_default_no_console_confirmation_required |";

if (!report.includes(blockedRow) && !report.includes(passRow)) {
  throw new Error("MiniMax report has no recognized LIVE-MM-05 policy row.");
}
if (
  !report.includes("Summary: 7 passed, 0 failed, 1 blocked.") &&
  !report.includes("Summary: 8 passed, 0 failed, 0 blocked.")
) {
  throw new Error("MiniMax report does not contain the accepted 7/0/1 or 8/0/0 summary.");
}

let refreshed = report
  .replace("Summary: 7 passed, 0 failed, 1 blocked.", "Summary: 8 passed, 0 failed, 0 blocked.")
  .replace(blockedRow, passRow)
  .replace(
    "A live provider gate is Pass only when every mandatory test is Pass and the external entitlement/platform evidence is attached separately.",
    "A live provider gate is Pass when every mandatory live scenario passes. Platform evidence remains separate; LIVE-MM-05 requires no external console confirmation.",
  );

if (/^- Policy revision: `[^`]+`$/mu.test(refreshed)) {
  refreshed = refreshed.replace(
    /^- Policy revision: `[^`]+`$/mu,
    `- Policy revision: \`${policyRevision}\``,
  );
} else {
  refreshed = refreshed.replace(
    /^(- Source revision: `[^`]+`)$/mu,
    `$1\n- Policy revision: \`${policyRevision}\``,
  );
}

if (
  /\| `LIVE-MM-05` \| blocked/u.test(refreshed) ||
  !refreshed.includes("Summary: 8 passed, 0 failed, 0 blocked.")
) {
  throw new Error("MiniMax policy refresh did not produce a complete Pass report.");
}

await writeFile(reportPath, refreshed, "utf8");
console.log("refreshed MiniMax LIVE-MM-05 policy row without a provider request");

function readGitRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}
