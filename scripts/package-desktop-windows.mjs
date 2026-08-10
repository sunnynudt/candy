import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("The Windows package script requires Windows x64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
if (!electronDist || !path.isAbsolute(electronDist))
  throw new Error("Set ELECTRON_OVERRIDE_DIST_PATH to the verified Electron runtime first.");

const outputRoot = path.join(root, "out", "windows");
const bundle = path.join(outputRoot, "Candy");
const resources = path.join(bundle, "resources");
const appRoot = path.join(resources, "app");
const appServerRoot = path.join(resources, "app-server");
const nodeRoot = path.join(resources, "node");
const nodeModulesRoot = path.join(resources, "node_modules");
const nativeRoot = path.join(resources, "native");
const nativeRunner = path.join(nativeRoot, "candy-sandbox-runner.exe");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(electronDist, bundle, { recursive: true, dereference: true });
await rename(path.join(bundle, "electron.exe"), path.join(bundle, "Candy.exe"));

await mkdir(appRoot, { recursive: true });
await cp(path.join(root, "apps", "desktop", "dist"), path.join(appRoot, "dist"), {
  recursive: true,
});
await cp(path.join(root, "apps", "desktop", "package.json"), path.join(appRoot, "package.json"));

await mkdir(appServerRoot, { recursive: true });
await cp(path.join(root, "apps", "app-server", "dist"), appServerRoot, { recursive: true });
await cp(
  path.join(root, "apps", "app-server", "package.json"),
  path.join(appServerRoot, "package.json"),
);

execFileSync("cargo", [
  "build",
  "--locked",
  "--manifest-path",
  path.join(root, "native", "sandbox-runner", "Cargo.toml"),
]);
await mkdir(nativeRoot, { recursive: true });
await cp(
  path.join(root, "native", "sandbox-runner", "target", "debug", "candy-sandbox-runner.exe"),
  nativeRunner,
);

const nodeModulesSource = path.join(root, "node_modules");
const excludedTopLevel = new Set([
  ".bin",
  "@eslint",
  "@types",
  "electron",
  "eslint",
  "prettier",
  "typescript",
  "typescript-eslint",
]);
await cp(nodeModulesSource, nodeModulesRoot, {
  recursive: true,
  dereference: true,
  filter: (source) => {
    const relative = path.relative(nodeModulesSource, source);
    if (relative.length === 0) return true;
    return !excludedTopLevel.has(relative.split(path.sep)[0]);
  },
});

await mkdir(nodeRoot, { recursive: true });
await cp(process.execPath, path.join(nodeRoot, "node.exe"));

let electronVersion = "43.2.0";
try {
  electronVersion = (await readFile(path.join(bundle, "version"), "utf8")).trim();
} catch {
  // The verified Windows distribution may omit the marker file.
}
const metadata = {
  bundle,
  electronVersion,
  nodeVersion: process.version,
  architecture: process.arch,
  signing: "unsigned",
  sandboxRunner: nativeRunner,
};
await writeFile(
  path.join(outputRoot, "package-metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
  "utf8",
);
console.log(`Windows unsigned Desktop package created: out/windows/Candy (${electronVersion})`);
