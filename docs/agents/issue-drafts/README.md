# GitHub Issue Drafts — 创建顺序与命令

这些文件是待核对的历史任务草稿，不是已发布 Issue，也不是当前实施授权。

2026-09-20 核对本仓库全部 GitHub Issues：现有 #2、#3、#4、#5，没有与下列五份草稿一一对应的已发布任务。保留草稿以免丢失未决需求；发布前先核对当前源码、产品合同和现有 Issue，避免重复创建或重开已经完成的工作。

下方命令仅作为核对后的发布参考。当前状态维护在 [实施状态索引](../../implementation/self-iteration-progress.md)，执行与分支规则以 [AGENTS.md](../../../AGENTS.md) 为准。

创建顺序（依赖关系：Issue 1 → Issue 2；Issue 3/4/5 在 1、2 完成或并行评估后执行）：

```bash
# 1. P0 修复 Trusted Shell 自动 Worktree 回归（先做：让 npm run check 恢复全绿）
gh issue create \
  --title "[P0] 修复 Trusted Shell 自动 Worktree 回归" \
  --label "ready-for-agent" \
  --body-file docs/agents/issue-drafts/001-p0-trusted-shell-auto-worktree.md

# 2. P0 建立当前 SHA 的 macOS TUI 基线（依赖 1：基线必须是全绿 SHA）
gh issue create \
  --title "[P0] 建立当前 SHA 的 macOS TUI 基线" \
  --label "ready-for-agent" \
  --body-file docs/agents/issue-drafts/002-p0-macos-tui-baseline.md

# 3. P1 任务可辨识（标题 + /tasks 增强）
gh issue create \
  --title "[P1] 任务可辨识：任务标题与 /tasks 展示" \
  --label "ready-for-agent" \
  --body-file docs/agents/issue-drafts/003-p1-task-recognizability.md

# 4. P1 当前状态与失败恢复（/new 支持目标与可选 Validator）
gh issue create \
  --title "[P1] 当前状态与失败恢复" \
  --label "ready-for-agent" \
  --body-file docs/agents/issue-drafts/004-p1-current-state-failure-recovery.md

# 5. P1 三轮真实 dogfood（理解仓库 / 小功能修改 / 定位并修复失败测试）
gh issue create \
  --title "[P1] 三轮真实 dogfood" \
  --label "ready-for-agent" \
  --body-file docs/agents/issue-drafts/005-p1-three-rounds-dogfood.md
```

创建后动作：

- `gh issue list` 核对五个 issue 的编号与顺序；在相关 issue 上按需 `gh issue comment <number>` 补充上下文。
- Issue 2 的"当前 SHA"以执行时的 `git rev-parse HEAD` 为准（预期为 Issue 1 修复后的提交，不再引用 `a9d1d60d` 之前的状态）。
- 每个任务完成后：更新 `docs/implementation/self-iteration-progress.md`，按 `AGENTS.md` 和当前用户授权执行验证、提交与发布。
- 关闭 issue：`gh issue close <number>`（建议附完成证据摘要后再关闭）。

边界提醒（草稿正文中已写入，执行时请保持一致）：

- 不把 macOS 结果外推到 Windows 11 或 Desktop。
- 不把"环境受限导致的跳过/失败"写成 Pass；真实主机可复验项要列明命令与结果。
- 所有证据报告脱敏；凭据只保留 presence，绝不进入 issue、日志或提交内容。
