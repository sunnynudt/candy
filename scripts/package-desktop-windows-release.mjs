import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("The Windows release package requires Windows x64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
if (!electronDist || !path.isAbsolute(electronDist))
  throw new Error("Set ELECTRON_OVERRIDE_DIST_PATH to the verified Electron runtime first.");

const thumbprint = process.env.CANDY_SIGN_CERT_THUMBPRINT?.replace(/\s/gu, "");
if (!thumbprint || !/^[0-9a-f]{40}$/iu.test(thumbprint))
  throw new Error(
    "Set CANDY_SIGN_CERT_THUMBPRINT to the approved CurrentUser\\My certificate thumbprint.",
  );

const version = process.env.CANDY_RELEASE_VERSION ?? "1.0.0.0";
if (!/^\d+\.\d+\.\d+\.\d+$/u.test(version))
  throw new Error("CANDY_RELEASE_VERSION must contain four numeric components.");

const signer = resolveSigner(thumbprint);
const signtool = await findWindowsKitTool("signtool.exe");
const makeappx = await findWindowsKitTool("makeappx.exe");
const timestampUrl = process.env.CANDY_TIMESTAMP_URL;
const timestampArgs = timestampUrl ? ["/tr", timestampUrl, "/td", "SHA256"] : [];
const outputRoot = path.join(root, "out", "windows-release");
const bundle = path.join(outputRoot, "bundle");
const layout = path.join(outputRoot, "msix-layout");
const msix = path.join(outputRoot, `Candy-${version}.msix`);

await rm(outputRoot, { recursive: true, force: true });
const environment = { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: electronDist };
execFileSync(process.execPath, [process.env.npm_execpath, "run", "package:desktop:windows"], {
  cwd: root,
  env: environment,
  stdio: "inherit",
});
await cp(path.join(root, "out", "windows", "Candy"), bundle, {
  recursive: true,
  dereference: true,
});
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    path.join(root, "native", "sandbox-runner", "Cargo.toml"),
  ],
  { stdio: "inherit" },
);
await cp(
  path.join(root, "native", "sandbox-runner", "target", "release", "candy-sandbox-runner.exe"),
  path.join(bundle, "resources", "native", "candy-sandbox-runner.exe"),
);
await mkdir(layout, { recursive: true });
await cp(bundle, layout, { recursive: true, dereference: true });
await writeReleaseAssets(layout);
await writeFile(
  path.join(layout, "AppxManifest.xml"),
  `${manifestXml(signer.subject, version)}\n`,
  "utf8",
);

const binaries = await filesUnder(bundle, (file) => /\.(?:exe|dll)$/iu.test(file));
for (const file of binaries) signFile(signtool, file, thumbprint, timestampArgs);
execFileSync(makeappx, ["pack", "/d", layout, "/p", msix, "/o"], { stdio: "inherit" });
signFile(signtool, msix, thumbprint, timestampArgs);
execFileSync(signtool, ["verify", "/pa", "/all", msix], { stdio: "inherit" });

const metadata = {
  format: "msix",
  version,
  package: msix,
  electronVersion: "43.2.0",
  nodeVersion: process.version,
  architecture: process.arch,
  publisher: signer.subject,
  certificateThumbprint: thumbprint.toUpperCase(),
  timestamped: timestampArgs.length > 0,
  sourceRevision: capture("git", ["rev-parse", "HEAD"]),
  lockfileSha256: createHash("sha256")
    .update(await readFile(path.join(root, "package-lock.json")))
    .digest("hex"),
  signedFiles: binaries.map((file) => path.relative(bundle, file)),
};
await writeFile(
  path.join(outputRoot, "release-metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
  "utf8",
);
console.log(`Windows signed MSIX created: ${path.relative(root, msix)}`);
if (!metadata.timestamped)
  console.warn(
    "WARNING: release signature has no RFC 3161 timestamp; acceptance must record this.",
  );

function resolveSigner(value) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$thumb = $env:CANDY_SIGN_CERT_THUMBPRINT -replace ' ', ''",
    "$cert = Get-ChildItem -Path 'Cert:\\CurrentUser\\My' | Where-Object { $_.Thumbprint -eq $thumb } | Select-Object -First 1",
    "if ($null -eq $cert -or -not $cert.HasPrivateKey -or $cert.NotAfter -le (Get-Date)) { exit 2 }",
    "$cert.Subject",
  ].join("; ");
  try {
    const subject = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: root,
        env: { ...process.env, CANDY_SIGN_CERT_THUMBPRINT: value },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!subject) throw new Error("certificate subject is empty");
    return { subject };
  } catch {
    throw new Error(
      "The requested Windows signing certificate is unavailable or has no private key.",
    );
  }
}

async function findWindowsKitTool(name) {
  const rootPath = path.join(process.env["ProgramFiles(x86)"] ?? "", "Windows Kits", "10", "bin");
  const candidates = [];
  for (const versionEntry of await readdir(rootPath, { withFileTypes: true }).catch(() => [])) {
    if (!versionEntry.isDirectory() || !/^10\.0\d/iu.test(versionEntry.name)) continue;
    candidates.push(path.join(rootPath, versionEntry.name, "x64", name));
  }
  candidates.sort().reverse();
  const found = candidates.find((candidate) => {
    try {
      accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error(`Windows SDK tool ${name} was not found.`);
  return found;
}

function signFile(signtool, file, thumb, timestamp) {
  execFileSync(signtool, ["sign", "/fd", "SHA256", "/sha1", thumb, ...timestamp, file], {
    stdio: "inherit",
  });
}

async function filesUnder(directory, predicate) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (predicate(file)) result.push(file);
    }
  }
  await visit(directory);
  return result.sort();
}

function manifestXml(publisher, packageVersion) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap desktop rescap">
  <Identity Name="Candy.V1" Publisher="${escapeXml(publisher)}" Version="${packageVersion}" />
  <Properties>
    <DisplayName>Candy</DisplayName>
    <PublisherDisplayName>Candy</PublisherDisplayName>
    <Description>Standalone DeepSeek-first coding product.</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Applications>
    <Application Id="Candy" Executable="Candy.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Candy" Description="Standalone DeepSeek-first coding product."
        AppListEntry="default" Square44x44Logo="Assets\\Square44x44Logo.png"
        Square150x150Logo="Assets\\Square150x150Logo.png" />
      <Extensions><desktop:Extension Category="windows.fullTrustProcess" Executable="Candy.exe" /></Extensions>
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>`;
}

function escapeXml(value) {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character],
  );
}

async function writeReleaseAssets(layoutRoot) {
  const assets = path.join(layoutRoot, "Assets");
  await mkdir(assets, { recursive: true });
  await Promise.all([
    writeSolidPng(path.join(assets, "StoreLogo.png"), 50, 50),
    writeSolidPng(path.join(assets, "Square44x44Logo.png"), 44, 44),
    writeSolidPng(path.join(assets, "Square150x150Logo.png"), 150, 150),
  ]);
}

async function writeSolidPng(file, width, height) {
  const row = Buffer.alloc(width * 4, 0);
  for (let index = 0; index < width; index += 1) {
    row[index * 4] = 40;
    row[index * 4 + 1] = 100;
    row[index * 4 + 2] = 220;
    row[index * 4 + 3] = 255;
  }
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), row])),
  );
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", Buffer.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  await writeFile(file, png);
}

function u32(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  return Buffer.concat([
    Buffer.from(u32(data.length)),
    typeBytes,
    data,
    Buffer.from(u32(crc32(Buffer.concat([typeBytes, data])))),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}
