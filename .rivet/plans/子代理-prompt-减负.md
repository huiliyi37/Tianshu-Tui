# 子代理 prompt 减负 — 对标 pi 的简洁度

> 现状：天枢子代理继承完整主 prompt（~200 行 static + 规则 + 工具策略 + delivery-contract + security + 工作区 + delegation），再叠加 `buildWorkerPrompt` 的 profile 方法论和任务描述。pi 的子代理 prompt 不到 40 行。

## 当前架构

```
主 agent prompt:
  <identity> <beliefs> <stance>           ← 人格层 (~20 行)
  <rules> ×6 + <hard-gates>              ← 规则层 (~70 行)
  <delivery-contract>                     ← 交付纪律 (~20 行)
  <tool-usage>                            ← 工具策略 (~25 行)
  <workflow> 6 阶段                      ← 工作流 (~20 行)
  <security> <shared-worktree> <git>     ← 基础设施 (~30 行)
  <delegation> <output-style>            ← 协作层 (~20 行)
  ───────────────────────────────
  buildWorkerPrompt():                   ← worker 特有
    你是 headless worker
    Profile 方法论 (code_scout/reviewer/...)
    项目发现引导 (只读 worker)
    Task: objective + scope + constraints
    结果 shape (JSON schema)
```

**子代理拿到 ~250 行。** pi 的子代理拿到 ~38 行。

## 哪些该删、哪些该留

### 从子代理 prompt 删除（主 agent 人格/纪律/基础设施）

| 段 | 理由 |
|----|------|
| `<identity>` / `<beliefs>` / `<stance>` | 子代理不需要知道"你是天枢星域的"——它是 headless worker |
| `<rules>` 全部 6 条 | evidence-scope、self-verification、lossy-observation 等是给主 agent 的行为纪律。子代理的关键约束已经在 `buildWorkerPrompt` 结果 shape 里：必须返回 JSON、不能捏造 changedFiles、不运行验证则 evidenceStatus=unverified |
| `<delivery-contract>` | 主 agent 的"不自我设限""收束报告三项"对子代理无意义——子代理交付的是 JSON payload，不是对话 |
| `<workflow>` 6 阶段 | 子代理不需要"①理解②调研③拆解④实施⑤验证⑥收尾"——它收到一个明确 objective，执行、返回 JSON 即结束 |
| `<security>` / `<shared-worktree>` / `<git>` | security 的"破坏性命令闸门"是主 agent 的职责。子代理的工具白名单已由 `order.allowedTools` 控制 |
| `<output-style>` | 子代理输出 JSON，不需要"直线到达""不推卸决策""不用列表能说的用散文" |
| `<delegation>` | 子代理不能发 delegate_task（delegate_task 不在 allowedTools 里），委派规则对它无效 |

### 保留（子代理真正需要的）

| 段 | 理由 |
|----|------|
| `<tool-usage>` | 子代理仍需知道 edit_file vs write_file vs hash_edit 的选用原则，以及并行纪律 |
| `<calibration>`（模型特有） | DeepSeek 的"改代码前 grep 验证消费方"对 patcher 子代理同样有效 |

### 新增（对标 pi）

| 段 | 来源 |
|----|------|
| **COOP**: "你是一个子代理。执行分配的任务，不要做 TODO 追踪、不要进度报告。调用 yield 返回结果。" | pi 的 COOP 段，极简 |
| **COMPLETION**: "只要工作未完成，继续调用工具。完成后调用 yield 返回 JSON。不要放弃——除非真正的阻塞。" | pi 的 COMPLETION 段 |

## 方案：worker session 用精简 prompt

改动点仅在 `src/agent/worker-session.ts` 的 prompt 组装路径。不是改 `static.ts`（那影响主 agent），而是在构建 worker config 时，用精简版 system prompt 替代完整版。

具体：在 `runWorkerSession` 或 coordinator 创建 worker config 处，调用一个新的 `buildWorkerSystemPrompt()` 替代 `promptEngine` 的完整 prompt。精简版只包含：

```
精简 worker system prompt:
  你是一个 headless 子代理，在当前项目中执行任务。
  <tool-usage>（保留工具策略）
  <calibration>（保留模型校准）
  ─── buildWorkerPrompt() 输出 ───
  你是谁 (headless worker)
  Profile 方法论
  Task: objective + scope + constraints
  COOP: 执行任务，不跟踪 TODO，不报告进度
  COMPLETION: 完成后 yield，放弃前穷尽工具
  结果 shape (JSON schema)
```

预估从 ~250 行减到 ~90 行（含 profile 方法论和 task），节省 ~160 行 ≈ ~3K tokens 每轮子代理调用。

## 风险

- **去掉 `<rules>` 可能让 patcher 子代理写代码时不 grep 调用方**。缓解：patcher profile 方法论已经写了"ALWAYS read the file first"和"run tests"；模型校准 `<calibration>` 保留了"改代码前 grep 验证消费方"
- **去掉 `<delivery-contract>` 可能降低子代理输出质量**。缓解：结果 shape 的 JSON schema 约束（`changedFiles` 必须真实、`evidenceStatus` 不验证则 unverified）已经在 `buildWorkerPrompt` 中表达
- **改动在 worker session 层，不影响主 agent**。回滚安全

---

## 补充：AB 实验约束下的平衡方案

> 来源：`/Users/banxia/天枢-Harness工程技术报告.docx` §3.1 A/B 对照实验
> 结论：有星域人格（identity/beliefs/stance）的 Flash 完成率 100%，无的 80%。
> T4：无 CVM 组面对矛盾指令拒绝执行，有 CVM 组判断真实意图、替换存根实现交付。

### 修正后的策略：分 profile 差异化精简，不一刀切

| Worker profile | 需要保留的 prompt | 可删除的 |
|----------------|-------------------|---------|
| **reviewer / verifier / adversarial_verifier** | FULL 星域人格 (identity/beliefs/stance) — AB 验证对审查质量有实质提升 | rules/delivery-contract/workflow/security/shared-worktree/git/output-style/delegation |
| **planner** | identity + beliefs + stance — 需要独立判断 | rules/workflow/security/shared-worktree/git/output-style/delegation |
| **patcher / code_scout / doc_scout** | 无星域人格 — 执行型 worker，task 本身已定义行为边界 | identity/beliefs/stance + rules/delivery-contract/workflow/security/shared-worktree/git/output-style/delegation |

**所有 profile 保留：** `<tool-usage>` + `<calibration>`（工具选用 + 模型特定行为对执行型 worker 是必需品，不删）。

### 实施路径

`buildWorkerPrompt` 当前已支持 `authority` 字段注入星域 persona。改动点：
1. `worker-prompts.ts` 新增 `buildWorkerSystemPrompt(profile, authority?)` 函数
2. 按 profile 返回精简版 prompt（仅含 tool-usage + calibration + buildWorkerPrompt 输出 + 条件化的星域人格块）
3. `worker-session.ts` 在构建 worker config 时，用 `buildWorkerSystemPrompt()` 替代 `promptEngine` 的完整 prompt

### 预估减负

- 审查类 worker：从 ~250 行减到 ~130 行（-48%），保留星域人格
- 执行类 worker：从 ~250 行减到 ~70 行（-72%），全量精简
