# Windows 11 Development Toolchain

Status: verified baseline for Candy V1 development

This document is the reproducible setup and verification guide for a Windows 11 x64 Candy development machine. Product dependency versions remain authoritative in the root `package.json`, `package-lock.json`, and any future `rust-toolchain.toml`.

## Why the toolchain has several layers

Candy is not only installing Rust. It needs a complete Windows-native compilation chain for the narrowly scoped Sandbox Runner and Windows Job Object process ownership helper.

| Layer | Purpose |
| --- | --- |
| Node.js / npm / TypeScript | Candy product code, TUI, Runtime, Pi Adapter, Electron control plane |
| Rustup / rustc / Cargo | Build the narrowly scoped Rust native helper |
| MSVC `cl.exe` | Compile C/C++-compatible code and support the Rust Windows MSVC target |
| MSVC `link.exe` | Link Rust/C++ objects into Windows executables |
| Windows SDK | Windows API headers, import libraries, resource compiler, manifests, and signing utilities |
| CRT / VC Runtime | Build and run Windows-native programs against the supported Microsoft ABI |
| Native diagnostics | Diagnose native compilation, process, and packaging failures |

The approximately 1 GB Visual Studio modification is mostly MSVC, Windows SDK, CRT, linker, and supporting packages rather than Rust itself. Candy uses the `x86_64-pc-windows-msvc` Rust target because the native helper must link correctly to Windows APIs and the MSVC ABI. The GNU target is not an accepted Candy V1 Windows baseline.

## Required by development phase

| Capability | Phase 1–5 TypeScript/Pi/Desktop work | Native Sandbox Runner / Job Object | Release packaging |
| --- | --- | --- | --- |
| Windows 11 x64 | Required | Required | Required |
| Git and GitHub CLI | Required | Required | Required |
| Node.js `22.23.2` and npm `10.9.8` | Required | Required | Required |
| Rustup, rustc, Cargo, rustfmt, Clippy | Not required | Required | Required when native code ships |
| MSVC x64/x86 tools | Not required | Required | Required when native code ships |
| Windows 11 SDK `10.0.26100` component | Not required | Required | Required |
| Python | Not currently required | Dependency-specific only | Dependency-specific only |
| CMake / Ninja | Not currently required | Only if an accepted dependency proves a need | Dependency-specific only |
| Electron | Repository dependency; never install globally | — | Repository dependency |
| Signing identity | Not required | Not required | External release prerequisite; never commit it |

Do not install pnpm, Yarn, a global Electron, WebView2, LLVM/Clang, CMake, Ninja, WiX, or NSIS merely as speculative preparation. Add a tool only when an accepted implementation packet requires it.

## Verified baseline

Verified on 2026-08-10:

- Windows 11 x64;
- NVM for Windows `1.2.2` as the local Node selector;
- Node.js `22.23.2` with bundled npm `10.9.8`;
- Git for Windows `2.50.1`;
- GitHub CLI `2.92.0`;
- Rustup `1.29.0` with `stable-x86_64-pc-windows-msvc`;
- rustc `1.97.1`, Cargo `1.97.1`, rustfmt, and Clippy;
- Visual Studio Build Tools 2022 product with component IDs listed below;
- Windows 11 SDK component `Microsoft.VisualStudio.Component.Windows11SDK.26100`.

The exact Rust release is not yet a repository compatibility pin because no Rust package exists. Add and commit `rust-toolchain.toml` before the first native-helper implementation; from then on it becomes the authoritative Rust version instead of the moving `stable` channel.

### Recorded native-chain verification

Verified on 2026-08-10 on Windows 11 Pro x64, build `26200`:

- Rustup `1.29.0` selected `stable-x86_64-pc-windows-msvc` as the active default toolchain;
- rustc `1.97.1`, Cargo `1.97.1`, rustfmt `1.9.0`, and Clippy `0.1.97` are installed;
- MSVC `14.44.35207` provides `cl.exe` and `link.exe`;
- Windows SDK `10.0.26100.0` provides the resource, manifest, and signing tools;
- `rustc` compiled a smoke program through the Visual Studio x64 developer environment;
- the resulting `smoke.exe` linked, launched, and printed `candy-rust-msvc-smoke` with exit code `0`.

This is evidence that the Windows Rust → MSVC → SDK → CRT chain is usable. It does not claim that the Sandbox Runner itself is implemented or accepted.

## New-machine installation order

Run installers separately. Restart the terminal after installers change `PATH` or native tool registrations.

### 1. Git, GitHub CLI, and Node selector

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
winget install --id CoreyButler.NVMforWindows -e
```

Open a new PowerShell, then install and activate the exact Node baseline:

```powershell
nvm install 22.23.2
nvm use 22.23.2
node --version
npm --version
gh auth login
```

Expected Node/npm output:

```text
v22.23.2
10.9.8
```

### 2. Repository dependencies

From the Candy repository:

```powershell
npm ci --ignore-scripts
git diff --exit-code -- package-lock.json
npm run check:toolchain
npm run check
npm run smoke:tui
```

Dependency lifecycle scripts remain disabled unless the repository policy explicitly audits and enables them. Provider credentials are never part of machine bootstrap.

### 3. Rust for native development

This step may be deferred until work starts on the native Sandbox Runner or Windows Job Object ownership.

```powershell
winget install --id Rustlang.Rustup -e
rustup default stable-x86_64-pc-windows-msvc
rustup component add rustfmt clippy
```

The official Rust distribution service is the default and preferred trust boundary. When it is unusably slow, Rustup supports a session-scoped mirror through `RUSTUP_DIST_SERVER` and `RUSTUP_UPDATE_ROOT`. Record the mirror used in verification evidence; do not persist an unofficial mirror as a repository default.

### 3.1 Cargo registry connectivity in mainland China

For a Windows development host on a mainland-China network, do not spend an unbounded time waiting for a first native build to refresh the crates.io index. After a bounded direct attempt is demonstrably slow, prefer a user- or maintainer-approved domestic Cargo mirror.

The mirror is a local development transport decision, not a Candy dependency source-of-truth change:

- keep the mirror configuration outside the repository, preferably in a dedicated local `CARGO_HOME` used only for that verification session;
- require a sparse registry URL from an explicitly approved mirror operator; never guess or commit a third-party registry URL;
- continue to run `cargo ... --locked`, preserve the committed `Cargo.lock`, and fail if a mirror attempts to alter the resolved package graph;
- never put provider credentials, mirror credentials, or private registry URLs in repository configuration, diagnostics, acceptance reports, or command arguments;
- record only the mirror operator and sanitized connectivity outcome in local verification evidence, then remove the temporary `CARGO_HOME` override after the run.

This rule applies to `npm run check:native` as well as direct Cargo diagnostics. An unavailable or untrusted mirror is a controlled local-network blocker, not a reason to weaken lockfile or dependency verification.

### 4. MSVC and Windows SDK for native development

Install the Build Tools product if it is absent:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e
```

Then open PowerShell as Administrator and add the minimum accepted components:

```powershell
$vsInstaller = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe"

& $vsInstaller modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" `
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  --add Microsoft.VisualStudio.Component.Windows11SDK.26100 `
  --passive `
  --norestart
```

Exit code `5007` means the installer process was not elevated from startup. A channel-feed warning is not an installation failure when the Visual Studio Installer continues downloading and installing the requested packages.

## Verification

Core TypeScript/Pi development:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-windows-toolchain.ps1
```

Before native-helper work, require the complete Rust/MSVC/SDK chain:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-windows-toolchain.ps1 -RequireNative
```

After the native audit passes, compile and run a real Rust smoke executable. Version commands alone do not prove that `link.exe`, Windows SDK libraries, and the CRT work together.

## Cross-platform boundary

This document covers Windows 11 only. Current macOS Tahoe `26.x` Apple Silicon requires its own setup and evidence. Do not infer macOS readiness from Windows tool availability or GitHub-hosted CI alone.
