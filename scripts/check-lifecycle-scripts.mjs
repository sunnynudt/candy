import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const policy = JSON.parse(
  await readFile(path.join(root, "config", "lifecycle-scripts.json"), "utf8"),
);
const allowed = new Set(policy.allowedPackages.map(({ name, version }) => `${name}@${version}`));
const packages = lockfile.packages ?? {};
const unexpected = [];

for (const [location, metadata] of Object.entries(packages)) {
  if (!metadata.hasInstallScript) {
    continue;
  }

  const name = metadata.name ?? location.split("node_modules/").at(-1);
  const identity = `${name ?? "unknown"}@${metadata.version ?? "missing"}`;
  if (!name || !allowed.has(identity)) {
    unexpected.push(`${identity} (${location})`);
  }
}

if (unexpected.length > 0) {
  throw new Error(
    `Dependency lifecycle scripts require an explicit allowlist entry:\n${unexpected.join("\n")}`,
  );
}

console.log(`lifecycle script policy ok: ${allowed.size} allowed package(s)`);
