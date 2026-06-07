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

## Spec→code cross-check（交付前 30 秒核对）

Observed failure: 4 个偏差在 code review 阶段才被发现（缺失路由、参数未传递、死代码、未使用 import），根因不是"没读文档"而是"读完文档后实现时缺了一轮交叉核对"。

Rule — 每个逻辑单元提交前，做一轮结构化核对（30 秒）：
1. **架构表/清单逐条打勾**：spec 有路由表 → 实现完逐条检查路由是否存在
2. **接口签名对齐**：接线函数时读被接函数的完整类型签名，确认每个参数都传了
3. **死代码扫描**：新增的分支/guard 是否会被前面的 early return 吞掉
4. **import 审计**：新增的动态 import 是否可以用静态 import 替代

这不是重读文档，是结构化验证。偏差 1 可被 checklist 捕获，偏差 3 只需读一行类型签名。

### 强制机制（不靠自觉）

**提交前必须 spawn 一个 adversarial_verifier 做 spec→code 交叉核对。** 这不是可选的"建议"，是交付流程的固定步骤：

1. 实现完一个逻辑单元后，先 typecheck + 跑相关测试
2. **然后 delegate 一个 `adversarial_verifier` worker**，objective 为：
   > "对照 spec（路径: docs/superpowers/specs/<spec>.md）逐条核实本次实现：
   > 1. 所有路由/端点是否存在（spec 架构表逐条打勾）
   > 2. 所有接口签名是否对齐（接线函数参数是否完整传递）
   > 3. 新增 guard/分支是否有不可达死代码
   > 4. import 是否有可消除的动态导入
   > 报告偏差为 failed，全部通过为 verified"
3. **verifier 返回 verified 后才能 deliver_task**。若返回 failed/blocked，先修偏差再重审。

这样偏差不是在 code review 时才发现——是在提交前就被对抗 verifier 拦截。靠的是子代理独立核对，不是主模型自觉读检查清单。
