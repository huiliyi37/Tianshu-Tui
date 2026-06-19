# TUI 终端端议事会 · /council slash 命令 — 交付记录

> **执行星域：瑶光域。** 本文是 `tui-council-slash` 计划落地后的交付复盘，按瑶光「绿非证明、复现即证、反身之道」记录——重点不在「做了什么」，而在「怎么确认它真的成立」，以及一次对**复现工具自身**的存疑自纠。

## 背景与边界

后端 `council_convene` 工具此前（W-C4/W-C5）已注册进 TUI 工具集，model 能调用并返回结构化议事记录 markdown（席位贡献 + 裁决记录接受/拒绝/暂缓 + 冲突表 + 最终任务表）。但终端用户**没有发起入口**——缺一个 `/council` 命令。

本轮只补这条入口，复用 `/team` 已验证的 **ecosystem-workflow 注入范式**。边界：不碰桌面端；不新建 council panel 组件（议事记录已是结构化 markdown，TUI 工具卡渲染开箱即用）。

## 范式：/council 照抄 /team

`/council x` 不是本地直调工具，而是经 `slash-router.ts` `route()` → `resolveAppPromptInput` → `resolveEcosystemWorkflowInput` 把 `/council x` 映射成一段**指示 model 调 `council_convene` 的 prompt** → `app.submitText(prompt)` → model 调工具 → 议事记录回到终端。`/council` 完全同链路，只是注入指向 `council_convene`，且 prompt 显式约束「绝不触发 team_orchestrate」以守住议事会↔执行的解耦。

## 改动清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/workflows/ecosystem-workflows.ts` | 改 | `COUNCIL_COMMANDS` + `parseCouncilWorkflowArgs` + `buildCouncilWorkflowPrompt` + `COUNCIL_USAGE` + `resolveEcosystemWorkflowInput` 分支 |
| `src/workflows/__tests__/ecosystem-workflows.test.ts` | 改 | `/council` 命中 / 空参回 USAGE / prompt 含 objective+council_convene / 不诱导 team_orchestrate |
| `src/tui/slash-commands.ts` | 改 | `HELP_TEXT` 加 `/council` 行；`handleSlashCommand` 加 `/council` case（空参显示 usage，有参透传） |
| `src/tui/command-palette.tsx` | 改 | 命令列表加 `/council` 补全条目（fuzzy 补全自动覆盖） |
| `src/tui/__tests__/slash-commands.test.ts` | 改 | `resolveAppPromptInput('/council x')` 命中 / 空参回 usage |
| `src/agent/council/council-render.ts` | 改 | 新增纯函数 `summarizeCouncilPlan(plan)` — 工具卡紧凑摘要 |
| `src/agent/council/__tests__/council-render.test.ts` | 改 | 摘要 ≤4 行（工具卡阈值）/ 含席位数/裁决计数/任务数 / 确定性 |
| `src/tools/council-convene.ts` | 改 | 返回补 `uiContent`（紧凑摘要），`content` 仍是全文 markdown |
| `src/tools/__tests__/council-convene.test.ts` | 改 | 断言 `uiContent` 存在、≤4 行、≠content |

## W-T3 的关键设计判断：为什么补 uiContent

核查渲染路径发现 `formatToolCard` 的 `DEFAULT_MAX_LINES = 4`——任何非特例工具的结果在工具卡里只展示前 4 行，余下留 `ctrl+o` 展开。议事记录是多行 markdown，裸渲染会被截成无意义片段。

设计取舍：**全文议事记录由 model 原样 echo 成正文**（prompt 已要求）渲染给用户，工具卡只是旁路。因此给 `council_convene` 补一个紧凑 `uiContent`（席位数·裁决计数·任务数 三行摘要），让工具卡预览有意义；`content` 仍保留全文 markdown 进 model 上下文供其 echo。这是**确证截断后**才做的兜底，非臆测——符合计划「仅在验证确证截断时才做，避免过度设计」。

## 复现即证（瑶光主场）

单测全绿不算交付。本轮跑了一段确定性全链路复现脚本（验证后删除），串起 `/council X` → `resolveAppPromptInput` 产出指向 `council_convene` 的 prompt → 工具实跑产出议事记录 + uiContent。

### 反身之道：复现脚本第一版自己写错了

第一次跑，STEP 2 输出里席位贡献全是「_（无摘要）_」、裁决计数全 0——看起来像生产 bug（席位结果没绑回）。

**没有立刻下「生产有 bug」的结论**，而是追绑定逻辑：编排器 `council-orchestrator.ts:116` 按 `run.results.find(r => r.workOrderId === \`council:seat-${seat.authority}\`)` 绑回结果。真实链路里 coordinator 经 `deriveStableWorkOrderId(parentTurnId)` 把 `council:seat-tianquan` 原样产出（`split(':').slice(-2).join(':')` 对该形状是恒等）。而我的 fake `delegateBatch` 图省事写了 `workOrderId: r.workOrderId ?? 'wo_'+authority`——`CouncilFanoutRequest` 根本没有 `workOrderId` 字段，于是退化成 `wo_tianquan`，与 `council:seat-tianquan` 对不上 → 贡献空。

**是复现工具错了，不是生产错了。** 把 fake 改成 `workOrderId: r.parentTurnId.split(':').slice(-2).join(':')`（精确模拟真实 coordinator 行为）后，全链路正确：席位贡献齐全、裁决「接受 3」、最终任务表 2 项、uiContent 摘要与全文一致。

教训：**复现脚本里的 fixture/fake 也是会骗人的一环。** 上一轮（W-C1~C3）的「虚假绿灯」是测试 fixture 伪造了真实系统从不产出的形状；这一轮是复现 fake 伪造了 coordinator 从不产出的 workOrderId。同一族缺陷换了个马甲。验证工具与被验证对象之间，必须让 fake 严格复刻真实契约——否则「复现失败」可能只是工具假阳性，「复现成功」也可能只是工具假阴性。

## 验证结果

- `npm run typecheck` 零错误。
- ecosystem-workflows / slash-commands / council 全套 / council-convene 共 **112/112** 绿。
- `/team` 既有断言全绿，无回归（ecosystem-workflows 测试同文件覆盖）。
- 改动文件 lint 干净。
- 确定性全链路复现：`/council <objective>` → council_convene → 完整议事记录 + uiContent 摘要，跑通。

## 遗留与边界

- 真正的**交互式 TUI + 活模型端到端**（人在终端敲 `/council`，model 真实调工具并 echo）需人工验证；本环境无法启交互 TUI + 真实模型，已用确定性全链路脚本复现到「工具产出正确议事记录」这一步。
- 席位固定走 `council_convene` 默认席（天权/天府/天璇），`/council` 不解析 seats 参数（YAGNI）；需自定义席位时 model 可在对话内直接调工具传 seats。
- 桌面端议事会 UI（CouncilSurface、`/stars` API）见 i1 设计文档 Phase 1/3，本轮不做。
