## 背景（回归已确认）

`/trusted-shell on` 应**自动开启 Worktree**，不需要先手工 `/worktree on`。这是文档契约：

- `docs/usage/tui-commands.md`：`/trusted-shell` 行——"开启时会自动启用 Worktree，不需要先手动执行 `/worktree on`"。
- `docs/product/candy-v1.md` 与 `README.md`：Trusted Shell 启用时自动选择隔离 Task Worktree。

但当前实现存在回归：`apps/tui/src/main.ts` 的 `setTrustedShell()`（约 L1985–2036）在 `#worktreeEnabled === false`（默认值，L288/L312）时先命中

```ts
if (!this.#worktreeEnabled) {
  this.write("Trusted Shell Auto rejected: select /worktree on first\n");
  return;
}
```

直接拒绝；后面"自动开启 Worktree"的分支（L2027–2032，消息 `Trusted Shell Auto requires isolation; Worktree enabled automatically for new tasks`）变成**不可达死代码**。

影响面：

- TUI 回归测试 `apps/tui/src/main.test.ts` — "interactive TUI enables Trusted Shell Auto in the accepted macOS composition root"（约 L623）用 `createDefaultInteractiveTui`（worktreeEnabled 默认 `false`）期望输出 `Worktree enabled automatically for new tasks`，当前在 macOS arm64 上失败。
- Trusted Shell smoke 旅程（`tests/smoke-tui-trusted-shell-macos.exp`、`smoke-tui-trusted-shell-dogfood-macos.exp`）直接发送 `:trusted-shell on`（不先 `:worktree on`），同样受影响。
- `npm run check` 因此非全绿。

## 范围

1. 修复 `setTrustedShell("on")`：**删除提前的 worktree 前置拒绝**，让流程继续经过平台/Profile/Sandbox Runner/G2 门禁检查后，再自动 `#worktreeEnabled = true` 并输出 `Worktree enabled automatically for new tasks`。顺序必须保持 fail-closed：平台不可用、非 Auto profile、Sandbox Runner 缺失或 G2 未通过时，应保留 Trusted Shell 关闭且**不**翻转 worktree（与现有文档一致："如果平台能力未通过 G2，Candy 会保留关闭状态并显示具体原因"）。
2. 保留 `createTask`（约 L601）的 `if (!this.#worktreeEnabled) throw ...` 作为防御性不变量（trustedShell=true 时该分支不应再被触发；fail-closed 不删）。
3. 回归测试：
   - 保持/修复"默认 worktree off → `/trusted-shell on` → 自动开启 Worktree、新任务 workspaceState=worktree、trustedShell 持久化、消息断言"。
   - 保持"worktree 已 on 时 `/trusted-shell on` 正常启用"路径（现有测试约 L667）。
   - 保持普通 Auto 任务在 `/worktree off`（默认）下仍**直接编辑当前工作区**（direct mode），不受影响。
   - 保持平台门禁未通过时拒绝且不翻转 worktree 的现有测试。
4. 验证 `tests/smoke-tui-trusted-shell-macos.mjs` 与 `tests/smoke-tui-trusted-shell-dogfood-macos.mjs` 对应的 `.exp` 期望无需改动（它们本就按"开启即自动 worktree"编写）。

## 验收

- `npm run check` 恢复**全绿**（含修复后的 Trusted Shell 相关 TUI 回归）。
- `npm run smoke:tui:trusted-shell:macos` 与 `npm run smoke:tui:trusted-shell:dogfood:macos` 通过；环境受限项必须显式说明，不当作 Pass。
- 行为验证：默认 `/worktree off` 时普通 Auto 任务仍 direct mode；`/trusted-shell on` 后新建任务 workspaceState=worktree 且 trustedShell=true；`/trusted-shell off` 或 `/profile read-only` / `/worktree off` 仍正确关闭。
- 修复提交遵守分支策略：`codex/candy-v1-foundation`，先 fetch 快进，staged diff 凭据扫描后 commit/push，核对远程 SHA。
