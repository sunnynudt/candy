## 现状

- 当前任务状态展示分散：`/profile` 只显示 profile；workspace 模式在任务创建消息里出现；待审批动作只在审批提示中可见；执行阶段（provider retry、compaction、validator 运行等）散落在 turn 事件里。
- Validator/Provider 失败只有脱敏类别（如 `ProviderContractError` 映射），没有**简短原因 + 明确重试路径**。
- `/new <prompt>`（`apps/tui/src/main.ts` 约 L445）与 `/validator <exec> [args]`（约 L963）是两个独立入口；创建任务时无法一次指定"目标 + 可选 Validator"。

## 目标

1. 单点查看当前任务状态：模型、Profile、direct/worktree、待审批动作、执行阶段。
2. Validator/Provider 失败后输出**简短原因**和**明确的可执行重试路径**。
3. `/new` 支持任务目标和可选 Validator 配置。

## 范围

1. **状态单点**（建议 `/status`，或增强既有 `/tasks`/提示栏，实现说明中选定）：
   - 当前任务（无则提示）的：模型、approval Profile、direct（local）或 worktree、待审批动作（delete/network approval id 与目标摘要，不含参数内容）、执行阶段（queued/running/waiting_approval/paused/interrupted/completed/cancelled；turn 阶段如 provider retry / compaction / validator running）。
   - 输出有界、脱敏。
2. **失败恢复提示**：
   - Validator 失败：显示原因类别（exit code / timeout / blocked / cancelled）+ 重试路径（如"修复后 `/validate` 重跑"、"`/resume <task-id> <continuation>`"）。
   - Provider 失败：显示脱敏类别（401/429/timeout/network/credential 缺失）+ 明确重试路径（`/resume` 需显式 continuation；`/model` 可换主模型；`/cancel` 终止）。`/resume` 语义不变：不自动重放中断 turn。
3. **`/new` 扩展**：支持任务目标与可选 Validator，例如
   `/new --validator <absolute-executable> [args] <goal>`
   （或等价语法；与 `/validator` 共用同一解析/守卫：绝对路径可执行文件、无控制字符、无凭证形态内容）。Validator 配置单一来源，`/validator` 与 `/new --validator` 行为一致。与 Issue 3 的标题来源协调（同一目标文本派生标题）。
4. 回归测试覆盖：状态单点各字段、失败提示文案与重试命令、`/new --validator` 解析与拒绝路径（相对路径/控制字符/凭证形态）。

## 验收

- `/status`（或选定入口）能一次展示上述字段；待审批动作 id 可直接用于 `/approve|/deny`。
- 构造 Validator/Provider 失败场景，TUI 输出简短原因 + 可执行的下一步命令。
- `/new --validator ... <goal>` 可一次创建带 validator 的任务；非法参数被拒绝且不创建任务。
- `npm run check` 全绿；文档 `docs/usage/tui-commands.md` 与 `apps/tui/src/slash-commands.ts` 同步更新。
