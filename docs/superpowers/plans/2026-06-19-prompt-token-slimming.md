# 项目提示词精简方案

> 基于 `docs/superpowers/specs/2026-06-19-prompt-token-anatomy.md` 的 token 构成分析。
> 本方案只记录可执行的精简项及改动点，不展开分析过程。
>
> **审查修订**: 2026-06-19 — 代码验证后修正文件位置、数值、风险评估。

## 背景

天枢首调 ~17-26K tokens，其中工具 schema 占 ~55%（11-15K），系统提示（static）占 ~8%（2-2.5K），项目上下文（volatile frozen）占 ~15-25%（3-6K）。按投入产出比排序。

---

## P0: 工具 schema 精简（潜在节省 3-5K tokens）

### P0-1: `read_file` description 压缩

- **文件**: `src/tools/read-file.ts` L375-398（definition 对象的 `description` 字段）
- **现状**: description 纯文本 ~1,600 chars，含 `### Usage`（行为规则）+ `### Large file strategy`（策略说明）+ `### Examples`（示例）三段；加上 `input_schema` JSON 序列化后整个 schema 约 ~2,500 chars
- **改法**: 砍掉 `### Examples` 段（L392-397，6 行纯示例）。`### Large file strategy` 压缩为 1 行（模型已通过 partial view 行为学到了策略）。保留 `### Usage` 核心规则
- **估计节省**: ~800-1,000 chars / ~200-400 tokens

### P0-2: `delegate_task` / `delegate_batch` authority enum 删减

- **文件**: `src/tools/delegate-task.ts` L63、`src/tools/delegate-batch.ts`
- **现状**: `authority: { type: 'string', enum: starDomainRegistry.getDomainIds(), ... }` — 动态获取星域 ID 列表（当前 ~10 个）
- **改法**: 删除 `enum: starDomainRegistry.getDomainIds()`，只保留 `type: 'string'`。星域 ID 已通过 `<star-domain>` volatile 块和 system prompt `<delegation>` 段告知模型，enum 是冗余重复
- **估计节省**: ~800 chars / ~200-300 tokens

### P0-3: `deliver_task` description 中的 checklist 条目压缩

- **文件**: `src/tools/deliver-task.ts`
- **现状**: description ~1,500 字符，`checklist` 参数的 `fact-flow graph verified` / `condition matrix verified` / `counterexample tests verified` 三项各有 1-2 行说明
- **改法**: 压缩为 `complex spec delivery checklist items: fact-flow, condition-matrix, counterexample`
- **估计节省**: ~400 chars / ~100-150 tokens

### P0-4: 低频工具延迟注入（仿 Claude ToolSearch 模式）

- **范围**: `leave_mark`、`import_resource`、`undo`、`recall_capsule`、`plan_close`、`read_section`、`file_info` — 共 **7 个**
- **改法**: 这些工具从首调 prompt 移除，改为通过 `skill` 工具或工具发现机制按需加载。核心工具（read/write/edit/bash/grep/glob/git/run_tests/todo 等）常驻
- **估计节省**: 7 × ~300 tok = **~2,100 tokens**
- **必须保留**:
  - `ask_user_question` — 首调澄清阶段必须可用，延迟注入会导致模型在需要澄清时无法调用
  - `request_path_access` — `<tool-usage>` 段 L62 直接引用该工具名称，schema 缺失会造成认知矛盾

---

## P1: `<project-instructions>` 加字符上限（潜在节省 1-2K tokens）

- **文件**: `src/prompt/volatile.ts` — `buildStableVolatileBlock` 内部
- **现状**: L640-642 直接 `escapeXml(md)` 后 push 进 `<project-instructions>` 块，无上限。`truncateBlock` 函数（L748）已存在且被 `project-memory`（3K）/ `seed-capsule`（3K）/ `codebase-index`（4K）使用，唯独 project-instructions 未应用
- **改法**:

```typescript
// L641-642 改为:
if (md) {
  parts.push(truncateBlock(`<project-instructions>\n${escapeXml(md)}\n</project-instructions>`, 8_000, 'project-instructions'))
}
```

- **注意**: `truncateBlock` 接收已含 XML 标签的完整块，内部会保证标签闭合。需确认 `escapeXml` 在截断前调用（当前逻辑正确——先 escape 再交给 truncateBlock 裁剪）
- **估计节省**: 1-2K tokens（取决于项目 AGENTS.md 长度；本项目 AGENTS.md 76 行 + .rivet.md 74 行 ≈ 5K chars，不会触发 8K cap；但外部项目可能有长 AGENTS.md）

---

## P2: `<tool-usage>` 段压缩（潜在节省 ~150 tokens）

- **文件**: `src/prompt/static.ts` — `BASE_PROMPT` 字符串中 `<tool-usage>` 段，L56-64（8 行中文）
- **现状**: ~350 tokens（CJK tokenize 约 1.5 chars/token），7 段各含示例/解释
- **具体改动**: 将 L57-63 的 7 段压缩为 4 段：

```
改前 L58: "导航：探索靠 inspect_project / repo_map / glob / grep / read_file / semantic_search。这些是只读工具，互相独立——别一个一个串行发。路径含空格加引号。"
改后: "探索靠 inspect_project / repo_map / glob / grep / read_file / semantic_search，可并行发。路径含空格加引号。"

改前 L59: "并行：把同一阶段、互不依赖的只读探索调用放进同一条消息一次发出，引擎会并行执行。例：要读 3 个文件 + grep 2 个符号，就在一条消息里发 5 个工具调用，而不是分 5 轮。只有结果会喂给下一步时才串行。"
改后: "同阶段只读调用一条消息一起发，别串行。结果喂下一步时再串行。"

改前 L60: "扇出范围：一次发多个只限只读探索工具（read_file/grep/glob/semantic_search/repo_map/inspect_project/file_info/related_tests 等）。bash/git/edit_file/write_file/hash_edit/run_tests 是串行工具，批起来引擎也只能逐个跑，没有并行收益——这些一律单个发、逐个看结果再走下一步，别凑成一批。"
改后: "只读工具可一批发；bash/git/edit_file/write_file/hash_edit/run_tests 需逐个串行。"

改前 L61: "连续约束：并行只对"连续"的只读调用生效。别在一批读/搜中间插 bash/git/edit_file/write_file——它们会切断并行批，把两侧的读退化成串行。先把所有要读的一次读完，再动写、跑命令、测试。"
改后: 合并到上段末尾："先读完再动写/跑命令——中间插写操作会切断并行。"
```

- L57（文件操作）和 L62（工作区外路径）保留不动——前者是核心编辑纪律，后者绑定 `request_path_access` 工具
- L63（防循环）保留不动——行为约束不可压
- **估计节省**: ~150 tokens

---

## P3: `<calibration>` 段压缩（节省 ~30 tokens）

- **文件**: `src/prompt/static.ts` L127 — `MODEL_CALIBRATIONS.deepseek` 的值
- **现状**: "你已具备精确执行能力。特别关注跨模块边界影响——修改前用 grep 验证调用方不被破坏。完成后主动报告遗留项和设计偏离。"
- **分析**: "遗留项/设计偏离"已被 `<output-style>` 覆盖。但 **"修改前用 grep 验证调用方不被破坏"是唯一的行为锚**——`<rules>` 中的 `evidence-scope` 规则说的是"证据先行"，没有具体到 grep 消费方检查。直接删空会丢失这个锚
- **改法**: 压缩为一句，保留核心行为锚：

```typescript
deepseek: '<calibration>改代码前 grep 验证消费方不被破坏。</calibration>',
```

- **估计节省**: ~30 tokens（原文 ~50 tok → 压缩后 ~20 tok）

---

## 执行次序建议

| 次序 | 项目 | 改动量 | 节省 | 风险 |
|------|------|--------|------|------|
| 1 | P1: project-instructions cap | 2 行 | 1-2K | 零（截断尾部冗余，本项目不触发） |
| 2 | P2: tool-usage 压缩 | ~8 行 | ~150 | 零（语义保留，行为约束不动） |
| 3 | P3: calibration 压缩 | 1 行 | ~30 | 零（保留核心锚，只砍冗余） |
| 4 | P0-1~3: 工具 description 压缩 | ~5 文件 | ~500-850 | 低（砍示例/枚举） |
| 5 | P0-4: 低频工具延迟加载 | 架构改动 | ~2.1K | 中（需验证首调不依赖这 7 个工具） |

前三项合计改动 ~11 行，节省 ~1.2-2.2K tokens，可以一轮完成。
P0-1~3 需要逐个文件读改 + 跑 tool schema 快照测试。
P0-4 是架构改动，需设计延迟加载机制 + 回归测试。

---

## 审查备注（代码验证差异）

| 原始文档描述 | 实际代码 | 修正 |
|-------------|---------|------|
| read_file desc ~2,500 chars | description 纯文本 ~1,600 chars；含 schema 序列化约 2,500 | 标注"含 schema" |
| `volatile.ts` 约 L175-178 | 实际位置 L640-642 | 已修正 |
| P0-4 候选 9 个工具 | `ask_user_question` 首调必须、`request_path_access` 被 tool-usage 引用 | 缩减为 7 个 |
| P3 "删空" | grep 消费方检查是唯一行为锚，未被其他段覆盖 | 改为"压缩"而非"删除" |
| token 估算用 chars/4 + chars/1.5(CJK) | 代码统一用 `CHARS_PER_TOKEN = 4`（未区分 CJK） | anatomy 文档需勘误 |
