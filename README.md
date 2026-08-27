# Candy

Candy is a standalone, DeepSeek-first coding product for the current macOS Tahoe `26.x` on Apple Silicon and Windows 11. The current primary macOS host is `26.6.1`.

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

Install the local command once and launch the TUI on macOS or Windows with:

```bash
nvm use
npm link
candy
```

The npm link creates the platform-appropriate command shim (`candy` on macOS and `candy.cmd` on Windows). Each `candy` launch rebuilds the repository and starts the latest TUI, so it is the iteration command while developing Candy; pass TUI smoke flags directly when verifying the launcher, for example `candy --smoke`. When launched from another directory, that directory is the default workspace; use `/workspace <path>` to switch explicitly. If you prefer not to install a global command, `npm run candy` in the repository works the same way.

Candy reads only Candy-owned DeepSeek or MiniMax credentials from the operating-system credential store (or the documented temporary development environment). Select a workspace with `:workspace /absolute/path`, enter a prompt, and the task starts in the Auto profile with containment-checked file read/create/edit/delete enabled; task-level `:changes` and `:diff` provide the review boundary. Use `/profile read-only` to restrict file mutation. By default, Auto Git tasks run in a Candy-owned Task Worktree under `<workspace>/.git/candy-worktrees/` (falling back to the Candy application-data directory when `.git` is a file, such as in submodules); use `:changes` and the full `:diff` before the explicit `:apply`, or use `:discard`. `/worktree off` is the explicit direct-mode override, so changes are already in the local workspace and should be reviewed with `:changes`/`:diff` before the user commits with git. On approved macOS hosts, isolated Auto Git tasks also run ordinary local commands such as `npm run check` offline by default, reusing an existing workspace `node_modules` without downloading dependencies; network commands still require one-command approval. `/local off` opts out of local command execution for future tasks (`/trusted-shell off` remains a compatibility alias).

TUI 命令以 `/` 为前缀（`:` 为兼容别名）：运行 `/help` 查看完整命令参考，或阅读 [`docs/usage/tui-commands.md`](docs/usage/tui-commands.md)。在提示词中输入 `@` 可补全当前工作区的文件或目录；提交时 Candy 会把选中的文本上下文以有界、脱敏形式注入本次任务。`/model` 无参列出可选模型；`/resume` 无参列出可恢复任务并要求显式 continuation。

Windows development-machine setup, native prerequisites, and executable audit instructions are in [`docs/development/windows-11-toolchain.md`](docs/development/windows-11-toolchain.md).

Product scope is defined in `docs/product/candy-v1.md`. Implementation order and evidence requirements are defined in `docs/architecture/implementation-plan-v1.md` and `docs/product/acceptance-v1.md`.

Run `npm run acceptance:macos` for the current Tahoe 26.x primary host.

Development machine setup:

- Windows 11: `docs/development/windows-11-toolchain.md`
- macOS Tahoe `26.x` / Apple Silicon: `docs/development/macos-26-5-2-toolchain.md`
