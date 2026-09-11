import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [path.join(root, "apps"), path.join(root, "packages")];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"]);
const piSpecifier = /(?:from\s+|import\s*\(|require\s*\()\s*["'](@earendil-works\/pi-[^"']+)["']/gu;
const allowedPiImports = new Map([
  ["packages/pi-adapter/", new Set(["@earendil-works/pi-coding-agent"])],
  ["apps/tui/", new Set(["@earendil-works/pi-tui"])],
]);
const violations = [];

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }

    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(absolute);
      continue;
    }

    if (!sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }

    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const source = await readFile(absolute, "utf8");
    for (const match of source.matchAll(piSpecifier)) {
      const importedPackage = match[1];
      const allowedPackages = [...allowedPiImports.entries()].find(([prefix]) =>
        relative.startsWith(prefix),
      )?.[1];
      if (!allowedPackages?.has(importedPackage)) {
        violations.push(`${relative}: ${importedPackage}`);
      }
    }
  }
}

for (const sourceRoot of sourceRoots) {
  await visit(sourceRoot);
}

if (violations.length > 0) {
  throw new Error(
    `Pi imports violate the package allowlist (pi-adapter -> pi-coding-agent; tui -> pi-tui):\n${violations.join("\n")}`,
  );
}

console.log("dependency boundary ok: Pi imports match the exact package allowlist");
