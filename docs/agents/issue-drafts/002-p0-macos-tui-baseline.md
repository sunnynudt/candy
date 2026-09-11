## 目的

在 Trusted Shell 回归修复（Issue 1）之后，为**当前 SHA** 建立 macOS TUI 基线证据：完整检查、macOS TUI journey、终端矩阵、Trusted Shell smoke。记录执行 SHA、Node/npm、macOS 版本与结果；**不把结果外推到 Windows 11 或 Desktop**。

## 前置

- Issue 1（Trusted Shell 自动 Worktree 回归修复）已完成且 `npm run check` 全绿。
- 执行前 `git fetch origin/codex/candy-v1-foundation` 快进；从干净工作树开始，记录 `git rev-parse HEAD` 为基线 SHA。
- 固定工具链：Node `22.23.2`（`.nvmrc`/`package.json engines`）、npm `10.9.8`（`packageManager`）；执行前 `nvm use`（当前非 `v22.23.2` 时）。

## 范围（在当前 macOS Tahoe `26.x` Apple Silicon 主机，当前为 `26.6.1` arm64）

1. 完整检查：`npm run check`（format/lint/typecheck/test/boundaries/pi-versions/lifecycle-scripts）。
2. macOS TUI journey：`npm run smoke:tui:journey:macos`。
3. 终端矩阵：`npm run smoke:tui:terminal:macos`（真实 PTY，含中文 UTF-8 输入等既有覆盖）。
4. Trusted Shell smoke：`npm run smoke:tui:trusted-shell:macos` 与 `npm run smoke:tui:trusted-shell:dogfood:macos`。
5. 补充（可选但建议）：`npm run check:native`、`npm run acceptance:macos`；live gates 按 `docs/testing/live-provider-credentials.md` 单独授权后再跑，不计入本基线。

## 记录要求

- 记录项：基线 SHA、Node/npm 版本、macOS 版本与架构、每条命令的通过/失败/跳过及失败原因、环境受限项（如 agent 沙箱 `sandbox_apply: Operation not permitted` 类）必须逐条标注"真实主机可复验"或"未执行"。
- 脱敏报告写入 `docs/evidence/`（或 `out/acceptance/macos/`，注意 gitignore）并绑定 SHA；凭据只保留 presence。
- 报告边界声明必须包含："仅代表当前 macOS 主机 TUI，不覆盖 Windows 11 或 Desktop；不得用于替代另一平台验收"。

## 验收

- 上述命令全部通过，或失败/跳过项均有明确原因与环境说明（不把环境受限写成 Pass）。
- 生成绑定 SHA 的脱敏基线报告，含边界声明。
- 基线结果同步更新 `docs/implementation/todolist-v1.md` / `progress-v1.md`。
