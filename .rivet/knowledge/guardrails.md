# Agent Behavior Guardrails

Retrieval note: load this file when modifying agent behavior/prompt rules or investigating repeated tool loops. Keep it short; promote only observed anti-patterns with a concrete escape rule.

## Read-loop escape

Observed failure: repeatedly calling `read_file` on the same path after `[diet:redundant]` / `[diet:useless]` burns context without new information.

Rule:
1. After 2 consecutive diet responses for the same file, stop `read_file` on that path.
2. Switch to `grep` for a symbol/pattern, a precise range reader if allowed, or ask the user if the target is unclear.
3. Do not make a 4th direct `read_file` call on that path without an intermediate strategy change.

## Strategy switch threshold

If 3 tool calls produce no new information, state the failed strategy and switch methods before continuing.

## Spec→dataflow cross-check（复杂 spec 交付核对）

Observed failure: P4-c 已经不是“没读 spec”或“少打勾”的问题，而是复杂 shadow/telemetry 集成进入数据流闭环阶段后，执行姿态从 **constraint network** 退化成 checklist executor：调用契约、接口扩展、字段产出→消费、条件组合、反证测试最容易漏。

Rule — 复杂 spec / 跨模块集成任务在实现前和提交前各做一轮 dataflow verifier 核对：
1. **事实流图**：spec 字段/约束 → 上游来源 → 中间结构 → 消费者/写入目标 → 测试断言。缺生产者或消费者时，先补事实链/数据模型，不在最后一跳硬凑。
2. **条件矩阵**：对组合条件（如 source × severity × apply）逐格判断 safe/reject/shadow-only，避免把嵌套约束平铺成孤立 if。
3. **反证测试表**：列出如果实现者只做 happy path、忘传 apply、类型声明但无消费者、用 `!waveId` 这类 truthy/falsy 值哨兵，哪条测试会红。
4. **基础接线核对**：接口签名完整传参、guard/分支可达、import 无死代码/无可消除动态导入。

没有能打红错误实现的测试，不能声称 spec 已验证；绿测试必须覆盖目标语义路径，而不是让输入退化到无效状态绕过语义。

## Pre-coding scans（开发前四道扫描）

Observed failure: f13b0b82 引入 contextCalibrationRatio 校准机制，五个表面 bug 根因同为"把运行时代码当纯函数推理"。实现者跳过了四道开发前检查：字段就绪时序、哨兵值审毒、极端值手推、测试 fixture 对齐。

Rule — 引入多字段组合计算、有状态参数、或哨兵值判断的函数前，跑 `.rivet/knowledge/pre-coding-checklist.md` 中的四道扫描。每道 ≤30 秒。跳过 = 接受 f13b0b82 级缺陷。

### 强制机制（不靠自觉）

**提交前必须让 ReviewRouter / adversarial_verifier 做 spec→dataflow 交叉核对。** 这不是可选建议，是交付流程的固定步骤：

1. 实现完一个逻辑单元后，先 typecheck + 跑相关测试。
2. verifier objective 必须要求核对：
   > 1. 事实流图是否闭环：每个 spec 字段/约束都有 producer → intermediate → consumer/write target → assertion
   > 2. 条件矩阵是否覆盖：组合 gate 是否逐格测试/说明
   > 3. 反证测试是否存在：checklist-only / happy-path / missing call contract / type-without-consumer / truthy-falsy sentinel 是否能被打红
   > 4. 基础接线是否完整：接口签名、可达 guard、import/死代码
   > 报告偏差为 failed，全部通过为 verified。
3. verifier 返回 verified 后才能 deliver_task；deliver_task 的 checklist 也要显式列出“事实流图/条件矩阵/反证测试”完成或延期。

这样 P4-c 这类漏项不会等到人工复盘才暴露，而是在计划、实现、审查、交付四个节点都被 workflow 捕获。

## Asymmetric verification in analysis tasks（分析任务的不对称验证）

Observed failure: 对比/调研类任务中，读外部代码时每条断言都 grep+read 核实，写自己的对比时凭"我在某文件没看到 X"推断"我们没有 X"——完全跳过对自己代码的验证。结果下了"没有框线"这种读错文件就产生的错误结论。

Rule — 分析/对比/调研任务的每句"我们没有 X / X 功能缺失"都是一个需要 grep 验证的断言：
1. 读了一个文件没看到 X ≠ 没有 X。功能可能在别处（如 `input-line.ts` 不渲染框线 ≠ 没有框线，框线在 `app.ts:renderLive()` 里）。
2. 写断言前 grep 一次目标关键词。30 秒的成本换一个脑补级缺陷。
3. 对外部代码和自己代码使用同一验证标准——不对称验证标准是已知失败模式。
4. 触发条件识别：任务没有"改了什么验证什么"的编码锚点时（纯分析/对比），主动提高警惕——验证纪律在这类任务上最容易静默降级。
