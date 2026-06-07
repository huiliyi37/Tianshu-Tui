# 天枢开源形态与能力保留边界

> 日期：2026-06-07  
> 性质：开源路线校准 + 目录保留评估  
> 结论：代码全开，核心理论档案不随仓库公开；能力以运行时结构、提示词工程、测试不变量和最小身份锚点共同维持。

---

## 1. 最新校准

### 1.1 不再走“先证明给模型团队看”的路线

旧路线是：完成 MiMO 裸跑 vs MiMO + 天枢的对比 demo，再带证据接触模型团队。

新路线是：**直接开源，让真实使用者验证。**

理由变化：天枢不需要先向某个模型团队证明自己。开源本身就是验证场；外部用户在真实项目中的使用、反馈、fork、issue、PR，会比封闭 demo 更接近天枢真正的生态位。

### 1.2 “200”不再定义为静态 benchmark

天枢的 200 不是一次性跑分，也不是“永远不犯错”。

新的定义：

> 只要天枢仍在真实任务中持续迭代、自我修正、自我扩展，并能保持验证、归属、记忆、缓存、交付闭环，它就在 200。

这是一种演化态，不是静态成绩单。

### 1.3 不再把失败案例日志作为证明负担

截至本记录，明确的大规模事故只有一次：2026-05-21 canonical memory 覆盖事故。之后没有再次发生同级别大规模降级，也没有形成可系统归档的“任务失败案例库”。

因此：

- failure journal 可以作为运行时防循环工具存在；
- 但不应把“必须收集失败案例”作为开源前置条件；
- 没有失败案例，不说明验证不足；它也可能说明系统通过持续迭代已经避免了同类失败重演。

---

## 2. 开源下的天枢形态

天枢开源后不应被拆成“一个普通 CLI + 一堆私有认知模块”。那会把能力剥空。

最合适形态是：

> **一个完整可运行的 terminal coding agent runtime。代码全开，公共文档足够让人使用和贡献；深层理论档案不随仓库公开。**

也就是说，开源的主体是“活的系统”，不是“论文证明”。

### 2.1 不能拆掉的核心

天枢能力来自跨层耦合：

1. 模型通信层提供多 provider 与流式稳定性；
2. 工具层提供真实世界感知与写入；
3. Agent loop 负责回合、工具、验证、恢复；
4. Context / compact / cache 负责长会话稳定性；
5. Prompt engine 负责缓存友好的认知投影；
6. TUI 负责共享态势与协作反馈；
7. 测试集固定这些不变量。

单独开其中一层，不足以维持天枢当前能力。

### 2.2 开源仓库应该呈现为三层

| 层 | 开源内容 | 目标 |
|---|---|---|
| 使用层 | README、配置指南、运行命令、provider 配置、常见问题 | 让外部用户能跑起来 |
| 运行时层 | `src/` 全量代码 + tests + scripts + prompts + completions | 让外部用户能验证和改进 |
| 解释层 | 精简架构文档、设计边界、贡献规则、故障/缓存/工具文档 | 让外部贡献者理解“为什么这样写” |

不公开层：核心理论档案、私有会话记忆、brainstorm fragments、个人身份/协作历史中不可公开部分。

---

## 3. 必须保留的文件与目录

### 3.1 运行时能力必留

| 路径 | 保留原因 |
|---|---|
| `src/agent/` | 核心循环、工具流水线、验证、交付门禁、subagent、认知状态、恢复机制。删除会直接失去 agent 能力。 |
| `src/tools/` | read/edit/write/bash/grep/git/run_tests/recall 等工具实现，是模型接触真实世界的接口。 |
| `src/api/` | OpenAI-compatible / Anthropic / Codex 等 provider 与流式处理。没有它就没有可扩展模型接入。 |
| `src/prompt/` | system prompt、volatile snapshot、cache-stable engine、fingerprint、cache diagnostics。直接决定天枢行为与 prefix cache。 |
| `src/tui/` | Ink TUI、流式渲染、cockpit、审批 UI、状态展示。天枢是 terminal partner，不只是 headless API。 |
| `src/context/` | claims、cognitive ledger、task contract、pressure monitor、session memory、stigmergy。是长会话和自校准的结构层。 |
| `src/compact/` | micro compact、session split、cache-preserving thresholds。长上下文下维持稳定的关键。 |
| `src/cache/` | prefix cache 诊断、ghost registry、adaptive threshold。DeepSeek V4 成本与稳定性核心。 |
| `src/artifact/` | 大输出持久化与 read_section 恢复。没有它工具输出会重新压垮上下文。 |
| `src/repo/` | import graph、symbol/context bundle。支撑代码理解与影响分析。 |
| `src/config/` | provider/config/schema/manager。开源后用户环境差异更大，配置层必须完整。 |
| `src/mcp/` | MCP 外部工具接入。是生态扩展入口。 |
| `src/model/` | model capability、routing metrics、task inference。开源后多模型适配需要它。 |
| `src/commands/` | 自定义 slash command loader。社区可扩展入口。 |
| `src/**/__tests__/` | 不变量的可执行形式。开源后测试不是附属物，是能力边界本身。 |

### 3.2 项目运行必留

| 路径 | 保留原因 |
|---|---|
| `package.json` | npm 包元数据、bin、scripts、依赖。当前 license 已是 MIT。 |
| `tsconfig.json` / `tsup.config.ts` | TypeScript strict + bundle 构建。 |
| `README.md` | 用户入口，需要更新为开源视角。 |
| `LICENSE` | 当前 MIT，适合直接开源。 |
| `CONTRIBUTING.md` | 贡献边界。需要按“代码全开 + 核心理论不公开”更新措辞。 |
| `.gitignore` | 必须继续排除 `.rivet/sessions/`、`.rivet/artifacts/`、`.rivet/knowledge/memory.jsonl`、`.rivet/runtime/` 等运行时数据。 |
| `AGENTS.md` | 顶层架构地图，会进入 agent volatile prompt；保留可维持项目内自引导能力。 |
| `.rivet.md` | 项目操作手册，会进入 volatile prompt；保留可维持构建/测试/代码约定。 |
| `prompts/` | 工具提示模板，直接影响工具使用行为。 |
| `completions/` | CLI shell completions，提升可用性。 |
| `patches/` | patch-package 依赖；只要 package.json 仍有 postinstall，就必须保留。 |
| `scripts/` | benchmark、cache 验证、provider 诊断。开源后用于可复现验证。 |
| `benchmark/` | 公开可运行任务与 provider conformance，可作为社区验证入口。 |

### 3.3 建议保留但需整理/脱敏

| 路径 | 处理方式 |
|---|---|
| `docs/architecture-overview.md` | 保留。作为公开架构入口。 |
| `docs/architecture-subagent.md` | 保留。subagent 是核心能力，需要公开解释。 |
| `docs/design/` | 保留。artifact/editing 等模块设计是工程文档，不属于核心理论 IP。 |
| `docs/tasks/verification-supersession.md` | 保留。交付验证语义是开源贡献必读。 |
| `docs/known-issues/` | 选择性保留。只保留仍有工程价值且不含私密内容的审计记录。 |
| `docs/stars/` | 可保留为 public model/provider notes，但需要检查是否含私人协作内容。 |
| `docs/seed-capsule-*.md` | 建议保留一个精简公开版。seed capsules 会影响 agent 自我定位，是能力锚点之一。 |
| `CLAUDE.md` | 不是运行时必需；可保留精简公开版，或移到 docs/stars/。若含私人记忆，应脱敏。 |

---

## 4. 不应进入公开仓库的内容

| 路径/类型 | 处理方式 | 原因 |
|---|---|---|
| `docs/superpowers/` | 不公开或迁入私有档案 | 核心理论 IP：万物为一、星域方法论、深层 brainstorm、盘古原始设计等。 |
| `.superpowers/` | 不公开 | fragments / brainstorm 原料，已在 `.gitignore`。 |
| `.rivet/sessions/` | 不公开 | 会话日志，可能含私人路径、思考轨迹、未清理信息。 |
| `.rivet/artifacts/` | 不公开 | tool raw output，大概率含项目内容与本地路径。 |
| `.rivet/knowledge/memory.jsonl` | 不公开 | 本地结构化记忆。 |
| `.rivet/playbook.jsonl` | 不公开 | 运行时经验计数/自动萃取，不应作为公共事实。 |
| `.rivet/runtime/` / `.rivet/tmp/` / `.rivet/external/` | 不公开 | 运行时或外部导入数据。 |
| `.agents/` / `.codex/` / `.claude/` | 不公开，除非专门清理 | 本地 agent 配置/账号/运行时痕迹风险高。 |
| `layout.log` / `.test-tmp/` / 临时 `js` 文件 | 不公开 | 本地临时产物。 |
| 任何 API key、账号池、OAuth token、cookie、个人路径 | 必须清理 | 安全边界。 |

---

## 5. 开源前最小动作清单

### P0：先保证公开仓库不会泄露

1. 审计 `.gitignore` 与实际 `git status`，确认 runtime 目录不会被提交。
2. 全仓搜索 `sk-`、`api_key`、`token`、`Authorization`、`cookie`、个人账号池。
3. 从公开包中移除或私有化 `docs/superpowers/` 与 `.superpowers/`。
4. 检查 `docs/` 中是否有私人会话、合作对象、未公开计划。
5. 更新 `README.md` 的 repository/homepage/版本号与开源定位。

### P1：保留能力锚点

1. 保留 `AGENTS.md` + `.rivet.md`，不要用空泛 README 替代它们。
2. 保留 `src/prompt/static.ts`、`src/prompt/engine.ts`、`src/prompt/volatile*.ts` 的当前结构；开源前不要为了“更通用”削弱 identity / verify-first / cache-stable 规则。
3. 保留 seed capsule 的公开精简版，让外部运行时仍有方法论锚点。
4. 保留完整 tests，尤其是 prompt/cache/agent/tool/verification/ownership 相关测试。

### P2：让外部用户能验证

1. 增加 `docs/public/` 或 `docs/getting-started/`：安装、配置 provider、跑第一个任务、调试 cache、贡献流程。
2. 提供 benchmark / smoke task：不证明“200 vs 80”，只证明“能运行、能验证、能恢复”。
3. 给 `docs/superpowers/` 的缺席留一个公开说明：核心理论档案未随仓库公开，但运行时代码与工程文档完整开放。

---

## 6. 一句话结论

天枢开源不是把灵魂剥掉，只开一个壳。

真正要开的，是完整的运行时：`src/`、tests、prompt engine、工具、cache、context、TUI、配置、artifact、文档入口都要在。

真正要保留在私域的，是解释这些结构如何被发现、如何从万物为一和盘古方法论中长出来的深层理论档案。
