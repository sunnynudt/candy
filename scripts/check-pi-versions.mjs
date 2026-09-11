import { execFileSync } from "node:child_process";

const expectedVersion = "0.84.1";
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("Run this check through npm so it inspects the selected install tree.");
}

const tree = JSON.parse(
  execFileSync(process.execPath, [npmCli, "ls", "--all", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }),
);

const discovered = new Map();

function walk(dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (name.startsWith("@earendil-works/pi-")) {
      const versions = discovered.get(name) ?? new Set();
      versions.add(dependency.version ?? "missing");
      discovered.set(name, versions);
    }
    walk(dependency.dependencies);
  }
}

walk(tree.dependencies);

if (discovered.size === 0) {
  throw new Error("No @earendil-works/pi-* packages were found in the install tree.");
}

const failures = [];
for (const [name, versions] of [...discovered.entries()].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  if (versions.size !== 1 || !versions.has(expectedVersion)) {
    failures.push(`${name}: ${[...versions].sort().join(", ")}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Mixed or unexpected Pi package graph:\n${failures.join("\n")}`);
}

console.log(`Pi package graph ok: ${discovered.size} packages at ${expectedVersion}`);
