import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The macOS package script requires macOS arm64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "out", "macos");
const bundle = path.join(outputRoot, "Candy.app");
const resources = path.join(bundle, "Contents", "Resources");
const appRoot = path.join(resources, "app");
const appServerRoot = path.join(resources, "app-server");
const nodeRoot = path.join(resources, "node");
const nodeModulesRoot = path.join(resources, "node_modules");
const nativeRoot = path.join(resources, "native");
const nativeRunner = path.join(nativeRoot, "candy-sandbox-runner");

const electronModule = await import("electron");
const electronExecutable = electronModule.default ?? electronModule;
if (typeof electronExecutable !== "string" || !path.isAbsolute(electronExecutable))
  throw new Error("Electron executable path is unavailable.");
const electronBundle = path.resolve(electronExecutable, "..", "..", "..");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
execFileSync("/usr/bin/ditto", [electronBundle, bundle]);

await mkdir(path.join(appRoot, "dist"), { recursive: true });
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
  path.join(root, "native", "sandbox-runner", "target", "debug", "candy-sandbox-runner"),
  nativeRunner,
);
await chmod(nativeRunner, 0o755);

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

const nodeExecutable = process.execPath;
await mkdir(path.join(nodeRoot, "bin"), { recursive: true });
await cp(nodeExecutable, path.join(nodeRoot, "bin", "node"));
await chmod(path.join(nodeRoot, "bin", "node"), 0o755);

const macosExecutable = path.join(bundle, "Contents", "MacOS", "Electron");
const candyExecutable = path.join(bundle, "Contents", "MacOS", "Candy");
await rename(macosExecutable, candyExecutable);
const plist = path.join(bundle, "Contents", "Info.plist");
for (const [key, value] of [
  ["CFBundleDisplayName", "Candy"],
  ["CFBundleName", "Candy"],
  ["CFBundleExecutable", "Candy"],
  ["CFBundleIdentifier", "com.sunnynudt.candy"],
]) {
  execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
}

execFileSync("/usr/bin/codesign", ["--deep", "--force", "--sign", "-", "--timestamp=none", bundle]);

const metadata = {
  bundle,
  electronVersion: String(
    await readFile(path.join(root, "node_modules", "electron", "dist", "version"), "utf8"),
  ).trim(),
  nodeVersion: process.version,
  architecture: process.arch,
  signing: "ad-hoc",
  sandboxRunner: nativeRunner,
};
await writeFile(
  path.join(outputRoot, "package-metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
console.log(JSON.stringify(metadata));
