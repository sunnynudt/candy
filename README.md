# Candy

Candy is a standalone, DeepSeek-first coding product for the current macOS Tahoe `26.x` on Apple Silicon and Windows 11. The current primary macOS host is `26.6.1`; macOS `26.5.2` remains an explicit compatibility regression baseline.

## Development baseline

- Node.js `22.23.2`
- npm `10.9.8`
- TypeScript `5.9.3`
- Pi package family `0.84.1`

Use the exact Node/npm pair before installing dependencies:

```powershell
nvm use 22.23.2
npm ci --ignore-scripts
npm run check
```

## Personal Preview TUI

On the current macOS host, launch the source checkout with:

```bash
nvm use
npm run tui
```

Candy reads only Candy-owned DeepSeek or MiniMax credentials from the operating-system credential store (or the documented temporary development environment). Select a workspace with `:workspace /absolute/path`, choose `:profile auto` to allow file edits, and enter a prompt. Auto tasks in a Git repository execute in a Candy-owned Task Worktree; use `:changes` and the full `:diff` before the explicit `:apply`, or use `:discard` to leave the Local Workspace unchanged. Shell remains disabled until its native security gate passes.

Windows development-machine setup, native prerequisites, and executable audit instructions are in [`docs/development/windows-11-toolchain.md`](docs/development/windows-11-toolchain.md).

Product scope is defined in `docs/product/candy-v1.md`. Implementation order and evidence requirements are defined in `docs/architecture/implementation-plan-v1.md` and `docs/product/acceptance-v1.md`.

Run `npm run acceptance:macos` for the current Tahoe 26.x primary host. Run `npm run acceptance:macos:baseline` only on an exact macOS 26.5.2 Apple Silicon host for the compatibility regression matrix.

Development machine setup:

- Windows 11: `docs/development/windows-11-toolchain.md`
- macOS Tahoe `26.x` / Apple Silicon: `docs/development/macos-26-5-2-toolchain.md`
