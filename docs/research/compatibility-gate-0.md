# Compatibility Gate 0：外部技术兼容性事实

- 状态：**有条件通过（Conditional Go）**
- 核查日期：**2026-08-09**
- 适用范围：Candy V1 技术定版前的 Pi 0.84.1、DeepSeek、MiniMax、Node.js、TypeScript、npm 与 Electron 兼容性核查
- 证据规则：只使用供应商官方文档、官方源码/tag、官方 npm 注册表和官方运行时文档；用户截图仅作为待核对线索，不作为 API 合同

> 当前决策（2026-08-13）：ADR-0009 以当前 macOS Tahoe `26.x` Apple Silicon 主机（当前为 `26.6.1`）作为 primary acceptance host，并保留精确 `26.5.2` 作为兼容性回归基线，取代 ADR-0008 的单一 exact-version preflight；窄 Rust Sandbox Runner、显式 Browser 接管回退与 Electron `43.2.0` Gate 基线保持不变。这些决策不替代本报告列出的真实凭证与双平台验证。

## 1. 结论摘要

1. **DeepSeek 名称不再构成阻塞。** `deepseek-v4-flash` 与 `deepseek-v4-pro` 是 2026-08-09 官方可列出的 API model ID，不需要猜测映射。Candy 首切应使用 OpenAI-compatible Chat Completions，而不是依赖尚未同时覆盖两款模型的 Responses API。
2. **Pi 0.84.1 可以作为 Candy 的窄嵌入依赖。** 官方发布了 `@earendil-works/pi-coding-agent@0.84.1`，提供文档化 SDK、会话、事件、工具和运行模式；要求 Node.js `>=22.19.0`。Candy 应只依赖 package exports 与 SDK 文档所列入口，不得导入 `src/**`。
3. **MiniMax M3 的官方 API model ID 是 `MiniMax-M3`。** 国内端点、Bearer 鉴权、streaming、thinking、tool calling、文本/图片/视频输入均有官方合同；Token Plan 订阅 Key 也可用于官方 API 调用，但它与按量计费 API Key 不互通，真实套餐权益以控制台与真实调用为准。
4. **MiniMax 视频与 Pi 0.84.1 存在硬边界。** MiniMax 官方 M3 API 支持视频输入，但 Pi 0.84.1 的公共消息类型和模型输入能力只有 `text | image`，没有视频内容类型。因此 Candy V1 可经 Pi 支持 M3 文本和图片；若 V1 要求视频输入，则当前方案被阻塞，不能靠导入 Pi 内部文件规避。
5. **后续决策将可复现基线收敛为 Node.js 22.23.2 + npm 10.9.8 + TypeScript 5.9.3。** Pi `v0.84.1` 的常规 CI 与发布验证均运行在 Node 22 线，TypeScript 精确固定为 5.9.3；Candy 因此优先使用 Pi 已验证的主版本线，而不是独立追逐最新 Node/npm。完整依据见 [Pi-compatible toolchain baseline](./pi-toolchain-baseline.md)。

> Gate 判定：可以继续技术方案、编码实施方案和产品实现；在真实凭证、目标系统和已发布 npm 包的最小冒烟验证完成前，不得启用或验收对应能力，不得把 Compatibility Gate 0 标为完全关闭，也不得宣称供应商兼容性已经通过实测。

## 2. 证据等级与术语

| 标记 | 含义 |
| --- | --- |
| **事实** | 已由本报告链接的第一方资料直接支持，核查日为表中日期 |
| **推断** | 由两个或多个官方合同共同推得，但尚未以真实凭证或目标机器运行验证 |
| **建议** | Candy 的版本或合同选择，不代表供应商强制要求 |
| **待验证** | 必须用真实凭证、目标 OS 或已发布产物完成的动态验证 |
| **公共接口** | 出现在已发布 npm package exports 中；“文档化公共接口”还必须出现在官方 SDK/README 中 |
| **内部实现** | 仓库中的 `src/**`、生成器、CLI 内部模块或未被 package exports 暴露的文件；可用于理解，不可作为 Candy import 合同 |

Pi 目前是 `0.x` 版本。本报告中的“稳定公共接口”是指**对精确锁定的 0.84.1 版本可公开导入且有文档支持**，不表示上游承诺跨后续版本保持兼容。

## 3. Pi 0.84.1

### 3.1 版本、运行时和包发布事实

| 项目 | 已核实事实 | 第一方证据 | 核查日 |
| --- | --- | --- | --- |
| 目标 tag | 官方 tag `v0.84.1` 存在 | [Pi v0.84.1 tag](https://github.com/earendil-works/pi/tree/v0.84.1) | 2026-08-09 |
| tag commit | `v0.84.1` 指向 commit `53fa77ccd8a279eb87e92294ef3687b03ff80112` | [官方 commit](https://github.com/earendil-works/pi/commit/53fa77ccd8a279eb87e92294ef3687b03ff80112) | 2026-08-09 |
| Node 要求 | monorepo 与已发布核心包声明 `node >=22.19.0` | [根 package.json](https://github.com/earendil-works/pi/blob/v0.84.1/package.json)、[coding-agent package.json](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json) | 2026-08-09 |
| 模块格式 | Pi 0.84.1 包为 ESM，公开入口指向编译后的 `dist/*.js` 与 `dist/*.d.ts` | [coding-agent package.json](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json)、[agent-core package.json](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/package.json) | 2026-08-09 |
| TypeScript | Pi 仓库将 TypeScript 精确固定为 `5.9.3` | [根 package.json](https://github.com/earendil-works/pi/blob/v0.84.1/package.json) | 2026-08-09 |
| coding SDK 包 | `@earendil-works/pi-coding-agent@0.84.1` 已发布；官方注册表元数据给出 Node 下限、exports 与 tarball integrity | [npm registry metadata](https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/0.84.1) | 2026-08-09 |
| agent loop 包 | `@earendil-works/pi-agent-core@0.84.1` 已发布 | [npm registry metadata](https://registry.npmjs.org/%40earendil-works%2Fpi-agent-core/0.84.1) | 2026-08-09 |
| provider 包 | `@earendil-works/pi-ai@0.84.1` 已发布 | [npm registry metadata](https://registry.npmjs.org/%40earendil-works%2Fpi-ai/0.84.1) | 2026-08-09 |
| TUI 包 | `@earendil-works/pi-tui@0.84.1` 已发布 | [npm registry metadata](https://registry.npmjs.org/%40earendil-works%2Fpi-tui/0.84.1) | 2026-08-09 |

`@earendil-works/pi-coding-agent@0.84.1` 的 npm integrity 在核查日为 `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==`。这是审计线索，最终安装仍应由 Candy 自身 lockfile 固定并由 `npm ci` 校验。[官方注册表元数据](https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/0.84.1)（核查日：2026-08-09）

### 3.2 公开 exports 与可复用接口

| 包/入口 | 公开状态 | 可复用能力 | Gate 结论 | 证据 | 核查日 |
| --- | --- | --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` 根入口 | **公开且文档化** | `createAgentSession`、`AgentSession`、`AgentSessionRuntime`、`ModelRuntime`、资源加载、事件订阅、工具工厂、会话与运行模式 | Candy 的首选嵌入入口 | [SDK](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md)、[exports](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json) | 2026-08-09 |
| `@earendil-works/pi-coding-agent/client` | **公开 export，文档覆盖不足** | client 子入口 | 不作为 V1 核心合同，除非后续找到与目标用例匹配的上游文档 | [exports](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json) | 2026-08-09 |
| `@earendil-works/pi-coding-agent/rpc-entry` | **公开 export** | RPC 可执行入口 | 适合进程隔离/语言无关集成；同进程 TUI 应优先 SDK | [SDK 的运行模式选择](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md)、[exports](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json) | 2026-08-09 |
| `@earendil-works/pi-agent-core` 根入口 | **公开且文档化，低层** | `Agent`、`agentLoop`、`agentLoopContinue`、事件流、tool pre/post hooks、turn stop hook | 可复用，但 Candy 应优先让 coding-agent SDK 管理完整会话，避免自己拼装 loop | [agent-core README](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/README.md)、[exports](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/package.json) | 2026-08-09 |
| `@earendil-works/pi-agent-core/node` | **公开 export** | Node 专用能力 | 只有 SDK 根入口不能满足的明确需求才使用 | [exports](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/package.json) | 2026-08-09 |
| `@earendil-works/pi-agent-core/session/testing` | **公开 export，但名称明确为测试用途** | session 测试辅助 | 不得作为 Candy 生产运行合同 | [exports](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/package.json) | 2026-08-09 |
| 任意 `src/**` 或未导出的子路径 | **内部实现** | provider 适配、生成目录、CLI/TUI 内部流程等 | 只可研究，不可导入 | 上述各包 [package exports](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json) | 2026-08-09 |

已文档化、与 Candy 最相关的公共合同：

- `createAgentSession()` 是单个 `AgentSession` 的主工厂；`AgentSession` 管理生命周期、消息、模型状态、压缩和事件流。[官方 SDK](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md)（核查日：2026-08-09）
- `SessionManager` 文档化支持内存会话、新建持久会话、继续最近会话、打开 JSONL、列出会话以及 `id/parentId` 树与分支操作。[官方 SDK 会话章节](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md)（核查日：2026-08-09）
- 内建工具名为 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；SDK 公开工具选择、只读工具和自定义工具合同。[官方 SDK 工具章节](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md)（核查日：2026-08-09）
- agent-core 文档化 `beforeToolCall`、`afterToolCall` 与 `shouldStopAfterTurn`，也支持全局或单工具顺序/并行执行控制。[agent-core README](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/README.md)（核查日：2026-08-09）

### 3.3 Pi 自带供应商适配事实

| 供应商 | Pi 0.84.1 中的事实 | 接口性质 | 证据 | 核查日 |
| --- | --- | --- | --- | --- |
| DeepSeek | 生成目录明确包含 `deepseek-v4-flash` 与 `deepseek-v4-pro`，base URL 为 `https://api.deepseek.com`，API 类型为 OpenAI completions；标注 1M context、384K max output、reasoning 与 assistant reasoning 回传兼容 | 模型目录/生成器是内部实现；根 provider 能力由 `pi-ai` 公共入口消费 | [模型生成器](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/scripts/generate-models.ts)、[DeepSeek provider](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/providers/deepseek.ts) | 2026-08-09 |
| MiniMax CN | provider ID 为 `minimax-cn`，使用 `https://api.minimaxi.com/anthropic` 与 Anthropic Messages；环境变量名为 `MINIMAX_CN_API_KEY` | provider 文件是内部实现，不可直接导入 | [MiniMax CN provider](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/providers/minimax-cn.ts) | 2026-08-09 |
| MiniMax M3 | 0.84.1 生成器将 `MiniMax-M3` 列入 minimax/minimax-cn 直接支持集合，changelog 记录 direct provider 支持 | 生成器/目录是内部实现；需要通过公共模型运行接口使用 | [模型生成器](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/scripts/generate-models.ts)、[pi-ai changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/CHANGELOG.md) | 2026-08-09 |

### 3.4 Pi 多模态边界

**事实：** Pi 0.84.1 的公共 `UserMessage.content` 只接受字符串或 `(TextContent | ImageContent)[]`；`Model.input` 只有 `("text" | "image")[]`。没有 `VideoContent`。[Pi 0.84.1 类型定义](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/types.ts)（核查日：2026-08-09）

由此得到：

- **文本：兼容。**
- **图片：类型层面兼容，但仍需用 `MiniMax-M3` + `minimax-cn` + 真实订阅 Key 验证实际请求转换、streaming 和工具回传。**
- **视频：不兼容 Pi 0.84.1 公共合同。** 即使 MiniMax 上游支持，也不能把视频塞入 Pi 类型或导入内部 adapter 作为 V1 正式方案。

## 4. DeepSeek 官方 API 合同

### 4.1 模型与基础协议

| 项目 | 官方事实 | 第一方证据 | 核查日 |
| --- | --- | --- | --- |
| Flash model ID | `deepseek-v4-flash` | [模型列表](https://api-docs.deepseek.com/api/list-models/)、[首次调用](https://api-docs.deepseek.com/) | 2026-08-09 |
| Pro model ID | `deepseek-v4-pro` | [模型列表](https://api-docs.deepseek.com/api/list-models/)、[首次调用](https://api-docs.deepseek.com/) | 2026-08-09 |
| 当前模型版本 | Flash 映射至 `DeepSeek-V4-Flash-0731`；Pro 为 `DeepSeek-V4-Pro` | [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/) | 2026-08-09 |
| OpenAI base URL | `https://api.deepseek.com` | [首次调用](https://api-docs.deepseek.com/) | 2026-08-09 |
| Chat endpoint | `POST /chat/completions` | [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion) | 2026-08-09 |
| 鉴权 | `Authorization: Bearer <API key>` | [首次调用](https://api-docs.deepseek.com/) | 2026-08-09 |
| Streaming | `stream: true` 返回 data-only SSE，以 `data: [DONE]` 结束 | [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion) | 2026-08-09 |
| Tool calling | Flash 与 Pro 均支持 function tool calls；strict mode 属于 `/beta`，不应进入最小首切 | [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) | 2026-08-09 |
| Context/output | 两者均为 1M context，最大输出 384K | [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/) | 2026-08-09 |
| Responses API | 核查日支持 Flash，但官方表仍标示不支持 Pro | [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/) | 2026-08-09 |
| 旧别名 | `deepseek-chat` 与 `deepseek-reasoner` 已公告在 2026-07-24 停用 | [官方 changelog](https://api-docs.deepseek.com/updates/) | 2026-08-09 |

**Gate 结论：** Candy 文档中的 “DeepSeek V4 Flash / Pro” 与当前官方 API model ID 一致，**不是 blocker**。但是首切合同必须写精确 ID，不能再使用 `deepseek-chat`、`deepseek-reasoner` 或猜测别名。

### 4.2 Thinking/reasoning 合同

| 项目 | 官方事实 | 第一方证据 | 核查日 |
| --- | --- | --- | --- |
| 开关 | OpenAI Chat 格式使用 `thinking.type = enabled | disabled`；默认开启 | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) | 2026-08-09 |
| 努力等级 | 官方文档支持 `reasoning_effort`；默认 effort 为 `high`，不同模型存在映射差异 | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) | 2026-08-09 |
| 流式字段 | thinking 内容通过 `reasoning_content` 返回 | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat API](https://api-docs.deepseek.com/api/create-chat-completion) | 2026-08-09 |
| 工具轮次回传 | 请求含 `tools` 时，后续请求必须完整回传 `reasoning_content`，否则官方说明会返回 400 | [Thinking Mode - Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode/) | 2026-08-09 |

Pi 0.84.1 的 DeepSeek 模型目录设置了 reasoning assistant message 回传兼容标志；这是**支持兼容性的上游实现证据**，不是实测结果。[Pi 模型生成器](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/scripts/generate-models.ts)（核查日：2026-08-09）

## 5. MiniMax 官方 API 合同

### 5.1 MiniMax M3

| 项目 | 官方事实 | 第一方证据 | 核查日 |
| --- | --- | --- | --- |
| model ID | `MiniMax-M3` | [模型调用](https://platform.minimaxi.com/docs/guides/text-generation)、[官方 OpenAPI](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json) | 2026-08-09 |
| 国内 Anthropic base URL | `https://api.minimaxi.com/anthropic`；完整 Messages URL 为 `https://api.minimaxi.com/anthropic/v1/messages` | [模型调用](https://platform.minimaxi.com/docs/guides/text-generation)、[Messages API](https://platform.minimaxi.com/docs/api-reference/text-chat-anthropic) | 2026-08-09 |
| 国内 OpenAI base URL | `https://api.minimaxi.com/v1`；完整 Chat URL 为 `https://api.minimaxi.com/v1/chat/completions` | [模型调用](https://platform.minimaxi.com/docs/guides/text-generation)、[Chat API](https://platform.minimaxi.com/docs/api-reference/text-chat-openai) | 2026-08-09 |
| 鉴权 | 官方示例使用 `Authorization: Bearer <token>` | [官方 OpenAPI](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json)、[Messages API](https://platform.minimaxi.com/docs/api-reference/text-chat-anthropic) | 2026-08-09 |
| Streaming | 两种兼容 API 均支持 `stream: true`；OpenAI OpenAPI 声明 `text/event-stream` | [模型调用](https://platform.minimaxi.com/docs/guides/text-generation)、[官方 OpenAPI](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json) | 2026-08-09 |
| Tool calling | M3 支持 function tools 与 interleaved thinking；工具轮次必须回传完整 assistant 响应及 thinking/reasoning 信息 | [工具使用与交错思维链](https://platform.minimaxi.com/docs/guides/text-m3-function-call) | 2026-08-09 |
| Thinking | Anthropic 兼容路径支持 thinking block/interleaved thinking，官方将其列为推荐路径；OpenAI 格式支持 `adaptive`/`disabled` 和 reasoning 分离 | [模型调用](https://platform.minimaxi.com/docs/guides/text-generation)、[官方 OpenAPI](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json) | 2026-08-09 |
| 输入模态 | OpenAI Chat Completions 支持文本、`image_url` 和 `video_url` | [模型调用](https://platform.minimaxi.com/docs/guides/text-generation)、[官方 OpenAPI](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json) | 2026-08-09 |
| Context | 1,000,000 tokens | [模型调用](https://platform.minimaxi.com/docs/guides/text-generation) | 2026-08-09 |
| 最大输出 | M3 推荐 128K、API 上限 512K | [官方 OpenAPI](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json) | 2026-08-09 |
| 多模态大小限制 | URL/Base64：图片 ≤10 MB、视频 ≤50 MB、请求体 ≤64 MB；Files API 视频 ≤512 MB | [官方 OpenAPI](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json) | 2026-08-09 |

**协议选择建议：** Candy 经 Pi 0.84.1 使用 M3 时，应采用 Pi 已有的 `minimax-cn` + Anthropic Messages 路径，因为这是 Pi 的直接国内 provider，也是 MiniMax 官方推荐 thinking/interleaved-thinking 路径。OpenAI Chat 合同可作为供应商直接 API 的对照验证，但不应为视频而绕过 Pi 的公共消息合同。[Pi provider](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/providers/minimax-cn.ts)、[MiniMax 模型调用](https://platform.minimaxi.com/docs/guides/text-generation)（核查日：2026-08-09）

### 5.2 Token Plan Plus

| 项目 | 官方事实 | 第一方证据 | 核查日 |
| --- | --- | --- | --- |
| API 可用性 | Token Plan 快速接入明确用订阅 Key 调用国内 Anthropic Messages 与 `MiniMax-M3` | [Token Plan 快速接入](https://platform.minimaxi.com/docs/token-plan/quickstart) | 2026-08-09 |
| Key 类型 | 订阅 Key 用于 Token Plan 套餐和已购积分；与按量计费 API Key 不互通 | [Token Plan 快速接入](https://platform.minimaxi.com/docs/token-plan/quickstart)、[FAQ](https://platform.minimaxi.com/docs/token-plan/faq) | 2026-08-09 |
| 资源生效条件 | Key 可以先存在，只有账号拥有 Token Plan 席位或积分权限后才可实际使用资源 | [Token Plan 快速接入](https://platform.minimaxi.com/docs/token-plan/quickstart) | 2026-08-09 |
| 当前公开档位 | Plus、Max、Ultra；Plus 当前公开月价 ¥49 | [Token Plan 定价](https://platform.minimaxi.com/docs/guides/pricing-token-plan)、[FAQ](https://platform.minimaxi.com/docs/token-plan/faq) | 2026-08-09 |
| 当前覆盖 | 当前公开文档称可用模型覆盖 M3/M2.7/图像/语音/音乐，少量特殊模型不支持；实际可用资源和用量以控制台为准 | [Token Plan 定价](https://platform.minimaxi.com/docs/guides/pricing-token-plan)、[FAQ](https://platform.minimaxi.com/docs/token-plan/faq) | 2026-08-09 |
| 当前额度约束 | 套餐内额度受 5 小时固定窗口和周窗口控制，未用完额度不结转；多工具共享同一套餐额度 | [Token Plan FAQ](https://platform.minimaxi.com/docs/token-plan/faq) | 2026-08-09 |

#### 截图/营销页的证据边界

用户提供的 “TokenPlan Plus 年度会员” 截图**不能作为 API 合同**。它不能证明：

- 当前订阅 Key 是否已激活 M3 API 权限；
- model ID、base URL、鉴权头、请求/响应 schema；
- “约 6 亿 token” 如何换算为当前 5 小时/周窗口、共享额度和实际调用消耗；
- 年度老用户是否处于保留档、迁移档或当前公开档；
- 图片、视频、tool calling、streaming 是否能在该账户上成功。

核查日的公开定价页只列出月度 Plus/Max/Ultra 与当前共享额度规则，没有足够信息把截图中的年度规格转换为可执行 API 配额合同。[Token Plan 定价](https://platform.minimaxi.com/docs/guides/pricing-token-plan)、[Token Plan FAQ](https://platform.minimaxi.com/docs/token-plan/faq)（核查日：2026-08-09）

**结论：** Token Plan Plus **官方允许 API 调用**；但该具体年度账户能否调用 `MiniMax-M3`、剩余多少额度、是否有迁移权益，必须查看当前控制台并用该账户的订阅 Key 做真实调用。不能从截图推断。

## 6. Node.js、TypeScript 与包管理器基线

### 6.1 外部事实

| 项目 | 官方事实 | 第一方证据 | 核查日 |
| --- | --- | --- | --- |
| Pi Node 下限 | `>=22.19.0` | [Pi root package.json](https://github.com/earendil-works/pi/blob/v0.84.1/package.json) | 2026-08-09 |
| 当前 LTS 主线 | Node.js 24（Krypton）在核查日为 LTS；Node 官方要求生产应用使用 Active 或 Maintenance LTS | [Node.js Releases](https://nodejs.org/en/about/previous-releases) | 2026-08-09 |
| Pi 已验证 Node 主版本线 | Pi `v0.84.1` 常规 CI、发布构建与发布前验证均使用 Node 22 | [Pi CI](https://github.com/earendil-works/pi/blob/v0.84.1/.github/workflows/ci.yml)、[Pi release workflow](https://github.com/earendil-works/pi/blob/v0.84.1/.github/workflows/build-binaries.yml) | 2026-08-09 |
| 当前 Node 22 安全补丁与随附 npm | Node.js `22.23.2`，随附 npm `10.9.8` | [Node.js 22 archive](https://nodejs.org/en/download/archive/v22) | 2026-08-09 |
| TypeScript | Pi 0.84.1 精确使用 TypeScript 5.9.3；TypeScript 5.9 官方支持 NodeNext 模块配置 | [Pi package.json](https://github.com/earendil-works/pi/blob/v0.84.1/package.json)、[TypeScript 5.9 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html) | 2026-08-09 |
| Electron 开发环境 | Electron 官方建议开发时使用最新 LTS Node；Electron 自带 Node runtime，不使用系统 Node 运行 app | [Electron prerequisites](https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites) | 2026-08-09 |
| Electron 平台边界 | Electron 44+ 要求 macOS 13+，并且只发布 64 位平台产物 | [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes) | 2026-08-09 |

### 6.2 Candy V1 建议基线

以下均为**建议**：

| 层面 | 建议 | 依据与影响 |
| --- | --- | --- |
| Node.js | 精确固定 `22.23.2` | 处于 Pi `v0.84.1` 的 Node 22 CI/发布验证线，并包含当前安全补丁 |
| package manager | 精确固定随 Node 提供的 `npm@10.9.8`，提交根 lockfile-v3 `package-lock.json`，CI/发布使用 `npm ci` | Pi 的常规验证使用 Node 22 随附 npm；npm 11.16 只出现在上游可信发布步骤，不是消费者要求 |
| TypeScript | 精确固定 `typescript@5.9.3` | 与 Pi 0.84.1 一致，减少声明文件和 ESM 解析差异 |
| 模块/构建 | Candy 源码使用 ESM/NodeNext；生产运行编译后的 JavaScript，不依赖运行时 TypeScript loader | Pi 已发布包为 ESM；编译产物更适合 TUI、app-server 子进程和桌面打包的可重复启动 |
| Pi 依赖 | 完整 `@earendil-works/pi-*` 包族精确固定为 `0.84.1`，只从 coding-agent 公开根 exports 导入；由 lockfile 与安装断言阻止混合版本 | coding-agent 对兄弟包使用 caret 范围，仅固定一个直接依赖不足以长期保证单一 Pi 版本 |
| Electron | Electron 保持独立版本线；承载 Pi 的 Desktop app-server 使用随 Candy 打包的 Node `22.23.2` 子进程 | Electron 内嵌 Node 只服务 Desktop main/preload，不成为 Pi Adapter 的隐式运行时 |

Windows 11 与 macOS 均有 Node 22 官方 64 位发行路径；Electron 也支持 Windows/macOS，但真正的“Candy 可跨平台”仍需在两个目标系统完成安装、子进程、路径、凭证存储和打包验证。[Node.js 22 archive](https://nodejs.org/en/download/archive/v22)、[Electron prerequisites](https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites)（核查日：2026-08-09）。

## 7. 兼容性矩阵

| 组合 | 静态结论 | 动态状态 | Gate 判定 | 核查日 |
| --- | --- | --- | --- | --- |
| Node 22.23.2 + npm 10.9.8 + Pi 0.84.1 | 位于 Pi 的 Node 22 验证线，满足 `>=22.19.0`，TypeScript/ESM 方向一致 | 尚未在 Candy 最小工程安装/导入 | ⚠️ 需 npm 产物与安装树冒烟 | 2026-08-09 |
| Pi SDK + in-process TUI | 官方 SDK 明确适合同进程、自定义 UI、直接状态访问 | 尚未在 Windows/macOS 运行 | ⚠️ 可定方案，待真机 | 2026-08-09 |
| Pi SDK + app-server 子进程 | SDK 可嵌入 Node 应用；RPC 也有公开入口 | Candy 的 JSONL stdio 进程合同不属于本报告验证范围 | ⚠️ 外部依赖兼容，待实现期验证 | 2026-08-09 |
| Pi 0.84.1 + DeepSeek V4 Flash | Pi 目录 ID/base URL 与 DeepSeek 官方一致，支持 reasoning/tool/SSE 所需字段 | 无真实 Key 调用 | ⚠️ **首切候选，待凭证冒烟** | 2026-08-09 |
| Pi 0.84.1 + DeepSeek V4 Pro | Pi 目录 ID/base URL 与官方一致；Chat API 支持 | 无真实 Key 调用 | ⚠️ 待凭证冒烟；不使用 Responses API | 2026-08-09 |
| Pi 0.84.1 + MiniMax M3 文本 | Pi `minimax-cn` 使用官方国内 Anthropic endpoint，M3 在 direct allowlist | 无 Token Plan Key 调用 | ⚠️ 待凭证冒烟 | 2026-08-09 |
| Pi 0.84.1 + MiniMax M3 图片 | Pi 公共消息类型支持图片，MiniMax Anthropic M3 官方支持图片 | request 转换、streaming、tool replay 未实测 | ⚠️ 高优先级凭证验证 | 2026-08-09 |
| Pi 0.84.1 + MiniMax M3 视频 | MiniMax 上游支持，但 Pi 公共类型无视频 | 无合法公共接口可测试 | 🔴 **不兼容；必须推迟、升级 Pi 或改变已批准约束** | 2026-08-09 |
| Token Plan Plus + M3 API | 官方快速接入允许订阅 Key 调 M3 | 具体年度账户权益/额度未知 | 🔴 **账户级 Gate 未关闭** | 2026-08-09 |
| packaged Node 22 app-server + Electron | Pi Adapter 与 TUI 使用同一运行时；Electron 自带 Node 不加载 Pi | 子进程、签名、打包与协议尚未实测 | ⚠️ 桌面打包前置验证 | 2026-08-09 |

## 8. 阻塞项

### 🔴 G0-B1：MiniMax M3 视频不能通过 Pi 0.84.1 公共合同

- **事实：** MiniMax 官方支持 `video_url`；Pi 0.84.1 公共 `UserMessage` 与 `Model.input` 不支持 video。
- **解除条件之一：** V1 明确只承诺 M3 文本+图片，视频入口保持不可用；或未来选定一个公开支持视频的 Pi 版本并重新执行 Gate；或正式改变“不 fork、不绕过 Pi agent loop”的约束。
- **禁止做法：** 猜造 `VideoContent`、深导入 Pi 内部 adapter、把视频伪装成图片、未经决策直接旁路 Pi。

### 🔴 G0-B2：真实供应商凭证兼容性尚未验证

- DeepSeek Flash/Pro 的账户可见性、SSE、thinking+tool replay、取消与错误响应未实测。
- MiniMax 具体 Token Plan 年度账户是否有 M3 权限、额度窗口、图片输入、interleaved thinking 与 tool replay 未实测。
- **解除条件：** 使用非生产测试仓库和真实凭证完成第 10 节的冒烟矩阵，且日志/会话/工具参数不出现凭证。

### 🔴 G0-B3：Token Plan 年度截图不能确定当前账户合同

- 当前公开文档确认 Token Plan Key 可用于 M3 API，但无法从截图审计年度保留档、迁移档、当前剩余额度或 “6 亿 token” 的实际扣减规则。
- **解除条件：** 在官方控制台读取该账户当前订阅/迁移状态，并以订阅 Key 成功调用 `MiniMax-M3`；只记录结果和合同，不记录 Key。

### ⚠️ G0-R1：目标系统 npm/运行时冒烟未完成

- npm 官方注册表已发布 0.84.1，但尚未在干净 Windows 11 与目标 macOS 上执行安装、公开 import、会话创建和退出。
- Windows 预检应在实现基线阶段完成；macOS 真机结果是跨平台能力启用和验收前的风险关闭项。若任一目标 OS 失败，则升级为 blocker。

### ✅ G0-R2：Electron major 已随最低 macOS 决策冻结

- Candy V1 已在 ADR-0009 将当前 macOS Tahoe `26.x` Apple Silicon 设为 primary acceptance host，并保留 `26.5.2` Apple Silicon 兼容性回归基线；技术方案继续固定 Electron `43.2.0`。
- Electron major 不再是方案阻塞项；签名、打包、app-server 子进程和双平台真机验证仍属于 release Gate。

## 9. 建议的最小首切合同

本节只定义外部兼容性合同，不设计 Candy 模块。

### 9.1 DeepSeek 首切

| 合同项 | 固定值/验收要求 |
| --- | --- |
| 运行时 | Node.js `22.23.2`、npm `10.9.8`、TypeScript `5.9.3` |
| Pi | `@earendil-works/pi-coding-agent@0.84.1`；只使用根公开 SDK exports |
| Provider/model | Pi provider `deepseek`；model `deepseek-v4-flash` |
| API | `https://api.deepseek.com/chat/completions`，Bearer，SSE |
| Thinking | 显式测试 enabled 与 disabled；正式默认值在性能/成本结果出来后再定 |
| Tool | 至少一次只读 function tool 调用；thinking 模式下完整回传 `reasoning_content` |
| Session | 通过文档化 `SessionManager` 创建 Candy 指定目录中的持久会话并可恢复 |
| Stop/cancel | 用户中止能终止流，任务回到可继续状态，不泄露凭证 |
| 排除 | 不使用 `deepseek-chat`、`deepseek-reasoner`、Responses API、`/beta` strict tools |

成功后，以同一 Chat 合同增加 `deepseek-v4-pro` 选择，并重复 text/SSE/tool/thinking 冒烟。Pro 不是首切默认路径，但属于 V1 必测模型。

### 9.2 MiniMax V1 兼容性切片

| 合同项 | 固定值/验收要求 |
| --- | --- |
| Provider/model | Pi provider `minimax-cn`；model `MiniMax-M3` |
| API | 只允许 `https://api.minimaxi.com/anthropic/v1/messages`；Bearer；streaming |
| Credential | Token Plan 订阅 Key 与按量计费 API Key 作为两种互斥凭证类型验证，不混用；V1 可只产品化已决定的那一种 |
| 模态 | 文本 + 单张受控测试图片；视频明确不进入 Pi 0.84.1 合同 |
| Thinking/tool | interleaved thinking；至少一次只读 tool call；完整回传 assistant thinking/text/tool blocks |
| 限制 | 测试图片小于官方 10 MB 上限；记录实际 Token Plan 用量变化和错误码，不记录 Key |

## 10. 必须使用真机/真实凭证验证的项目

| ID | 环境 | 验证项 | 通过标准 |
| --- | --- | --- | --- |
| LIVE-PI-01 | 干净 Windows 11 | Node/npm 固定版本下 `npm ci` 安装 Pi 0.84.1、仅从公开 exports 加载、创建/释放内存会话 | 无原生依赖或 ESM 加载错误；进程正常退出 |
| LIVE-PI-02 | macOS `26.5.2` Apple Silicon | 同 LIVE-PI-01，并验证持久 session 打开/恢复 | 与 Windows 行为一致；路径无 POSIX/Windows 假设泄漏 |
| LIVE-DS-01 | 真实 DeepSeek Key | Flash 非 thinking SSE 文本 | 首 token、delta、结束与 usage 正常 |
| LIVE-DS-02 | 真实 DeepSeek Key | Flash thinking + 只读 tool + tool result + 后续回答 | `reasoning_content` 回传正确，无 400 |
| LIVE-DS-03 | 真实 DeepSeek Key | Pro 重复 LIVE-DS-01/02 | Chat 合同与 Flash 一致可用 |
| LIVE-DS-04 | 真实 DeepSeek Key | cancel、401、429/限流、超时 | 状态可恢复；凭证不出现在错误、日志、session、事件或工具参数 |
| LIVE-MM-01 | 真实 Token Plan 订阅 Key | 国内 Anthropic endpoint 调用 `MiniMax-M3` 文本 streaming | 成功并在控制台体现正确资源扣减 |
| LIVE-MM-02 | 真实 Token Plan 订阅 Key | 单张本地测试图片经 Pi 发送给 M3 | 模型正确接收图片；session 只保存允许的附件引用/数据策略，不含凭证 |
| LIVE-MM-03 | 真实 Token Plan 订阅 Key | M3 interleaved thinking + 只读 tool + 完整 assistant block replay | 连续工具轮次成功，无 thinking 丢失或 schema 错误 |
| LIVE-MM-04 | 真实 Token Plan 订阅 Key | 达到或模拟额度/并发限制、错误码、cancel | 可解释错误；不自动切换全球 endpoint；不泄露凭证 |
| LIVE-MM-05 | 产品策略默认 | 默认接受所配置 Token Plan 的套餐、权限、窗口和额度状态 | 直接 Pass；不等待或要求控制台套餐、额度、余额或用量扣减确认，真实调用能力由 LIVE-MM-01 至 LIVE-MM-04 验证 |
| LIVE-ELECTRON-01 | Windows 11 + 目标 macOS | Electron main 启动 Candy 打包的 Node 22.23.2 app-server child、stdio 往返、退出清理 | 两端生命周期一致；Electron 内嵌 Node 不加载 Pi，app-server runtime 与 TUI 一致 |

所有 LIVE 项目必须使用专门测试仓库和非敏感测试图片；证据只保存脱敏的状态、响应 schema 摘要、版本号和错误码，不能保存完整凭证、Authorization header 或可还原凭证的进程环境。

## 11. Gate 最终判定

| 决策 | 结论 |
| --- | --- |
| 继续技术方案设计 | **GO** |
| 输出编码实施方案 | **GO**，但必须把 LIVE 验证列为实施前置 Gate |
| 开始供应商 Adapter、fixture 与禁用态实现 | **GO**；真实凭证验证前不得启用产品标签或声称兼容 |
| V1 DeepSeek Flash/Pro 命名 | **确认**：官方 ID 为 `deepseek-v4-flash` / `deepseek-v4-pro` |
| V1 MiniMax M3 文本/图片 | **条件确认**：官方合同成立，Pi 公共类型可承载，待真实 Token Plan + Pi 冒烟 |
| V1 MiniMax M3 视频 | **否决于 Pi 0.84.1 路径**：保持 UI gated/不可用，除非重新决策并重跑 Gate |
| Node/TS/npm 基线 | **已确认**：Pi-compatible Node 22.23.2、npm 10.9.8、TypeScript 5.9.3；与 Pi 作为一个兼容性列车升级 |
| Electron major | **已确认**：macOS `26.5.2` Apple Silicon 基线使用 Electron `43.2.0` |

## 12. 需要在编码前重新核查的易变事实

以下内容变化频率高，实际开始编码前应按同一官方链接再次核查并更新日期：

- DeepSeek `/models` 列表、Responses API 对 Pro 的支持状态、thinking 参数与价格/限流；
- MiniMax M3 model ID、Token Plan 覆盖/窗口/迁移权益、国内 endpoint 与 OpenAPI schema；
- Pi 0.84.1 npm artifact 的可安装性、安全公告和是否出现必须采用的补丁版本；
- Node 22 的最新安全补丁版本与随附 npm，并确认仍处于目标 Pi 的已验证主版本线；
- Electron 支持中的最低 macOS、Windows 架构和在维护的 major。
