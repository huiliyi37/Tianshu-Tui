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

oh-my-pi 的 `{{#if}}` 模式可供参考——特定领域的详细指令可以在特定上下文中展开，但核心规则不能条件化：

- **model calibration** 已经做得不错，可扩展到其他非核心条件段
- ⚠ **不能条件化的规则**：多会话共享工作区（所有会话都可能并发改文件，不在提示词里提醒会导致状态混乱）、delegation 规则（子代理委派必须所有会话都支持，与竞品对齐）、交付门禁

## 不建议减负的部分

以下天枢特性保留是有价值的，不需要向 oh-my-pi 靠拢：

- **中文定位**：天枢的中文提示词是差异化优势，不需要翻译
- **诊断循环 vs 开发循环**：这个二分法很有价值，可以保留但作为 IMPLEMENT 阶段的子规则
- **`lossy-observation-discipline`**：工具输出截断检测是天枢特有的（因为工具实现不同），不能删
- **`test-harness` 的探针纪律**：`probe-discipline`（临时探针清理）是具体有效的，保留
- **`git-context-first`**：天枢的 git context 注入机制是特有架构，绑定规则保留

## 实施状态（2026-07-01 收束）

| 优先级 | 改动 | 状态 | 提交 |
|--------|------|:----:|------|
| P0 | 合并规则→`<delivery-contract>` + 删除重复规则 | ✅ | `7106ff7a` |
| P0 | "不自我设限"（NEVER narrate session limits） | ✅ | 同上，在 contract 内 |
| P1 | 工作流改为 6 命名阶段 + Cleanup | ✅ | `ff4296e8` |
| P1 | volatile.ts 英→中本地化 | ✅ | `70b26112` |
| P1 | 工具策略简化 | ❌ **不做** — 当前详细的文件编辑选择指南（edit_file/write_file/hash_edit/apply_patch 的精确使用场景）无法由外部模型校准，简化会丢失工具特有的操作知识。保留。 |
| P2 | 模板化条件注入 | ❌ **不做** — 多会话共享工作区和 delegation 规则必须全量常驻（用户明确），剩余可条件化的空间极小，不划算。 |

**收束结论：** 4/6 项已落地，2 项决策不做。当前 `static.ts` 已达到合理的减负—精度平衡点。后续 prompt 工程的主方向从"减负"转为"稳定性维护"——不新增规则、不破坏现有 6 阶段结构、不做外部模型难以校准的简化。
