## 现状

- 任务只有稳定 id `task-<20hex>`，无简短标题；`/tasks`（`apps/tui/src/main.ts` `printTasks()`，约 L1941）只显示 id/state/model/workspacePath/revision/queueOrder/workspace/trusted-shell/validator。
- `SQLiteTaskStore`（`packages/platform/src/index.ts`，`task_metadata`，schema `user_version = 11`）没有 title、created_at、updated_at 字段。
- 多个任务并发/排队时（最多 3 默认/5 上限），用户难以从输出辨认哪个任务是哪个目标。

## 目标

1. 每个任务有**简短标题**。
2. `/tasks` 显示：标题、状态、创建/更新时间、工作区模式（local/worktree）、模型、Validator 状态。

## 范围

1. **标题来源**（选最小可行方案并在实现说明中写明）：
   - 首选：`/new <goal>` 从目标文本生成标题（取首行/前 N 字符，控制字符与超长截断；凭证形态内容拒绝，与 prompt 同一守卫）。
   - 备选（若更简单）：`/new` 无参时交互式询问标题；或模型首个 turn 完成后生成标题。不得引入第三方摘要服务。
2. **schema 迁移**：`task_metadata` 增加 `title TEXT`、`created_at`、`updated_at`（建议 INTEGER epoch 毫秒）；`user_version` bump 并提供迁移路径；`SQLiteTaskStore.create` 写创建时间，状态/run 变化更新 `updated_at`。新增 schema 迁移回归测试（从旧版本升级后字段可用、旧任务标题为空/回退为 taskId 前缀）。
3. **`/tasks` 增强**：输出列包含标题、状态、创建/更新时间（有界、可读格式）、workspace=local|worktree、模型、validator 状态（沿用现有 `validatorStatus`，含 configured/running/pass/fail/cancelled/not-configured）；保持现有 `*` current 标记、队列顺序、脱敏与有界输出。
4. 保持 `taskId` 为稳定唯一标识；标题只用于展示，不参与任务寻址（`/use`/`/resume` 仍用 taskId）。

## 验收

- 新建任务自动获得标题；`/tasks` 输出含标题/状态/创建/更新时间/workspace 模式/模型/validator 状态。
- schema 迁移测试 + TUI 回归测试通过；`npm run check` 全绿。
- 输出有界、脱敏；任务 id 语义不变；不影响 direct/worktree 任务路径。
