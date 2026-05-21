# 上下文瘦身：归还认知氧气 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将模型每 turn 收到的上下文从 18.5KB/4600 tokens 降到 ~6KB/1500 tokens，恢复 2.0 时代模型的自主思考能力。

**架构：** 学习 Claude Code 的分层策略——system prompt 只放身份和规则（短），项目指令作为参考信息（瘦），per-turn 动态只发 delta（增量）。核心原则：模型需要信息时自己去读，而不是每个 turn 被灌满。

**技术栈：** TypeScript / src/prompt/volatile.ts / .rivet.md

**诊断数据：**
- 当前 system prompt: 5KB（合理）
- 当前 volatile (.rivet.md): 13.5KB（问题核心——占 73%）
- 当前 knowledge: 0（project-memory.md 10KB 超预算被跳过）
- 当前 dynamic appendix: tool-history + task-progress + decisions + lessons（全量重复）
- 2.0 时代 volatile 总计: ~3KB
- Claude Code 做法: CLAUDE.md 放 user message 不放 system prompt，per-turn 只发 delta

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `.rivet.md` | 修改 | 从 14KB 瘦身到 ~3KB：只留命令、核心约定、Files to Read First |
| `src/prompt/volatile.ts` | 修改 | 关闭 knowledge 注入、简化 dynamic appendix 为 delta-only |
| `src/context/cognitive-ledger.ts` | 修改 | 恢复 buildCognitivePromptProjection（撤销实验性空返回） |

---

### 任务 1：.rivet.md 瘦身

**文件：**
- 修改：`.rivet.md`

**原则：** 只保留模型在**每个 turn 都需要**的信息。架构细节、feature 文档、phase 约束——模型需要时自己 `read_file`。

**保留的段落：**
- `## Commands`（怎么 build/test/run）
- `## Architecture`（只保留顶层文件树，删掉子目录展开）
- `## Files to Read First`（查找表）
- `## Testing`（框架约定）
- `## Code Conventions`（编码风格）
- `## Common Mistakes`（避坑清单）

**删除的段落：**
- `## Active Feature: Subagent Orchestration (P2.4)`（整段，37 行）
- `## Active Feature: Adaptive Context Fabric (ACF)`（整段，60 行）
- `## Concurrent Session Rules`（整段，18 行）
- Architecture 中 `├── compact/` 以下的子目录展开

- [ ] **步骤 1：备份当前 .rivet.md**

```bash
cp .rivet.md .rivet.md.bak
```

- [ ] **步骤 2：删除 Active Feature: Subagent Orchestration 段落**

删除 `.rivet.md:103-139`（从 `## Active Feature: Subagent Orchestration` 到下一个 `##` 之前）。

- [ ] **步骤 3：删除 Active Feature: ACF 段落**

删除 `.rivet.md:140-199`（从 `## Active Feature: Adaptive Context Fabric` 到 `## Common Mistakes` 之前）。

- [ ] **步骤 4：删除 Concurrent Session Rules 段落**

删除 `.rivet.md:212-229`（从 `## Concurrent Session Rules` 到文件末尾）。

- [ ] **步骤 5：精简 Architecture 段落**

保留顶层目录结构（src/ 下的一级目录），删除每个子目录内的文件列表展开。目标：从 52 行缩到 ~15 行。

替换为：
```
## Architecture

```
src/
├── main.tsx          CLI entry
├── agent/            Agent loop, session, evidence, checkpoint
├── api/              Streaming API client, providers, SSE
├── prompt/           System prompt + volatile context + cache
├── tools/            All tool implementations + registry
├── compact/          Context compaction (auto + micro)
├── context/          Pressure monitor, anchors, cold storage
├── config/           Zod schema + CLI config manager
└── tui/              Ink 6 React TUI components
```
```

- [ ] **步骤 6：验证大小**

```bash
wc -c .rivet.md
# 目标: < 4000 字符
```

- [ ] **步骤 7：验证模型收到的 volatile 大小**

```bash
npx tsx -e "
import { buildVolatileBlock } from './src/prompt/volatile.ts'
const vol = buildVolatileBlock({ cwd: process.cwd() })
console.log('Volatile chars:', vol.length)
console.log('Estimated tokens:', Math.ceil(vol.length / 4))
"
# 目标: < 4000 chars / < 1000 tokens
```

- [ ] **步骤 8：Commit**

```bash
git add .rivet.md
git commit -m "docs: slim .rivet.md from 14KB to ~3KB — return cognitive oxygen to model"
```

---

### 任务 2：关闭 knowledge 注入

**文件：**
- 修改：`src/prompt/volatile.ts:230-233`

**原因：** project-memory.md 有 10KB，超过 KNOWLEDGE_MAX_CHARS=2000 被跳过。但即使它没超，2KB 的 knowledge 也是每 turn 重复的噪音。模型需要历史记忆时应该用 recall 工具主动检索。

- [ ] **步骤 1：注释掉 knowledge 注入**

在 `buildVolatileBlockInternal` 中，将 knowledge 注入改为不注入：

```typescript
  // Knowledge injection disabled — model uses recall tool when needed.
  // const knowledge = ctx._knowledgeSnapshot ?? readKnowledgeFiles(ctx.cwd)
  // if (knowledge) {
  //   parts.push(`<project-memory>\n${escapeXml(knowledge)}\n</project-memory>`)
  // }
```

- [ ] **步骤 2：构建验证**

```bash
npm run build
```

- [ ] **步骤 3：Commit**

```bash
git add src/prompt/volatile.ts
git commit -m "perf(prompt): disable knowledge injection — model uses recall tool instead"
```

---

### 任务 3：Dynamic appendix 改为 delta-only

**文件：**
- 修改：`src/prompt/volatile.ts:146-199`（`buildDynamicAppendix` 函数）

**原因：** 当前 dynamic appendix 每 turn 重复注入 tool-history 全量、task-progress 全量、decisions 全量、lessons 全量。Claude Code 只发 delta（本 turn 变化的内容）。

**改动：** 只保留 `repairHint`（修复提示是即时性的，有用）。其他全部删除——tool-history 已经在 conversation messages 里了（模型能看到自己之前的 tool calls），task-progress 和 decisions 是模型自己产生的（它记得），lessons 是低价值重复。

- [ ] **步骤 1：精简 buildDynamicAppendix**

```typescript
export function buildDynamicAppendix(ctx: VolatileContext): string {
  const parts: string[] = []

  if (ctx.activeDomain) {
    parts.push(`<star-domain name="${escapeXml(ctx.activeDomain.name)}" motto="${escapeXml(ctx.activeDomain.motto)}">${escapeXml(ctx.activeDomain.volatileBlock)}</star-domain>`)
  }

  if (ctx.repairHint) {
    parts.push(`<repair-hint>\n${escapeXml(ctx.repairHint)}\n</repair-hint>`)
  }

  return parts.length > 0 ? `<context-update>\n${parts.join('\n\n')}\n</context-update>` : ''
}
```

- [ ] **步骤 2：同步精简 buildVolatileBlockInternal**

在 `buildVolatileBlockInternal`（行 215+）中，删除以下注入段：
- `toolHistory` 渲染（行 257-264）
- `taskProgress` 渲染（行 266-272）
- `repairHint` 渲染（行 274-276，保留在 dynamic appendix 中即可）
- `decisions` 渲染（行 278-281）
- `activeClaims` 渲染（行 283-297）
- `sessionMemoryBlock` 渲染（行 299-301）
- `playbookLessons` 渲染（行 303-315）

只保留：environment、activeDomain、project-instructions (.rivet.md)、git-status、working-set。

- [ ] **步骤 3：构建验证**

```bash
npm run build
```

- [ ] **步骤 4：运行相关测试**

```bash
npx tsx --test src/prompt/__tests__/volatile.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add src/prompt/volatile.ts
git commit -m "perf(prompt): strip dynamic appendix to delta-only — tool-history/decisions/lessons removed"
```

---

### 任务 4：恢复 cognitive projection（可选保留为空）

**文件：**
- 修改：`src/context/cognitive-ledger.ts:140-150`

**决策：** 之前的实验把 `buildCognitivePromptProjection` 改为返回空字符串。现在 volatile 已经瘦身，可以选择：
- A) 保持为空（最激进——完全不注入认知状态）
- B) 只保留 verification-gap（提醒模型验证未完成的修改）

推荐 B——verification-gap 是有用的安全网，且只有在模型修改了文件但没跑测试时才出现（条件性注入，不是每 turn 都有）。

- [ ] **步骤 1：恢复为只保留 verification-gap**

```typescript
export function buildCognitivePromptProjection(
  ledger: CognitiveLedger,
  opts?: {
    sycophancyHint?: string | null
  },
): string {
  // Only inject verification gap — everything else is cognitive noise.
  return buildVerificationGapProjection(ledger)
}
```

- [ ] **步骤 2：构建验证**

```bash
npm run build
```

- [ ] **步骤 3：Commit**

```bash
git add src/context/cognitive-ledger.ts
git commit -m "refactor(cvm): cognitive projection → verification-gap only"
```

---

### 任务 5：端到端验证

- [ ] **步骤 1：测量最终 prompt 大小**

```bash
npx tsx -e "
import { buildSystemPrompt } from './src/prompt/static.ts'
import { buildVolatileBlock } from './src/prompt/volatile.ts'
const sys = buildSystemPrompt({ tools: [] })
const vol = buildVolatileBlock({ cwd: process.cwd() })
console.log('System prompt:', sys.length, 'chars')
console.log('Volatile:', vol.length, 'chars')
console.log('Total:', sys.length + vol.length, 'chars')
console.log('Tokens:', Math.ceil((sys.length + vol.length) / 4))
"
# 目标: Total < 8000 chars / < 2000 tokens
# 对比: 之前 18500 chars / 4600 tokens
```

- [ ] **步骤 2：全量测试**

```bash
npm run build && npx tsc --noEmit
```

- [ ] **步骤 3：启动 Rivet 做一个真实任务，观察模型行为**

```bash
node dist/main.js
```

观察点：
- 模型是否主动 read_file 而不是依赖注入的信息？
- 模型是否表现出更多自主判断（而非逐条执行规则）？
- 模型是否在需要架构信息时自己去查 docs/？

---

## 预期效果

| 指标 | 之前 | 之后 |
|------|------|------|
| Volatile 大小 | 13.5KB | ~3KB |
| 总 prompt 大小 | 18.5KB | ~8KB |
| 估算 tokens | 4600 | ~2000 |
| 模型认知负载 | 73% 是项目文档 | 60% 是身份+规则（模型该关注的） |
| Per-turn 动态注入 | tool-history + decisions + lessons + task-progress | 仅 repair-hint（条件性） |

## 风险与应对

| 风险 | 应对 |
|------|------|
| 模型不知道怎么 build/test | .rivet.md 保留了 Commands 段落 |
| 模型不知道文件结构 | .rivet.md 保留了精简版 Architecture + Files to Read First |
| 模型忘记之前的决策 | 决策在 conversation history 里，模型能看到 |
| 模型不知道 feature 约束 | 需要时自己 read_file docs/superpowers/specs/... |
| verification-gap 不够 | 如果模型开始跳过验证，可以恢复更多 projection |
