# Wave 1 任务文档：Verification Dashboard

> 任务编号：W1-06
> 优先级：中
> 预估：单 session，1 小时
> 前置依赖：无

## 目标

在 TUI 状态栏和专用面板中显示验证状态：哪些文件被修改了、哪些已验证、哪些还没跑测试。让用户一眼看到"这个 session 的交付质量"。

## 背景

已有基础：
- `src/agent/evidence.ts` — EvidenceTracker（filesModified, verifiedCount, deliveryStatus）
- `src/context/cognitive-ledger.ts` — buildVerificationGapProjection（模型侧已有）
- `src/tui/status-bar.tsx` — 状态栏组件

当前问题：verification gap 只对模型可见（通过 cognitive projection 注入），用户看不到。

## 设计

### 状态栏扩展

```
[task] DeepSeek V4 | cache 98% | ¥0.12 | 15 turns | ✓3/5 files verified
```

最后一段 `✓3/5 files verified`：
- 绿色：全部验证
- 黄色：部分验证
- 红色：有修改但零验证

### 验证面板（`/verify` 命令）

```
╭─ Verification Status ─────────────────────╮
│                                            │
│  Modified files:                           │
│    ✓ src/prompt/mode.ts          (tested)  │
│    ✓ src/prompt/engine.ts        (typed)   │
│    ✗ src/agent/loop.ts           (pending) │
│    ✗ src/tui/slash-commands.ts   (pending) │
│                                            │
│  Verification: 2/4 (50%)                   │
│  Last test run: 12 passed, 0 failed        │
│                                            │
╰────────────────────────────────────────────╯
```

### 验证级别

```typescript
type VerificationLevel = 
  | 'tested'    // run-tests 覆盖了这个文件
  | 'typed'     // tsc --noEmit 通过
  | 'linted'    // lint 通过
  | 'pending'   // 修改了但未验证
```

## 实现计划

### Task 1: 扩展 EvidenceTracker

修改 `src/agent/evidence.ts`：
- 记录每个文件的 VerificationLevel
- 当 run-tests 工具执行后，标记相关文件为 'tested'
- 当 tsc 执行后，标记所有 .ts 文件为 'typed'

### Task 2: 状态栏集成

修改 `src/tui/status-bar.tsx`：
- 新增验证摘要段（`✓N/M files verified`）
- 颜色编码

### Task 3: /verify 命令

修改 `src/tui/slash-commands.ts`：
- 新增 `/verify` 命令
- 渲染验证面板（文件列表 + 状态 + 摘要）

### Task 4: 测试

- EvidenceTracker 扩展测试
- 状态栏渲染测试（不同验证比例的颜色）

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/evidence.test.ts
npx tsx --test src/tui/__tests__/status-bar.test.ts
```

## 不做的事

- 不做自动触发验证（模型决定何时验证）
- 不做覆盖率追踪（太重）
- 不做文件级测试映射（related-tests 已有，但不在此集成）
