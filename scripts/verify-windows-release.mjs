import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Windows release verification requires Windows x64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "out", "windows-release");
const packagePath = requiredPath("CANDY_RELEASE_PACKAGE");
const upgradePath = optionalPath("CANDY_RELEASE_UPGRADE_PACKAGE");
const rollbackPath = optionalPath("CANDY_RELEASE_ROLLBACK_PACKAGE");
if ((upgradePath === undefined) !== (rollbackPath === undefined))
  throw new Error("Upgrade and rollback packages must be supplied together.");

await access(packagePath);
if (upgradePath) await access(upgradePath);
if (rollbackPath) await access(rollbackPath);
const metadata = await readFile(path.join(releaseRoot, "release-metadata.json"), "utf8").catch(
  () => undefined,
);
if (!metadata) throw new Error("Release metadata is missing from out/windows-release.");

const script = `
$ErrorActionPreference = 'Stop'
$identityName = 'Candy.V1'
$packagePath = ${ps(packagePath)}
$upgradePath = ${ps(upgradePath ?? "")}
$rollbackPath = ${ps(rollbackPath ?? "")}
$dataRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
$marker = Join-Path $dataRoot 'Candy\\release-acceptance-marker.txt'

function Current-Package {
  return Get-AppxPackage -Name $identityName | Sort-Object Version -Descending | Select-Object -First 1
}

function Assert-Signature([string] $path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne 'Valid') { throw "Authenticode signature is not valid: $path ($($signature.Status))" }
}

function Assert-Startup($package) {
  $executable = Join-Path $package.InstallLocation 'Candy.exe'
  Assert-Signature $executable
  $process = Start-Process -FilePath $executable -PassThru
  Start-Sleep -Seconds 3
  if ($process.HasExited) { throw 'Candy exited before the startup validation window.' }
  Stop-Process -Id $process.Id -Force
  $process.WaitForExit(5000)
}

function Install-Candy([string] $path) {
  Add-AppxPackage -Path $path -ForceApplicationShutdown -ForceUpdateFromAnyVersion
  $package = Current-Package
  if ($null -eq $package) { throw 'Candy package was not registered after install.' }
  Assert-Startup $package
  return $package
}

$existing = Current-Package
if ($null -ne $existing) {
  Remove-AppxPackage -Package $existing.PackageFullName -PreserveApplicationData
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
Set-Content -LiteralPath $marker -Value 'preserved' -NoNewline -Encoding UTF8

$first = Install-Candy $packagePath
if (-not (Test-Path -LiteralPath $marker)) { throw 'Application data marker was not created.' }
$result = @([pscustomobject]@{ phase = 'install'; version = [string]$first.Version; marker = $true })

if ($upgradePath) {
  $upgraded = Install-Candy $upgradePath
  if (-not (Test-Path -LiteralPath $marker)) { throw 'Application data marker was lost during upgrade.' }
  $result += [pscustomobject]@{ phase = 'upgrade'; version = [string]$upgraded.Version; marker = $true }
  Remove-AppxPackage -Package $upgraded.PackageFullName -PreserveApplicationData
  $rolledBack = Install-Candy $rollbackPath
  if (-not (Test-Path -LiteralPath $marker)) { throw 'Application data marker was lost during rollback.' }
  $result += [pscustomobject]@{ phase = 'rollback'; version = [string]$rolledBack.Version; marker = $true }
  Remove-AppxPackage -Package $rolledBack.PackageFullName -PreserveApplicationData
} else {
  Remove-AppxPackage -Package $first.PackageFullName -PreserveApplicationData
}

Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
$result | ConvertTo-Json -Compress
`;

const encoded = Buffer.from(script, "utf16le").toString("base64");
const output = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
console.log(`Windows release lifecycle verification passed: ${output}`);

function requiredPath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return withinReleaseRoot(value, name);
}

function optionalPath(name) {
  const value = process.env[name];
  return value ? withinReleaseRoot(value, name) : undefined;
}

function withinReleaseRoot(value, name) {
  const resolved = path.resolve(value);
  const relative = path.relative(releaseRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`${name} must be inside out/windows-release.`);
  return resolved;
}

function ps(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}
