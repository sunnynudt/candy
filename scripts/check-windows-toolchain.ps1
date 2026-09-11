[CmdletBinding()]
param(
  [switch]$RequireNative
)

$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Add-Result {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Detail,
    [bool]$Required = $true
  )

  if ($Passed) {
    Write-Output "PASS  $Name - $Detail"
    return
  }

  if ($Required) {
    $failures.Add("$Name - $Detail")
    Write-Output "FAIL  $Name - $Detail"
  } else {
    $warnings.Add("$Name - $Detail")
    Write-Output "WARN  $Name - $Detail"
  }
}

function Read-Version {
  param(
    [string]$Command,
    [string[]]$Arguments,
    [string]$FallbackPath
  )

  $resolved = Get-Command $Command -ErrorAction SilentlyContinue
  $source = if ($resolved) { $resolved.Source } elseif ($FallbackPath -and (Test-Path -LiteralPath $FallbackPath)) { $FallbackPath } else { $null }
  if (-not $source) {
    return $null
  }

  return ((& $source @Arguments 2>&1 | Select-Object -First 1) -join '').Trim()
}

function Format-Value {
  param([AllowNull()]$Value)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
    return 'missing'
  }

  return [string]$Value
}

$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
Add-Result 'Windows 11' ($build -ge 22000) "$($os.Caption), build $build"
Add-Result 'x64 process architecture' ([Environment]::Is64BitProcess) $env:PROCESSOR_ARCHITECTURE

$nodeVersion = Read-Version 'node' @('--version')
$npmVersion = Read-Version 'npm' @('--version')
$gitVersion = Read-Version 'git' @('--version')
$ghVersion = Read-Version 'gh' @('--version')
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$rustupPath = Join-Path $cargoBin 'rustup.exe'
$rustcPath = Join-Path $cargoBin 'rustc.exe'
$cargoPath = Join-Path $cargoBin 'cargo.exe'

Add-Result 'Node.js' ($nodeVersion -eq 'v22.23.2') "expected v22.23.2, received $(Format-Value $nodeVersion)"
Add-Result 'npm' ($npmVersion -eq '10.9.8') "expected 10.9.8, received $(Format-Value $npmVersion)"
Add-Result 'Git' ($null -ne $gitVersion) (Format-Value $gitVersion)
Add-Result 'GitHub CLI' ($null -ne $ghVersion) (Format-Value $ghVersion)

$rustupVersion = Read-Version 'rustup' @('--version') $rustupPath
$rustcVersion = Read-Version 'rustc' @('--version') $rustcPath
$cargoVersion = Read-Version 'cargo' @('--version') $cargoPath
$activeRust = if ($rustupVersion) { Read-Version 'rustup' @('show', 'active-toolchain') $rustupPath } else { $null }
$nativeRequired = [bool]$RequireNative

Add-Result 'Rustup' ($null -ne $rustupVersion) (Format-Value $rustupVersion) $nativeRequired
Add-Result 'Rust MSVC toolchain' ($activeRust -like '*x86_64-pc-windows-msvc*') (Format-Value $activeRust) $nativeRequired
Add-Result 'rustc' ($null -ne $rustcVersion) (Format-Value $rustcVersion) $nativeRequired
Add-Result 'Cargo' ($null -ne $cargoVersion) (Format-Value $cargoVersion) $nativeRequired

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsInstallation = $null
if (Test-Path -LiteralPath $vswhere) {
  $vsInstallation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
Add-Result 'MSVC x64/x86 component' ($null -ne $vsInstallation -and @($vsInstallation).Count -gt 0) (Format-Value $vsInstallation) $nativeRequired

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$sdkVersions = @()
if (Test-Path -LiteralPath $sdkRoot) {
  $sdkVersions = @(Get-ChildItem -LiteralPath $sdkRoot -Directory -ErrorAction SilentlyContinue | Where-Object Name -Like '10.0.26100*' | Sort-Object Name -Descending)
}
$sdkVersion = if ($sdkVersions.Count -gt 0) { $sdkVersions[0].Name } else { $null }
Add-Result 'Windows 11 SDK 26100' ($null -ne $sdkVersion) (Format-Value $sdkVersion) $nativeRequired

$clPath = $null
$linkPath = $null
if ($vsInstallation) {
  $msvcRoot = Join-Path $vsInstallation 'VC\Tools\MSVC'
  $msvcVersion = Get-ChildItem -LiteralPath $msvcRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($msvcVersion) {
    $clCandidate = Join-Path $msvcVersion.FullName 'bin\Hostx64\x64\cl.exe'
    $linkCandidate = Join-Path $msvcVersion.FullName 'bin\Hostx64\x64\link.exe'
    if (Test-Path -LiteralPath $clCandidate) { $clPath = $clCandidate }
    if (Test-Path -LiteralPath $linkCandidate) { $linkPath = $linkCandidate }
  }
}
Add-Result 'cl.exe' ($null -ne $clPath) (Format-Value $clPath) $nativeRequired
Add-Result 'link.exe' ($null -ne $linkPath) (Format-Value $linkPath) $nativeRequired

if ($warnings.Count -gt 0) {
  Write-Output ""
  Write-Output "Optional or deferred checks: $($warnings.Count) warning(s)."
}

if ($failures.Count -gt 0) {
  Write-Error "Windows toolchain audit failed with $($failures.Count) required check(s)."
  exit 1
}

Write-Output "Windows toolchain audit passed. Native required: $nativeRequired"
