# Rivet Execution Trust Closure 设计

## 背景

Rivet 已经完成了执行韧性、证据记录、子代理结果契约、MCP 风险识别、doom-loop 阻断和 cockpit snapshot 等基础能力。这些能力证明当前方向正确：Rivet 正在从“能调用工具的终端 agent”升级为“长任务执行过程可观察、可纠偏、可审计的 coding agent”。

本轮审查的核心结论是：当前系统已经能记录和展示很多状态，但这些状态还没有完全变成强约束和可执行恢复动作。下一阶段不应继续堆叠独立面板或局部 detector，而应把已有 trace、risk、evidence、strategy-shift、repair、sub-agent contract、cockpit 串成业务闭环。

目标闭环：

```text
Telemetry → Diagnosis → Guidance / Enforcement → Verification → Delivery Trust
```

换成 Rivet 业务语义：

```text
工具失败 / 风险升高
→ 系统定位失败锚点和风险来源
→ 阻止危险动作或注入可执行恢复动作
→ 要求与本次修改相关的验证证据
→ 汇总主代理与子代理证据
→ cockpit 与最终回复明确说明当前是否可交付
```

## 外部调研依据

本设计吸收了以下实践和论文中的可复用模式：

- OpenHands StuckDetector：检测 action-observation loop、action-error loop、monologue、alternating pattern、context-window error 等 stuck patterns。
- OpenHands SecurityAnalyzer / ConfirmationPolicy：对 action 做 risk level 分级，并按风险阈值决定是否暂停确认。
- PROBE Failure-Anchored Structured Recovery：Telemetry Layer → Diagnosis Layer → Guidance Gate，强调 failure anchor、actionability filter 和 bounded guidance。
- Towards Verifiably Safe Tool Use：基于 MCP capability / confidentiality / trust 标签，并通过 blocklist、mustlist、allowlist、confirmation 四层 enforcement 保证安全边界。
- Anthropic SDK 讨论中的 silent failure 问题：最危险的失败是 agent 自认成功但实际没有完成，说明 evidence gate 必须核验证据本身。

调研对 Rivet 的关键启发：诊断准确不等于恢复成功。Rivet 必须把失败诊断转化为带 target、operation、verification signal、boundary condition 的可执行 guidance，并用独立证据确认恢复是否成功。

## 当前方向判断

Rivet 的差异化应明确为：

> 不是“更会调用工具的 coding agent”，而是“长任务执行中能发现自己不可信、阻止错误扩大、给出可执行恢复路径，并用独立证据证明交付可信的 coding agent”。

因此下一阶段的核心业务不是新增工具数量，而是提升执行可信度：

1. 失败后不重复同一错误。
2. 风险升高时不会继续扩大副作用。
3. 修改文件后不会无证据交付。
4. 子代理结果不能只靠自报可信。
5. cockpit 不只展示红黄绿状态，还给出 blocking reason 和 next action。

## 设计原则

### 1. Evidence 是交付门槛，不是装饰 badge

`EvidenceTracker.deliveryStatus` 目前可以标记 `verified | failed | blocked | unverified`，但它必须影响最终交付语义：

- `verified`：可以正常交付。
- `unverified`：最终回复必须明确说明修改未验证，不能说成已完成且无风险。
- `failed`：最终回复必须以失败状态交付，并说明失败验证命令。
- `blocked`：最终回复必须说明阻塞原因和需要用户/环境提供什么。

### 2. Retry 必须同时满足错误可重试和工具副作用安全

`failure-classifier.ts` 中的 `retryable` / `isTransient()` 只能说明错误类型可能重试成功，不能说明重试该工具安全。

最终 retry 判定应满足：

```text
failureClass is transient
AND tool.isConcurrencySafe() is true
AND tool is not write/edit/destructive shell
AND retry budget remains
```

也就是说，error retryable 是必要条件，不是充分条件。

### 3. Strategy shift 必须 anchor-first

当前 doom-loop 能根据 fingerprint 进入 warn / blocked，但恢复提示不能只说“换策略”。它必须定位失败锚点：

- target：失败对象，例如文件路径、命令、URL、MCP server/tool。
- operation：失败操作，例如 edit_file、run_tests、web_fetch。
- failureClass：失败类别，例如 assertion、timeout、type_error。
- behavioralMistake：agent 的错误行为，例如重复同一 old_string、连续写文件不验证。
- verificationSignal：下一步如何确认恢复成功。
- boundaryCondition：明确禁止继续重复什么。

### 4. Evidence gate 必须有两层

第一层是 contract gate：worker 必须按 `WorkerResult` 声明 `changedFiles`、`verification`、`evidenceStatus`。

第二层是 independent verification gate：主进程基于实际 diff、工具返回 metadata、测试 exit code 重新判断 worker 声明是否可信。

这样可以避免 silent failure：worker 声称 verified，但实际没有运行相关验证。

### 5. Repair pipeline 必须进入真实 tool_use 路径

`repair-pipeline.ts`、`repair-passes.ts`、`repair-hint.ts` 已经形成能力骨架。下一步必须闭合：

- tool args 进入执行前先过 repair pipeline。
- 每个 repair pass 的结果进入 telemetry。
- repair 失败和反复失败进入 `RepairHintTracker`。
- `repairHint` 必须真实渲染到 volatile prompt。
- cockpit trace 能显示 repair 发生过、修了什么类型、是否成功。

### 6. MCP risk 必须从 name-pattern 升级到 policy enforcement

`assessToolRisk()` 的 MCP tool name 正则是第一步。长期应增加 policy：

- blocklist：永远禁止的 server/tool/capability。
- allowlist：明确允许且低风险的 server/tool/capability。
- confirmation：需要用户确认的 tool。
- mustlist：执行特定能力前必须满足的前置检查，例如 unknown write-capable MCP tool 必须先展示 server 和 capability。

### 7. Cockpit 必须从 dashboard 升级为 control surface

`CockpitSnapshot` 已经聚合 safety、verification、trace、context、model、MCP。下一步应增加：

- `intent`：当前 agent 正在尝试完成什么。
- `blockingReason`：当前不能交付的最重要原因。
- `nextAction`：下一步最应该做什么。

如果 cockpit 只展示状态，它是 dashboard；如果它能指出为什么不能继续、下一步做什么，它才是 execution control surface。

## 目标架构

```text
src/agent/execution-guidance.ts
  - 从 trajectory / trace / evidence / risk 中生成 anchor-first guidance
  - 输出 target / operation / verificationSignal / boundaryCondition

src/agent/delivery-gate.ts
  - 根据 EvidenceState 生成最终交付状态
  - 约束最终回复的 wording 与交付状态

src/agent/retry-policy.ts
  - 把 failureClass、tool.isConcurrencySafe()、toolName、risk 合并为 retry 决策

src/agent/worker-evidence.ts
  - 对 WorkerResult 做独立核验
  - 去重 aggregation risks

src/mcp/policy.ts
  - MCP blocklist / allowlist / confirmation / mustlist enforcement

src/tui/cockpit/state.ts
  - 将 intent / blockingReason / nextAction 注入 CockpitSnapshot

src/prompt/volatile.ts
  - 渲染 repairHint 与 strategyShift
```

## P0 范围

### P0.1 Final delivery gate

最终回复前必须根据 `EvidenceTracker.getState().deliveryStatus` 生成交付判定：

- 修改文件但没有验证：必须警告 unverified。
- 验证失败：必须报告 failed。
- 验证 blocked：必须报告 blocked。
- 没有文件修改但有只读分析：可不强制验证。

### P0.2 Two-layer worker evidence gate

子代理结果不能只信 JSON 自报。主进程应核验：

- `changedFiles.length > 0` 且 `evidenceStatus !== 'verified'` → blocked。
- `evidenceStatus === 'verified'` 但缺少 `verification` → blocked。
- `verification.status !== 'passed'` → failed / blocked。
- 重复的 unverified risk 不重复追加。

### P0.3 Anchor-first strategy shift

doom-loop warn 阶段注入 soft guidance，blocked 阶段硬阻断并注入 hard guidance。

guidance 必须包含 target、operation、verificationSignal、boundaryCondition。

### P0.4 Retry safety policy

`TurnHarness` 重试前必须确认：

- failure class transient。
- tool concurrency-safe。
- tool 不属于写文件、编辑文件、undo、rollback、未知 MCP write 等非幂等操作。

## P1 范围

### P1.1 Repair pipeline integration

将 `RepairPipeline` 接到 tool_use 参数执行前路径，并记录 telemetry。

### P1.2 MCP enforcement policy

新增 MCP policy，以 server/tool/capability 为粒度输出 allow / confirm / block / require。

### P1.3 Cockpit guidance fields

`CockpitSnapshot` 增加 `intent`、`blockingReason`、`nextAction`，并让 Summary / Safety / Verify panel 可消费。

## P2 范围

### P2.1 Stuck pattern 扩展

在 hash fingerprint 之外增加 OpenHands 风格 stuck patterns：

- action-error loop
- action-observation loop
- monologue
- alternating pattern
- context-window failure

### P2.2 Scenario golden tests

增加端到端业务场景测试，覆盖：

- repeated edit failure → warn hint → blocked → anchor-first strategy shift
- file changed without verification → final delivery unverified
- worker self-reports verified without verification metadata → blocked
- MCP write tool from unknown server → confirmation / block
- repaired malformed tool args → telemetry recorded

## 非目标

- 不引入新的 agent runtime。
- 不重写 cockpit UI。
- 不把所有验证升级成全量测试。
- 不用 LLM 判断 safety 的最终结论；LLM 可以辅助说明，enforcement 必须由确定性 policy 决定。

## 验收标准

- 修改文件后，未验证状态不能被最终回复包装成已完成。
- 子代理 changedFiles 与 evidenceStatus 不一致时聚合结果 blocked。
- warn 级 doom-loop 已能给出可执行 strategy shift；blocked 级会阻止重复工具调用。
- 非 concurrency-safe tool 不会被 TurnHarness 自动 retry。
- repair pipeline 的每次修复都有 telemetry。
- cockpit 能显示当前最重要的 blocking reason 和 next action。

## 风险与应对

### 风险：delivery gate 过严导致只读任务也被误判 unverified

应对：只在 `filesModified.size > 0` 或 worker changedFiles 非空时强制验证；只读研究和代码审查仍可正常交付 evidence-backed summary。

### 风险：strategy hint 过长破坏 prefix cache 或干扰模型

应对：只在 latest-turn volatile block 渲染，且 bounded guidance 限制为 3-5 行。

### 风险：MCP policy 过早复杂化

应对：第一阶段只实现静态 policy object 和 deterministic evaluator，不做配置 UI。

### 风险：independent verification 难以完全证明测试相关性

应对：先做保守核验：存在 passed verification metadata 才允许 verified；相关性 heuristic 放入后续任务。
