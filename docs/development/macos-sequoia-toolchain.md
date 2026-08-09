# macOS Sequoia 15+ / Apple Silicon Development Toolchain

Status: setup checklist; target-machine verification pending

This document is for the M2 Pro development machine. It complements `windows-11-toolchain.md`; passing this checklist does not by itself claim Candy V1 release acceptance.

## Required by development phase

| Capability | Phase 1–5 TypeScript/Pi/Desktop work | Native Sandbox Runner / Job Object | Release packaging |
| --- | --- | --- | --- |
| macOS Sequoia 15+ on Apple Silicon | Required | Required | Required |
| Node.js `22.23.2` and npm `10.9.8` | Required | Required | Required |
| Git and GitHub CLI | Required | Required | Required |
| Xcode Command Line Tools | Required for native modules | Required | Required |
| Rustup, rustc, Cargo, rustfmt, Clippy | Not required | Required | Required when native code ships |
| Full Xcode | Not required | Not required for the first Rust helper smoke | Required only when the selected packaging/signing flow needs `xcodebuild` or full Apple tooling |
| Electron | Repository dependency; never install globally | — | Repository dependency |
| CMake / Ninja / LLVM / Clang separately | Not currently required | Only if an accepted dependency proves a need | Dependency-specific only |
| Apple signing identity and notarization credentials | Not required | Not required | External release prerequisite; never commit them |

Do not install Homebrew packages, global Electron, Playwright, WebView2, WiX, NSIS, CMake, or Ninja merely as speculative preparation. The Xcode Command Line Tools already provide the compiler and macOS SDK needed for the first native build; Candy does not add a second compiler toolchain.

## Installation and verification order

Run installers separately and open a new Terminal after changing shell configuration or PATH.

### 1. Confirm the target machine

```zsh
sw_vers -productVersion
uname -m
sysctl -n hw.optional.arm64
```

Expected:

```text
15.x or newer
arm64
1
```

### 2. Xcode Command Line Tools

Check the installed developer tools:

```zsh
xcode-select -p
xcrun --find clang
clang --version
xcrun --sdk macosx --show-sdk-path
pkgutil --pkg-info=com.apple.pkg.CLTools_Executables
```

If the tools are missing, start the Apple installer:

```zsh
xcode-select --install
```

Full Xcode is not required for the initial Candy TypeScript/Pi work or the first Rust compiler smoke. Install and select full Xcode only when the chosen Desktop packaging, signing, notarization, or `xcodebuild` workflow requires it.

### 3. Node.js and npm baseline

Use the approved Node version manager already available on the machine, then select the Candy baseline:

```zsh
nvm install 22.23.2
nvm alias default 22.23.2
nvm use 22.23.2
node --version
npm --version
```

Expected:

```text
v22.23.2
10.9.8
```

If `nvm` is not installed, install it through the machine's approved software process before continuing. Do not silently substitute Node 24 or a system Node installation.

### 4. Git and GitHub CLI

```zsh
git --version
gh --version
gh auth status
```

GitHub authentication is needed for cloud synchronization, but credentials must never be copied into Candy files, logs, prompts, or test fixtures.

### 5. Rust Apple Silicon toolchain

Rust is needed on macOS when implementing or testing the native Sandbox Runner. Use rustup and the native Apple Silicon target:

```zsh
rustup show
rustup default stable-aarch64-apple-darwin
rustup component add rustfmt clippy
rustc --version
cargo --version
rustup show active-toolchain
```

The active toolchain should end with `aarch64-apple-darwin`. Before the first native-helper implementation, add a repository `rust-toolchain.toml` so the exact Rust release becomes a committed compatibility input instead of relying on a moving `stable` channel.

### 6. Candy repository verification

From the Candy repository on the canonical branch:

```zsh
git fetch origin codex/candy-v1-foundation
git status -sb
npm ci --ignore-scripts
git diff --exit-code -- package-lock.json
npm run check:toolchain
npm run check
npm run smoke:tui
```

Record the macOS version, architecture, Node/npm versions, Rust toolchain, lockfile result, test result, and smoke result as the local evidence for this machine.

### 7. Native smoke when native work begins

After the Rust toolchain is installed, a real link/run smoke is required; version output alone is insufficient:

```zsh
smoke_dir="$(mktemp -d)"
trap 'rm -R "$smoke_dir"' EXIT
printf 'fn main() { println!("candy-rust-macos-smoke"); }\n' \
  | rustc - --crate-name candy_macos_smoke --edition=2021 -o "$smoke_dir/smoke"
"$smoke_dir/smoke"
```

The smoke must compile, link, launch, and exit successfully. The temporary output remains outside the repository.

## What this checklist does not prove

- It does not prove the Rust Sandbox Runner security contract or process containment.
- It does not prove packaged Electron startup, credential storage, signing, notarization, or Browser Workspace behavior.
- It does not prove provider entitlement or live-provider compatibility.
- It does not replace the GitHub Windows/macOS CI matrix or the final product acceptance evidence package.

