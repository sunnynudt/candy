# Candy

Candy is a standalone, model-neutral local coding product for the current macOS Tahoe `26.x` on Apple Silicon and Windows 11. The current primary macOS host is `26.6.1`. The TUI and local browser WebUI share Candy's task and history rules; Electron Desktop remains V2.

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

开发态（源码）使用方式：

```bash
nvm use
npm ci --ignore-scripts
npm link
candy
```

`npm link` 创建可执行命令 `candy`（Windows 为 `candy.cmd`）。`candy` 每次启动会先增量构建仓库并启动当前 checkout 的 TUI，所以这是本地开发迭代的主要入口。每次启动的运行行为与源码修改保持一致；不想装全局命令时，用 `npm run candy`。

本机发布体验（仓库更新后可离线更新）:

```bash
npm run package:tui:release
./out/tui-release/candy-<version>/install.sh
```

安装脚本会把版本放到 `~/.candy/versions/<version>`，并在 `~/.candy/bin` 下写入启动入口。将 `~/.candy/bin` 加入 PATH 后即可在任意目录运行 `candy`：

```bash
export PATH="$HOME/.candy/bin:$PATH"
candy --version
candy update --from ~/.candy/versions/<version>
```

源码改动后想直接一键更新本机，使用：

```bash
npm run package:tui:release:local
```

它会执行：构建发布包（默认放在 `out/tui-release`）并自动调用 `candy update --from <新包路径> --home ~/.candy --force`（无需手工找路径）。
`candy update` 若目标版本已是当前版本，会自然返回 `already current`；如需覆盖当前同版本安装，可追加 `-- --force`。

`candy --version` 在源码态和已安装态都可用；源码态仍可看到 `revision` / `stable` 信息，发布态显示当前安装包版本与 manifest 信息。  

补充运维命令（发布态）:

```bash
# 回滚到上一个版本（在 ~/.candy/previous 存在时）
candy rollback

# 清理并重装：先移除本地目录，再重复 install.sh
rm -rf ~/.candy
./out/tui-release/candy-<version>/install.sh
```

可选：使用自定义安装目录（便于 A/B 测试或脚本化）：

```bash
candy update --from ~/.candy/versions/<version> --home /tmp/candy-test
export PATH="/tmp/candy-test/bin:$PATH"
```

发布产物不要求上传到 npm；把新版本目录放到目标机后执行 `install.sh`，即可按同一机制更新。下一版只需重复 `npm run package:tui:release` 并替换新目录即可，和你用 pi/opencode/codex 的本地更新体验一致。

`candy` 启动是“源码优先”：有源码目录时会按源码路径启动，开发者迭代建议走 `npm link`；无源码时会按 `~/.candy/bin` 下的 shim 启动当前可用已安装版本。

Candy reads only Candy-owned DeepSeek or MiniMax credentials from the operating-system credential store (or the documented temporary development environment). Select a workspace with `:workspace /absolute/path`, enter a prompt, and Candy starts in the default **safe workspace** access mode: it makes containment-checked changes in an isolated copy, then lets you review them with `:changes` and `:diff` before the explicit `:apply` or `:discard`. `/access` shows the three plain-language choices: `review` only analyzes, `safe` is the default isolated workflow, and `current` works directly in the current workspace. On approved macOS hosts, `safe` and `current` both run ordinary existing local checks such as `npm run check` offline without per-command prompts; Candy never downloads dependencies automatically. In `safe`, a network command still needs one-command approval; `current` does not expose network commands. Credentials, commits, pushes, publishing, and deployment remain protected.

TUI 命令以 `/` 为前缀（`:` 为兼容别名）：运行 `/help` 查看完整命令参考，或阅读 [`docs/usage/tui-commands.md`](docs/usage/tui-commands.md)。在提示词中输入 `@` 可补全当前工作区的文件或目录；提交时 Candy 会把选中的文本上下文以有界、脱敏形式注入本次任务。`/model` 无参列出可选模型；`/resume` 无参列出可恢复任务并要求显式 continuation。

Windows development-machine setup, native prerequisites, and executable audit instructions are in [`docs/development/windows-11-toolchain.md`](docs/development/windows-11-toolchain.md).

Product scope is defined in `docs/product/candy-v1.md`. Implementation order and evidence requirements are defined in `docs/architecture/implementation-plan-v1.md` and `docs/product/acceptance-v1.md`. Start the local WebUI with `npm run webui`; it binds to loopback and requires the printed one-time bearer token.

Run `npm run acceptance:macos` for the current Tahoe 26.x primary host.

Development machine setup:

- Windows 11: `docs/development/windows-11-toolchain.md`
- macOS Tahoe `26.x` / Apple Silicon: `docs/development/macos-26-5-2-toolchain.md`
