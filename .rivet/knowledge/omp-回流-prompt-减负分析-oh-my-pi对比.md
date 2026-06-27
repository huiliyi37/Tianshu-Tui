# 天枢 × oh-my-pi — 提示词 & 工作流对比分析

> 分析时间: 2026-07-01
> 目标: 识别 oh-my-pi 提示词/工作流中可引入天枢的设计，重点评估减负空间

## 架构对比

| 维度 | 天枢 (opencode-tui) | oh-my-pi |
|------|---------------------|----------|
| 语言 | 中文为主 | 英文 |
| 运行时 | Node.js 22 + Ink 6 TUI | Bun + 自研 TUI |
| 提示词引擎 | `static.ts` (monolithic) + `volatile.ts` (动态) + `engine.ts` (组装) | Handlebars 模板 `{{#if}}` 驱动的 `.md` 文件 |
| 提示词大小 | ~10K chars static, 总 ~25K+ | 按 feature flag 动态组装，基础 ~8K |
| 结构风格 | XML 标签 + 叙事散文 | XML 标签 + Handlebars 条件 + 简洁英文 |
| 身份定义 | `<identity>` 段，天枢星域叙事 | 单行 `ROLE`："helpful assistant the team trusts" |
| 规则系统 | 8+ 命名规则嵌入 `<rules>` | 规则外置为 skills/rules，prompt 中只列索引 |
| 工作流 | 叙事式 `<workflow>` + `<diagnostic-loop>` | 6 阶段命名流程 (Scope→Research→Decompose→Implement→Verify→Cleanup) |
| 交付契约 | 分散在多个规则中 (self-verification, test-harness, output-style) | 单一 `<contract>` 块，强约束 |
| 子代理 | 提示词继承主 prompt + 委派规则 | 独立 `subagent-system-prompt.md`，极简（无 TODO、无进度报告） |
| 项目注入 | `<project-instructions>` 全量注入（AGENTS.md 风格） | `project-prompt.md` 模板驱动，按条件注入 |

## 天枢可减负的具体方向

### 1. 合并规则为 DELIVERY CONTRACT（预计减 ~40% 的 rules 行数）

oh-my-pi 把交付纪律集中在一个 `<contract>` 块中：

```
<contract>
- NEVER yield unless the deliverable is complete
- NEVER suppress tests to make code pass
- NEVER fabricate outputs
- NEVER substitute an easier problem
- NEVER ship stubs, placeholders, mocks
- "Done" means end-to-end, not scaffold compiles
</contract>
```

天枢当前有 `self-verification`、`no-fabricated-tests`、`cross-layer-claim-discipline`、`output-style`（交付报告三项）四条规则共同承担同一职责。可以合并为一个 `<delivery-contract>` 块，保留关键约束，删除冗余展开。

**具体操作:**
- 新建 `<delivery-contract>` 段（中文，~25 行）
- 删除 `self-verification`、`cross-layer-claim-discipline`、`output-style` 中与交付相关的部分
- 保留 `evidence-scope`（诊断策略切换有价值）、`lossy-observation-discipline`（工具截断特有）、`test-harness`（TDD 纪律具体化）

### 2. 工作流改为命名阶段（预计减 ~30% 的 workflow 行数）

oh-my-pi 的 6 阶段流程直观且可操作：

```
1. SCOPE — 读 skills/rules，计划多文件工作
2. RESEARCH — 读 section 不读 snippet，用 references 前先查
3. DECOMPOSE — 更新 todo，并行委派
4. IMPLEMENT — 治根不改标，搜而不猜
5. VERIFY — 不运行测试不交付，测行为非 plumbing
6. CLEANUP — 最后阶段，代码可运行后才做
```

天枢当前的 `<workflow>` 是叙事式的，开发循环和诊断循环的差异有价值但可以折叠到 IMPLEMENT 阶段的子点中。Cleanup 作为独立阶段的思路特别好——当前天枢没有对应的纪律。

### 3. 引入 "NEVER" 简洁启发式（预计减 ~20%）

oh-my-pi 的精华：

| NEVER 启发式 | 天枢当前等价物 |
|-------------|---------------|
| "NEVER open a file hoping. Hope is not a strategy." | `evidence-scope` 规则 + "不猜，先读" |
| "NEVER re-audit an applied edit; tool results are THE verification." | 无直接等价（天枢倾向于再验证） |
| "NEVER narrate session limits, token budgets, or effort estimates." | **缺失** — 这是高价值新增 |
| "NEVER stop at the first plausible answer." | 隐含在探索纪律中 |
| "NEVER abandon phases under scope pressure—delegate, don't shrink." | `<delegation>` 段部分覆盖 |

其中 "NEVER narrate session limits" 是最值得加的——它能防止模型因为"上下文快满了"而自我设限。

### 4. 工具策略简化

oh-my-pi 的工具策略是"优先用专用工具，bash 是例外"。天枢的 `<tool-usage>` 段非常详细（文件操作选择指南、并行纪律、工作区外路径），这些细节有价值但可以：
- 保留文件编辑工具的选择指南（edit_file vs write_file vs hash_edit）
- 将并行纪律合并到工具策略中而非独立段
- 工作区外路径规则移到 security 段

### 5. 模板化条件注入

oh-my-pi 的 `{{#if}}` 模式是天枢可以学习的——不是所有规则都需要每轮出现：
- 多会话共享工作区规则只在 B1 门禁会话中需要
- delegation 规则只在支持委派的会话中需要
- model calibration 已经做得不错，可扩展到其他条件段

## 不建议减负的部分

以下天枢特性保留是有价值的，不需要向 oh-my-pi 靠拢：

- **中文定位**：天枢的中文提示词是差异化优势，不需要翻译
- **诊断循环 vs 开发循环**：这个二分法很有价值，可以保留但作为 IMPLEMENT 阶段的子规则
- **`lossy-observation-discipline`**：工具输出截断检测是天枢特有的（因为工具实现不同），不能删
- **`test-harness` 的探针纪律**：`probe-discipline`（临时探针清理）是具体有效的，保留
- **`git-context-first`**：天枢的 git context 注入机制是特有架构，绑定规则保留

## 建议实施顺序

| 优先级 | 改动 | 预估减负 | 风险 |
|--------|------|----------|------|
| P0 | 新增 `<delivery-contract>` + 删除重复规则 | -40% rules | 中 — 需要确保每个被删规则的约束在新 contract 中有对应 |
| P0 | 新增 "NEVER narrate session limits" | +1 行 | 低 |
| P1 | 工作流改为 6 阶段 | -30% workflow | 中 — 需保留诊断循环差异化 |
| P1 | 工具策略简化 | -20% tool-usage | 低 |
| P2 | 模板化条件注入 | 动态减负 | 高 — 需要引擎改动 |

**总计预估减负:** 当前 static.ts ~10K chars，实施 P0+P1 后预计 ~7K chars（-30%），同时改善清晰度和可操作性。
