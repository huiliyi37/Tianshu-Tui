# Diet 占位符退避：从硬阻止到渐进提醒

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `[diet:redundant]`/`[diet:useless]` 的响应从"2 次即死"硬阻止改为三阶段渐进式提醒（提醒 → 警告 → 阻止），保留模型在上下文压缩后重新读取所需文件的能力。

**架构：** 两处零风险改动。(1) `static.ts` prompt 措辞从"连续 2 次 → 停止"改为"第 2 次 → 提醒确认需求 + 建议替代工具，第 3 次 → 警告，第 4 次保持禁止"；(2) `behavior-mirror.ts` 的 `detectReadLoop` 警告文案同步软化，补充 `read_section`/`offset/limit` 等精确读取建议。`agent-diet.ts` 的压缩逻辑正确且独立，不修改。

**技术栈：** TypeScript strict, 纯文本/prompt 工程

---

## 1. Scope Check

两个改动点相互独立，各自可单独验证：

| 改动 | 文件 | 影响范围 |
|------|------|---------|
| Prompt 措辞软化 | `src/prompt/static.ts:38` | 模型行为规则 |
| behavior-mirror 文案 + 策略建议 | `src/agent/behavior-mirror.ts:17` | volatile context 中的运行时警告 |

不涉及 agent-diet.ts 的压缩逻辑——压缩算法本身正确，问题出在模型对压缩结果的响应策略上。

## 2. File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/prompt/static.ts` | 修改 diet 防循环规则：2 次 → 提醒，3 次 → 警告 | 修改 |
| `src/agent/behavior-mirror.ts` | `detectReadLoop` 文案从 "Stop" 改为 "Consider alternatives" | 修改 |
| `src/prompt/__tests__/static.test.ts` | 更新 prompt 断言 | 修改 |
| `src/agent/__tests__/behavior-mirror.test.ts` | 更新断言匹配新文案 | 修改 |

## 3. Research Endorsement

### 3a. static.ts prompt 规则修改

**当前规则** (`static.ts:38`):
```
同一文件 read_file 连续 2 次返回 [diet:redundant]/[diet:useless]，停止 read_file；必须切换到 grep / ask_user_question
```

**修改后规则**:
```
第 2 次同文件返回 [diet:redundant]/[diet:useless] 时，先确认是否仍需该文件内容——若需要，用 read_section 精确定位、或用 offset/limit 缩小范围、或用 grep 搜索符号。第 3 次返回 diet 占位符时才必须停止 read_file 并切换策略。
```

**调用链**: 此规则被模型读取并遵循。无代码调用方依赖此文案。

**边缘案例**: 模型可能利用宽松规则在压缩后重复读取 3 次，消耗 3 倍上下文。缓解：第 3 次仍会触发 behavior-mirror 警告 + prompt 规则阻止，总消耗可控。

### 3b. behavior-mirror.ts 文案修改

**当前文案** (`behavior-mirror.ts:17`):
```
read_loop: warn — read_file for ${name} returned diet no-info placeholders ${count} times. Stop rereading this path; switch to grep, repo_graph, or ask_user_question.
```

**修改后文案**:
```
read_loop: warn — read_file for ${name} returned diet no-info placeholders ${count} times. If you need its content, try read_section with a precise line range instead of re-reading the whole file. grep or repo_graph may also help.
```

**调用链追踪**:
- `detectReadLoop()` → `detectMirror()` → `behaviorMirror` 字段通过 `VolatileContext.behaviorMirror` 注入 prompt
- `tool-pipeline.ts` 中 `countRecentReadLoopPlaceholders` 也检查 diet 结果，但用于决定是否注入 `repairHint`，不直接依赖文案
- 调用方不解析此字符串内容，仅注入 prompt

**风险**: 无。此字符串仅作为提示信息注入到 prompt 中，模型自行理解。

## 4. Tasks

### Task 1: 软化 static prompt 中的 diet 防循环规则

- [ ] 修改 `src/prompt/static.ts:38`
  - 将 diet 规则从"2 次 → 停止"改为三阶段表述

```typescript
// 修改前（约第 38 行）:
// 防循环：同一文件 read_file 连续 2 次返回 [diet:redundant]/[diet:useless]，停止 read_file；
// 必须切换到 grep / ask_user_question，若专用工具不足且规则允许才用 bash sed 精确取片段。
// 禁止第 4 次对同一路径直接 read_file。

// 修改后:
// 防循环：第 2 次同文件返回 [diet:redundant]/[diet:useless] 时先确认是否需要该文件内容
// ——若需要，用 read_section 精确定位或用 offset/limit 缩小范围。
// 第 3 次 diet 占位符时停止 read_file 并切到 grep/repo_graph/ask_user_question。
// 禁止第 4 次对同一路径直接 read_file。
```

- [ ] 修改 `src/prompt/__tests__/static.test.ts` 中对应的断言
  - 确认 prompt 仍然包含 `[diet:redundant]` 和 `[diet:useless]` 关键字
  - 确认不再包含"停止 read_file"紧跟"连续 2 次"的激进表述
  - 确认包含"第 3 次"和"停止"的渐进式表述

- [ ] 运行验证: `npx tsc --noEmit && npm exec tsx -- --test src/prompt/__tests__/static.test.ts`
  - 预期: 所有测试通过

- [ ] 提交: `git commit -m "docs(prompt): soften diet anti-loop rule — remind at 2nd, stop at 3rd"`

### Task 2: 更新 behavior-mirror 的 readLoop 警告文案

- [ ] 修改 `src/agent/behavior-mirror.ts:17`
  - 将 "Stop rereading" 改为建议式的 "Consider alternatives"，并补充 `read_section` 建议

```typescript
// 修改前:
return `read_loop: warn — read_file for ${name} returned diet no-info placeholders ${count} times. Stop rereading this path; switch to grep, repo_graph, or ask_user_question.`

// 修改后:
return `read_loop: warn — read_file for ${name} returned diet no-info placeholders ${count} times. If you still need this file's content, use read_section with a precise line range instead of re-reading the whole file. grep or repo_graph may also work.`
```

- [ ] 修改 `src/agent/__tests__/behavior-mirror.test.ts` 中对应断言
  - 确认测试仍然检测到 read_loop 警告
  - 确认包含 `read_section` 建议关键字
  - 确认不再包含 `Stop rereading`

- [ ] 运行验证: `npx tsc --noEmit && npm exec tsx -- --test src/agent/__tests__/behavior-mirror.test.ts`
  - 预期: 所有测试通过

- [ ] 提交: `git commit -m "refactor(agent): soften readLoop warning — suggest read_section instead of hard stop"`

## 5. Verification

### Task 1 验证
```bash
npx tsc --noEmit
npm exec tsx -- --test src/prompt/__tests__/static.test.ts
```
预期: 测试通过，prompt 包含渐进式措辞

### Task 2 验证
```bash
npx tsc --noEmit
npm exec tsx -- --test src/agent/__tests__/behavior-mirror.test.ts
```
预期: 测试通过，警告文案包含 `read_section`

### 集成验证
```bash
# 确认 agent-diet 压缩逻辑不受影响
npm exec tsx -- --test src/compact/__tests__/agent-diet.test.ts
```
预期: 所有 diet 测试仍通过（未修改 agent-diet.ts，但确保未引入间接影响）

## 6. Self-Check

### Spec Coverage
| 需求 | Task | 状态 |
|------|------|------|
| 2 次 diet → 提醒而非停止 | Task 1 | ✅ |
| behavior-mirror 文案软化 | Task 2 | ✅ |
| 保留 read_section 建议 | Task 2 | ✅ |
| 不修改 agent-diet 压缩 | 无改动 | ✅ |
| 第 4 次保持硬阻止 | Task 1 | ✅ |

### Placeholder Scan
- ✅ 无 TODO/TBD/待定
- ✅ 所有代码片段精确可执行
- ✅ 所有文件路径精确

### Type Consistency
- ✅ 仅修改字符串常量，无类型变更
- ✅ 测试断言匹配新字符串内容

## 7. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-01-diet-gradual-retreat.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
