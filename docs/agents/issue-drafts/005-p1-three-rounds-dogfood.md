## 目的

在 Candy 仓库自身完成三轮**真实 dogfood**，验证 Candy 的日常使用闭环；每轮都在当前工作区先检查 `/changes`、`/diff`，再运行验证。这是对基线（Issue 2）之后的真实使用检验，dogfood 期间不得引入回归。

## 三轮内容

1. **理解 Candy 仓库**：阅读 `AGENTS.md`、`CONTEXT.md`、`docs/product/candy-v1.md`、`docs/architecture/candy-v1.md`、`docs/usage/tui-commands.md`，梳理工作区结构（`apps/`、`packages/`、`native/`、`tests/`、`scripts/`），用 Candy 工具（`candy_list`/`candy_search`/`candy_read`）完成；输出理解摘要（仓库内文档或 issue comment）。
2. **小功能修改**：在 Candy 源码上做一处真实的小功能改动（建议从 Issue 3/4 中挑一个最小子项，或用户指定的等价改动），完整走创建任务 → 修改 → 验证 → 审查 → 提交/清理。
3. **定位并修复失败测试**：找一个失败测试（可在 Issue 1 修复后构造/遗留场景），用 Candy 定位原因并修复，验证通过。

## 每轮流程（必须逐轮执行）

1. 在当前工作区创建/选择任务，明确本轮目标。
2. 修改后先检查 `/changes`（变更清单）与 `/diff`（完整脱敏 diff），再运行验证（`npm run check` 或对应聚焦测试；trusted-shell/real-PTY 相关按基线脚本）。
3. 记录：输入目标、步骤、改动文件、验证命令与结果、失败原因与修复。
4. 验证通过后按分支策略处理改动（本任务默认：应用为未提交变更并在报告说明，或按用户授权 commit/push；**不自动 push**）。

## 边界

- dogfood 使用 Candy 工具完成，但不得把 candy 仓库自身的提交/发布动作混入；Git 提交按仓库规则（保留无关用户改动、凭据扫描）。
- 报告脱敏；live provider 若涉及，按 `docs/testing/live-provider-credentials.md` 单独授权。
- 结果只代表当前 macOS 主机 TUI 使用体验，不外推到 Windows/Desktop。

## 验收

- 三轮各有一份记录：目标、步骤、`/changes` 与 `/diff` 证据、验证命令与结果。
- 第三轮成功定位并修复一个失败测试，修复后有对应回归。
- dogfood 结束后 `npm run check` 全绿；若 dogfood 改动被保留，按分支策略提交并核对远程 SHA。
