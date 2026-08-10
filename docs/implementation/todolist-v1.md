# Candy V1 待办与进度

更新日期：2026-08-10
基线分支：`codex/candy-v1-foundation`
当前基线提交：`a556df122c2759049b9803e2e9df46bc8b6896d8`

标记约定：`☑️` 已完成；`◐` 已完成一部分（后续条件明确列出）；`⬜` 未开始或尚未达到可验收状态。

本文件是 V1 开发待办的进度基准。每完成一项或一个可独立验证的子项，都必须在此更新状态、验证证据和剩余条件；不能用局部测试通过替代完整验收。

## Windows 确定性修复

- ☑️ 修复平台路径适配：应用数据根路径根据传入的目标平台选择 `path.win32` 或 `path.posix` 语义，并覆盖跨宿主的 macOS/Windows 模拟测试。
  证据：Windows 11 确定性检查通过；提交 `d4d38e489c5ded8d29a866f7034a06afce54a525`。

- ☑️ 重构 Task Worktree 关联校验：结构化解析 `git worktree list --porcelain -z`，对路径进行规范化并精确比较，同时要求精确的锁定原因；不再使用模糊字符串匹配。
  证据：Windows Git 工作树创建、Apply、丢弃和重启交接 fixtures 通过；提交 `d4d38e489c5ded8d29a866f7034a06afce54a525`。

- ◐ 建立 Windows reparse-point 测试前置条件并验证防逃逸。
  已完成：普通 Windows 用户会话下的目录 junction 覆盖，确认 Pi 工作区边界拒绝经 junction 访问的外部文件。
  待完成：具备创建文件/目录 symlink 的测试条件（例如 Developer Mode 或等效授权）；补齐 symlink、其他 reparse point、路径逃逸和清理流程的真实 Windows 矩阵。

- ◐ 在干净依赖目录重跑完整门禁、TUI/App Server smoke 与原生检查。
  已完成：`npm ci --ignore-scripts` 后 `npm run check`（92 个测试）以及 TUI/App Server smoke 通过。
  待完成：在可用 Cargo registry/cache 环境中运行并记录 `npm run check:native`；此前 crates.io 索引访问长时间阻塞，未将其视为已通过。

- ◐ 将 `G0-WIN` 更新为 Windows 验收进行中，并执行 Windows 确定性矩阵。
  已完成：已确认当前主机为 Windows 11 Pro x64，`G0-WIN` 已更新为 `In progress`。
  待完成：优先完成并附证据的 ACC-01、ACC-02、ACC-05、ACC-06、ACC-08、ACC-11 Windows 矩阵，以及 ACC-12 十轮响应性测量。

## 后续 V1 工作

- ⬜ 完成 G2：Windows Job Object、完整后代进程取消、命令无网络/工作区隔离、reparse 防逃逸与安全评审。在验收前，Shell Auto 和 Shell Auto Debug 必须保持禁用。

- ⬜ 实装并验收 Browser Workspace：可见 `WebContentsView`、站点授权、观察版本、防陈旧操作、Take Control、下载和对抗性页面测试。当前仅有默认拒绝边界和内存状态机。

- ◐ 补齐长运行/Auto Debug：用户 steering、审批等待、最终证据摘要及原生 validator 集成。
  已完成：有界 Auto 执行、停止原因、持久化进度、暂停/恢复、崩溃中断和 Desktop 进度投影的确定性覆盖。
  待完成：上述交互、证据和原生验证器集成，以及打包/平台证据。

- ⬜ 在获得明确授权的测试凭据后完成 DeepSeek `LIVE-DS-01..04`、MiniMax `LIVE-MM-01..05` 和 MiniMax Token Plan entitlement 验证。

- ⬜ 完成 Windows 签名、macOS 签名/公证、Keychain/Credential Manager、桌面打包、恢复和响应性矩阵。

- ⬜ 重新生成当前提交的验收证据；旧证据仍指向 `0710d00`，且 macOS 基线表述已过时。

## 已追加的实现检查点

- ☑️ 持久化排队任务重排：SQLite 在立即事务内保存重排后的连续队列位置；协议和 App Server 支持受限的 `task.reorder`；TUI 提供 `:prioritize <task-id>` 并显示队列位置。
  证据：92 个确定性测试、TUI/App Server smoke 通过；提交 `a556df122c2759049b9803e2e9df46bc8b6896d8`。跨进程恢复和 Desktop 队列面板仍是后续工作，未在此项宣称完成。
