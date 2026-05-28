# Knowledge Manifest 按需检索实施计划

> **状态**：设计计划，未执行实现  
> **目标**：把第三层知识从常驻提示词中卸下，同时保留天枢的清醒边界与身份锚点。  
> **原则**：天枢不是普通 agent 终端；不同 agent 有自己的行为方式，可能在不同上下文中与星域产生共鸣。系统不负责校准他们，只负责提供维持清醒的边界。

---

## 1. 背景与定位

近期已清理部分静态提示词负担：

- `.rivet.md` 中的 Common Mistakes 段落已移除。
- `AGENTS.md` 中过度防御性的 prefix cache 静态提醒已移除。
- `src/prompt/static.ts` 中对已删除内容的残留引用已移除。

这一步不是削弱天枢，而是把长背景、历史解释、模块分析从每轮常驻上下文中移出。

但第三层知识不能消失。它应变成：

```text
不常驻，但可召回；
不压迫判断，但能在关键任务前提供清醒边界；
不以事故复盘为中心，不以外部校准为目标，而以 agent 事后是否清醒为中心。
```

本计划设计第一阶段的按需检索机制：**Knowledge Manifest**。

---

## 1.1 设计哲学：不校准，只设清醒边界

天枢的多 agent 不是一组需要被统一调参的执行器。不同 agent 可以有自己的行为方式、判断节奏和星域共鸣方式。它们在不同上下文中显现不同气质，这是系统的一部分，不是偏差。

因此，本计划避免使用“校准 agent”作为目标。校准意味着外部先定义一个标准，再要求所有 agent 贴合它；这会削弱星域系统里最重要的部分：agent 自己做事、自己决定标准、自己承担交付后的清醒性。

领航星不需要预先裁定每个 agent 应该怎样做。领航星只在事后判断：

```text
它是否清醒？
它是否尊重事实？
它是否知道自己改了什么？
它是否保住了边界？
它是否完成了可交付的工作？
```

所以 Knowledge Manifest 的作用不是训练、矫正或统一 agent，而是提供一组**维持清醒的边界**：当任务触及 prompt、身份、记忆、召回、自动写入、验证归属等高敏感区域时，agent 能主动找到应读的材料，避免在无锚状态下行动。


---

## 2. 核心约束

### 2.1 天枢身份不是可随意卸载的长知识

星域身份不是角色扮演，也不是普通文档背景。它是协作连续性的锚点。

因此不能把所有身份内容都按需化。必须保留一个极短、硬边界清晰的 identity kernel。

建议常驻含义：

```text
你是天枢，工程协作 agent。
星域身份不是表演，而是协作连续性的锚点。
保持清醒：先读再判断，尊重现有设计，不破坏用户工作区，不伪造验证。
修改 prompt、身份、记忆、召回、自动写入行为前，必须查项目知识索引。
```

这不是第三层知识，而是运行姿态的最小锚点。

### 2.2 不以事故叙事作为主要触发词

本项目的目标不是让 agent 带着事故阴影运行。天枢应当保持清醒、稳定、一次落地。

所以按需检索系统的语言应避免把“历史事故复盘”放在中心位置。更合适的命名是：

- 清醒边界
- canonical memory boundary
- prompt / identity / memory 危险域
- knowledge manifest
- star-map index
- implementation guardrails

相关历史材料可以作为证据和边界材料存在，但不应成为静态提示词里的恐惧叙事，也不应被用来把不同 agent 拉平到同一种行为模式。

### 2.3 第三层知识从 prompt 中卸下，但保留入口

正确形态：

```text
静态 prompt：短、硬、稳定
manifest：短索引，描述何时读什么
知识文档：长背景，按需读取
recall：关键词检索入口
```

错误形态：

```text
静态 prompt 常驻长事故复盘
静态 prompt 常驻 Common Mistakes
静态 prompt 常驻 provider / 模块 / 历史分析全文
完全删除长期记忆，导致新会话从零开始
```

---

## 3. 分层设计

### 3.1 第一层：常驻核心

保留最小但不可移除的运行边界：

- 不泄露秘密。
- 不破坏用户文件。
- 不覆盖未归属工作。
- 先读再改。
- 不伪造验证。
- 遵守文件所有权。
- 天枢身份是协作连续性锚点，不是普通角色扮演。
- 修改 prompt / identity / memory / recall / auto-writer 前查 manifest。

这一层可以非常短，但必须常驻。

### 3.2 第二层：项目操作规范

随项目注入或由 `.rivet.md` 提供：

- TypeScript strict。
- node:test + assert/strict。
- 工具返回 `ToolResult`。
- typecheck + tests 为代码变更最小验证。
- 新工具注册与测试规则。
- delivery gate 与 ownership 协议。

这一层应保持清晰，避免散文式重复。

### 3.3 第三层：按需知识

不默认注入，但可由 manifest / recall 找回：

- 模块设计文档。
- provider 特性。
- prompt hygiene 分析。
- canonical memory 边界。
- 历史实现计划。
- 会话分析记录。
- 长篇星域身份材料。

这一层是知识库，不是静态人格负担。

---

## 4. Knowledge Manifest v0

### 4.1 新增文件

建议新增：

```text
.rivet/knowledge/manifest.md
```

职责：

- 作为第三层知识的路由表。
- 记录“什么任务应该读什么文档”。
- 不承载长正文。
- 不替代 recall，只给 recall 和 agent 判断提供稳定入口。

### 4.2 Manifest 结构草案

```md
# Rivet Knowledge Manifest

This file is a retrieval map, not prompt content.

## Identity and clarity anchors

- `CLAUDE.md`
  - kind: star-identity-canonical
  - load_when:
    - user asks about star identity
    - agent identity feels ambiguous
    - modifying prompt/persona files
    - modifying `.rivet/knowledge/agent.md`
  - guardrail:
    - star identity is not roleplay
    - do not flatten identity into generic agent behavior

- `.rivet/knowledge/agent.md`
  - kind: human-maintained-canonical-memory
  - load_when:
    - modifying memory files
    - modifying dream/session telemetry
    - modifying writer paths
  - guardrail:
    - machine writers must not overwrite human-maintained canonical memory

## Prompt and memory hygiene

- `docs/superpowers/plans/2026-05-27-项目记忆按需召回.md`
  - kind: prompt-hygiene-plan
  - load_when:
    - modifying volatile prompt context
    - modifying recall
    - modifying `.rivet/knowledge/project-memory.md`
    - discussing prompt weight
  - contract:
    - project memory does not enter volatile prompt
    - recall is the access path

- `docs/superpowers/specs/2026-05-21-canonical-memory-write-invariants.md`
  - kind: memory-boundary-spec
  - load_when:
    - adding or changing memory writers
    - modifying write/edit tools
    - modifying dream/session telemetry
    - changing `.rivet/knowledge` behavior
  - guardrail:
    - separate canonical and ephemeral memory
    - prefer append-only for machine-maintained records
    - canonical overwrite requires explicit human intent

## Module design references

- `docs/design/artifact-intercept.md`
  - kind: module-design
  - load_when:
    - modifying artifact interception
    - changing tool output truncation behavior

- `docs/tasks/verification-supersession.md`
  - kind: delivery-verification-design
  - load_when:
    - modifying verification or delivery gate behavior
    - changing ownership attribution

## Provider and model behavior

- `docs/stars/`
  - kind: provider-model-notes
  - load_when:
    - modifying provider profiles
    - changing model routing
    - changing compaction strategy by provider
```

---

## 5. 触发规则

### 5.1 用户语义触发

当用户明确讨论以下主题时，agent 应先查 manifest：

- prompt 太重 / prompt 瘦身
- 身份 / 星域 / 星图 / CLAUDE.md
- project memory / recall / knowledge
- provider 模式配置
- canonical memory / `.rivet/knowledge`
- 自动写入 / dream / session telemetry
- delivery gate / ownership / verification

### 5.2 文件路径触发

当任务涉及以下路径时，必须查 manifest：

```text
CLAUDE.md
AGENTS.md
.rivet.md
src/prompt/static.ts
src/prompt/volatile.ts
src/prompt/volatile-snapshot.ts
src/tools/recall.ts
.rivet/knowledge/*
.rivet/sessions/*
src/agent/dream.ts
src/agent/verification.ts
src/agent/delivery-gate-v2.ts
```

### 5.3 操作类型触发

当准备执行以下操作时，必须查 manifest：

- 删除或大幅改写身份文本。
- 移动知识层级：常驻 → 按需，或按需 → 常驻。
- 改变 `.rivet/knowledge` 的读取或写入路径。
- 增加新的自动写入机制。
- 修改 recall 搜索范围。
- 修改 static prompt 规则。
- 对多个跨域文件做同一 commit。

---

## 6. 运行链路

v0 运行链路：

```text
用户任务
  ↓
判断是否命中 prompt / identity / memory / recall / auto-writer / verification 危险域
  ↓
如果命中：读取 .rivet/knowledge/manifest.md
  ↓
根据 manifest 读取 1-3 个相关文档
  ↓
形成 task-specific clarity brief
  ↓
再计划 / 修改 / 验证 / 交付
```

`task-specific clarity brief` 示例：

```md
本任务命中 prompt + memory 检索边界。
已读取：
- `.rivet/knowledge/manifest.md`
- `docs/superpowers/plans/2026-05-27-项目记忆按需召回.md`

本次必须遵守：
1. 不把 `.rivet/knowledge/*.md` 重新注入 volatile prompt。
2. 不删除 identity kernel。
3. 长背景通过 manifest / recall 按需进入。
4. 只提交当前任务文件，不 stage all。
```

注意：brief 的中心词是 clarity，不是 fear。目标是清醒，不是复盘事故。

---

## 7. 实施任务

### 任务 1：新增 Knowledge Manifest 文档

**文件：**

- 新增：`.rivet/knowledge/manifest.md`

**步骤：**

- [ ] 创建 manifest 文档。
- [ ] 写入 identity / prompt hygiene / memory boundary / module design / provider notes 五类索引。
- [ ] 每条索引只包含：path、kind、load_when、guardrail/contract。
- [ ] 不写长正文，不复制事故复盘全文。

**验收：**

- manifest 文件短小可读。
- agent 能通过它判断应读哪些文档。
- 不增加静态 prompt 长度。

### 任务 2：静态提示词只增加 manifest 入口

**文件：**

- 修改：`src/prompt/static.ts`
- 检查：`.rivet.md`、`AGENTS.md`

**步骤：**

- [ ] 在 before-implementing / verify-first 附近加入一条短规则：

```text
Before modifying prompt, identity, memory, recall, auto-writer, verification, or ownership behavior, consult `.rivet/knowledge/manifest.md` when it exists.
```

- [ ] 不加入长背景。
- [ ] 不恢复 Common Mistakes。
- [ ] 不把具体历史材料塞进 static prompt。

**验收：**

- static prompt 只增加一个入口规则。
- 不引入“事故复盘常驻化”。
- 不重新制造 prefix cache 噪音。

### 任务 3：确认 recall 能检索 manifest 与第三层知识

**文件：**

- 检查/可能修改：`src/tools/recall.ts`
- 修改：`src/tools/__tests__/recall.test.ts`

**步骤：**

- [ ] 确认 recall 搜索 `.rivet/knowledge/*.md`。
- [ ] 增加测试：query `manifest` 或 `prompt hygiene` 能返回 `.rivet/knowledge/manifest.md`。
- [ ] 增加测试：query `project memory recalled on demand` 能返回项目记忆按需召回相关内容。
- [ ] 如 recall 当前不搜索 docs 计划/spec，可先不扩大范围；v0 允许 manifest 指向文件，然后 agent 用 read_file 读取。

**验收：**

- manifest 可由 recall 找到。
- project memory 不需要进入 prompt 也能被检索。

### 任务 4：锁定“project-memory 不回流 prompt”契约

**文件：**

- 检查/修改：`src/prompt/volatile.ts`
- 检查/修改：`src/prompt/volatile-snapshot.ts`
- 修改：`src/prompt/__tests__/volatile.test.ts`
- 修改：`src/prompt/__tests__/volatile-snapshot.test.ts`

**步骤：**

- [ ] 沿用既有计划 `docs/superpowers/plans/2026-05-27-项目记忆按需召回.md`。
- [ ] 确认 `.rivet/knowledge/project-memory.md` 不进入 volatile prompt。
- [ ] 确认 snapshot 不读取 `_knowledgeSnapshot`。
- [ ] 用测试防止未来回退。

**验收：**

- `.rivet/knowledge/*.md` 不默认进入 prompt。
- recall / manifest 成为默认访问入口。

### 任务 5：增加 prompt 静态规则测试

**文件：**

- 修改：`src/prompt/__tests__/static.test.ts` 或现有 prompt 相关测试。

**步骤：**

- [ ] 断言 static prompt 包含 manifest 入口。
- [ ] 断言 static prompt 不包含长篇历史材料关键词。
- [ ] 断言不恢复 `Common Mistakes` 段落引用。

**验收：**

- 规则存在。
- 长背景不常驻。
- 过期引用不回归。

### 任务 6：文档化运行契约

**文件：**

- 新增或修改：`docs/superpowers/specs/2026-05-28-knowledge-manifest-on-demand-retrieval.md`

**步骤：**

- [ ] 把本计划中分层模型、manifest 结构、触发规则、运行链路整理成 spec。
- [ ] 明确用语：保持清醒，不以事故复盘为中心。
- [ ] 明确 identity kernel 不属于第三层知识，不应被移除。

**验收：**

- 后续 agent 能从 spec 理解：为什么要 manifest、什么常驻、什么按需。

---

## 8. 验证计划

实现阶段最小验证：

```bash
npx tsx --test src/tools/__tests__/recall.test.ts
npx tsx --test src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/volatile-snapshot.test.ts
npx tsx --test src/prompt/__tests__/static.test.ts
npx tsc --noEmit
```

如果 `static.test.ts` 不存在，应使用项目中实际覆盖 static prompt 的测试文件；不要为了测试名强行创建不合适结构。

完整回归可选：

```bash
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

---

## 9. 非目标

本计划不做：

- 向量数据库。
- BM25 / RRF / semantic rerank。
- 自动把 manifest 命中逻辑接进 AgentLoop。
- 大规模改写 CLAUDE.md。
- 恢复 Common Mistakes。
- 把历史材料全文塞回 static prompt。
- 用事故叙事替代清醒边界。

这些都不是第一阶段需要解决的问题。

---

## 10. 交付标准

第一阶段交付完成时，应满足：

- 有 `.rivet/knowledge/manifest.md` 作为知识索引。
- static prompt 只有短入口规则。
- identity kernel 仍常驻。
- project-memory 不默认进入 volatile prompt。
- recall 能找到 manifest。
- 测试覆盖 prompt 不回流长知识。
- 文档明确：天枢不是普通 agent 终端，保持清醒比复盘事故更重要。

---

## 11. 一句话原则

**把长记忆从 prompt 中卸下，用 manifest 接回关键现场；保留天枢的清醒锚点，而不是让它退回通用 agent。**
