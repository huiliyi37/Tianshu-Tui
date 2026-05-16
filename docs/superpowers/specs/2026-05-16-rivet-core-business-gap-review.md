# Rivet 非 Context 核心业务缺口审查与修复路线

## 背景

Rivet 的业务目标是让 DeepSeek V4 / OpenAI-compatible provider 在本地编码任务中具备接近 Claude Code / opencode 的可用性。Context layer 与 cache safety 是底座，但不是全部。一个 terminal coding agent 真正可用，还需要以下能力闭环：

1. **安全执行**：高影响工具必须可控、可解释、可审计。
2. **结果可信**：修改后必须有 verification / evidence 支撑，而不是只靠模型口头总结。
3. **失败可恢复**：长任务中遇到 flaky、timeout、测试失败、重复错误时，agent 要能改变策略。
4. **并行协作**：复杂任务应能拆给子代理执行、审查、验证，而不是全部压在单上下文里。
5. **状态可见**：用户应能在 TUI 中看到风险、验证、上下文、模型、trace，而不是黑盒等待。
6. **生态可扩展**：MCP、本地工具、repo intelligence、模型路由要纳入同一能力面。
7. **设计与实现同步**：快速推进的计划必须有状态台账，避免“文档完成”被误当作“能力完成”。

本文排除已经单独安排开发的 Context Layer / Cache Architecture 线，只记录其它核心业务偏离。

---

## 当前核心缺口总览

| 优先级 | 缺口 | 业务影响 | 状态 |
|--------|------|----------|------|
| P0 | Tool Safety + Approval Policy | 用户不敢开放自动执行；高风险工具边界不稳 | ✅ **Closed** — `assessToolRisk()` + delivery gate + evidence tracker |
| P0 | Verification / Evidence 闭环 | agent “说完成”但不能证明完成 | ✅ **Closed** — evidence gate bypass fixed, `aggregateResults()` gates unverified workers |
| P1 | Execution Resilience | 长任务遇错容易重复失败或停在局部补丁 | ✅ **Closed** — `suggestStrategyShift()` detects 4 doom-loop patterns |
| P1 | Sub-agent Orchestration | 复杂任务仍主要靠单 agent 硬撑 | ✅ **Closed** — evidence gate in `delegate()`, dynamic worker prompts |
| P1 | Cockpit Observability | 用户看不到 agent 为什么做、是否安全、是否验证 | ✅ **Closed** — `CockpitSnapshot` aggregator + panel statuses + MCP panel |
| P2 | MCP Integration | 连接层已有，但没有纳入统一权限/trace/evidence | ✅ **Closed** — `classifyMcpError()` 5-class taxonomy + MCP cockpit panel |
| P2 | Model Routing | open model 弱点没有被任务级策略补偿 | ✅ **Closed** — `TaskInferrer` + per-turn routing in AgentLoop |
| P2 | Repo Intelligence | 影响面、相关测试、调用链仍靠手工探索 | ✅ **Closed** — `buildImportGraph()` + `generateImpactHint()` + evidence integration |
| P3 | Implementation State Ledger | 设计文档推进快于实现状态沉淀 | ✅ **Closed** — `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md` |

---

## P0：Tool Safety + Approval Policy

### 当前偏离

Rivet 已有工具注册、approval mode、hook registry、approval-risk card，但安全能力仍是点状的：

- `web_fetch` 需要确保 redirect 后目标也经过 SSRF/private IP 校验。
- `bash` / `git` / `web_fetch` / `undo` / future MCP tools 的风险模型尚未统一。
- `AgentLoop.isHighRisk()` 是局部正则规则，不能解释风险来源、风险级别、建议动作。
- PreToolUse hook 能 block，但 TUI 缺少统一风险解释。
- approval 与 evidence、trace、cockpit 没完全串起来。

### 业务需要

开放模型在工具使用上比闭源模型更需要安全边界。Rivet 如果想支持更高自动化，必须让用户清楚知道：

```text
这个工具为什么危险？
它会影响哪些文件/网络/进程？
为什么需要确认？
如果被 block，是哪条 policy 生效？
```

### 修复目标

- 建立 `ToolSafetyPolicy`，输出结构化 `RiskAssessment`。
- 所有高影响工具共享同一风险模型。
- `web_fetch` redirect 后重新校验 URL/IP。
- PreToolUse block、approval prompt、cockpit safety panel 使用同一份 risk assessment。
- 测试覆盖 destructive shell、force push、external URL、redirect private IP、absolute path、rollback/undo。

---

## P0：Verification / Evidence 闭环

### 当前偏离

Rivet 已有 `run_tests`、verification metadata、EvidenceTracker、VerificationPanel，但交付证据链还不够硬：

- 失败/blocked 的 verification metadata 可能因 `harnessResult.isError` 分支而未进入 evidence。
- Evidence badge 与 final answer 没有形成强制交付 gate。
- 修改文件、相关测试、验证范围之间没有统一状态。
- TUI 展示 verification，但不能明确告诉用户“本次交付是否可相信”。

### 业务需要

coding agent 的交付必须从“模型说已经完成”升级到“系统证明哪些已完成、哪些未验证”。尤其开放模型可能更容易过度自信，因此需要 evidence-first 输出。

### 修复目标

- `run_tests` 无论 pass/fail/blocked 都记录 verification metadata。
- `EvidenceTracker` 区分 `passed`、`failed`、`blocked`、`not-run`。
- 当本 turn 有 edit/write 但没有相关验证时，final badge 明确显示 verification gap。
- VerificationPanel 显示“交付状态”：verified / failed / blocked / unverified。
- Final answer 自动附带最小 evidence summary。

---

## P1：Execution Resilience

### 当前偏离

已有 TurnHarness、failure classifier、trajectory、trace-store、behavior mirror、decision anchor，但它们尚未形成统一 runtime policy：

- retry 次数语义需与配置一致。
- retry 只应处理 timeout/flaky/transient，不应重复执行确定性失败。
- failure classifier 的结果没有稳定驱动下一步动作。
- doom-loop / behavior mirror 仍偏观察，没有成为 block 或 strategy-shift 机制。
- trajectory 记录没有充分用于恢复策略。

### 业务需要

真实开发任务不可避免会遇到失败。Rivet 需要比普通 chat agent 更像工程执行系统：失败后知道是重试、换命令、读错误、请求用户，还是停止。

### 修复目标

- 明确 `maxRetries` 语义：`maxRetries=2` 表示最多 1 次原始执行 + 2 次 retry。
- retry policy 只允许 retryable failure class。
- consecutive same failure 触发 doom-loop warning/block。
- failure classifier 输出建议进入 tool result diagnosis 和 cockpit safety panel。
- trace summary 能解释“为什么重试/为什么停止”。

---

## P1：Sub-agent Orchestration

### 当前偏离

Phase 1 已验证 delegate_task read-only worker、coordinator、work-order、aggregation 等基础。但核心业务仍没完全落地：

- 主控不能稳定把复杂任务拆成多个 work orders。
- worker 结果缺少强 review/verification gate。
- 多 worker 修改冲突、证据合并、失败重派策略不足。
- worker 的 working set / verification / trace 没完全回流主控。

### 业务需要

开放模型的单体能力不足时，多代理拆分是重要补偿路径。Rivet 需要让主控模型能把大任务拆成探索、实现、审查、验证等独立工单，并把结果安全合并。

### 修复目标

- 增加 work order planner：从用户任务生成 read/review/implement/verify 工单。
- Worker result 必须包含 `summary`、`filesRead`、`filesChanged`、`verification`、`risks`。
- Aggregator 拒绝没有 evidence 的实现型 worker result。
- 主控 TUI 显示 worker queue、running、passed、failed、blocked。
- 支持失败 worker 的 repair work order。

---

## P1：Cockpit Observability

### 当前偏离

已有 cockpit panels，但更像组件集合，还没有成为统一控制面：

- Trace / Verification / Context / Safety / Model 的 state 来源不统一。
- 用户看不到“当前是否可交付”的单一判断。
- 风险、验证、模型、上下文各自展示，缺少聚合摘要。
- ApprovalRiskCard 与实际 ToolSafetyPolicy 尚未统一。

### 业务需要

Rivet 的 TUI 应是用户信任界面。用户不应从长日志里猜 agent 状态，而应一眼看到：安全、验证、上下文、模型、执行轨迹。

### 修复目标

- 建立 `CockpitState` 聚合器。
- Summary rail 显示 safety / verification / context / model 的状态灯。
- Verification failed 或 safety blocked 时，cockpit summary 明确标红。
- 当前 panel 展示来自同一 state snapshot，而不是各自拼数据。

---

## P2：MCP Integration

### 当前偏离

MCP manager/wrapper/config 已有，但还没有成为产品化工具生态：

- MCP tool 的 risk assessment 与本地工具未统一。
- MCP server health 未进入 cockpit。
- MCP call failure 没有分类恢复。
- 用户很难知道某个 MCP tool 来自哪个 server、需要什么权限、失败原因是什么。

### 修复目标

- MCP tool wrapper 输出 server/name metadata。
- MCP tools 进入 `ToolSafetyPolicy`。
- Cockpit Model/Safety 或独立 MCP section 显示 server connected/error/tool count。
- MCP failure classified into config/auth/network/tool-error。

---

## P2：Model Routing

### 当前偏离

已有 `ModelCapabilityCard` 和推荐函数，但没有进入主执行策略：

- 不同任务类型没有系统选择模型。
- 高风险编辑、debug、review、verification 没有使用不同模型策略。
- 模型表现没有根据验证结果反馈更新。
- provider-specific 差异没有进入 prompt/tool-use 策略。

### 修复目标

- 定义 task profile：chat、edit、debug、review、verify、subagent-worker。
- AgentLoop / coordinator 根据 task profile 选择 model recommendation。
- 验证结果回写 capability metrics。
- TUI 显示当前模型选择原因。

---

## P2：Repo Intelligence

### 当前偏离

已有 symbol index、import graph、context bundle，但没有进入默认 agent 决策链：

- 修改文件后不能自动提示相关测试/调用方。
- 读文件前没有使用 repo bundle 优先定位。
- working set 与 import graph 没完全联动。

### 修复目标

- edit/write 后生成 impact hint。
- run_tests 建议能基于 import graph 找相关测试。
- `/context` 或 cockpit 展示 current impact radius。
- AgentLoop 在 final evidence 中显示 impacted files/tests。

---

## P3：Implementation State Ledger

### 当前偏离

Rivet 现在有大量设计/计划/验证文档，推进速度快，但状态容易混淆：

- 设计完成、计划完成、MVP 完成、验证通过不是一回事。
- 某些 plan 标记完成但实现只覆盖部分目标。
- 后续工程师需要一个总表判断“该修什么，不该重复什么”。

### 修复目标

- 建立 `docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`。
- 每个能力记录：design doc、plan doc、implementation files、validation status、known gaps、next action。
- 每次完成一个能力后更新 ledger。

---

## 推荐执行顺序

```text
1. Cache Safety / Context Layer        已单独安排（Verified）
2. Tool Safety + Verification Evidence P0 ✅ Closed
3. Execution Resilience                P1 ✅ Closed
4. Sub-agent Orchestration             P1 ✅ Closed
5. Cockpit Observability               P1 ✅ Closed
6. MCP / Model Routing / Repo Intel    P2 ✅ Closed
7. Implementation State Ledger         P3 ✅ Closed
```

All P0-P2 gaps closed. 620 tests, typecheck clean. Remaining work is on the Planned capabilities (Multi-pass Repair, CTCL Migration, Gap Closing, Performance Optimization, etc.) tracked in the capability ledger.
