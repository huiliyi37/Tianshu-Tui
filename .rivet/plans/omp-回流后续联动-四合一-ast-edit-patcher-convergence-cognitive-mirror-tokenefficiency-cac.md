# omp 回流后续联动 — 四合一

> 2026-07-01。将 omp 回流累积的 13 个提交中完成的新能力，接入天枢现有的工作流管线。

## 架构数据流

```mermaid
flowchart TD
    subgraph A1["A1: ast_edit × patcher"]
        PLAN[plan_task 分解计划] --> PATCH[patcher worker]
        PATCH --> AE[ast_edit 替换 var→const]
        AE -->|dryRun:false| FS[(文件系统)]
    end
    subgraph A2["A2: convergence × cognitive mirror"]
        CONV[convergence signals] -->|precision/efficiency| CM[(cognitive mirror)]
        CM --> PROMPT[系统提示词中的认知状态摘要]
    end
    subgraph A3["A3: tokenEfficiency × cache"]
        LOOP[AgentLoop] -->|outputTokens| TE[tokenEfficiency]
        TE -->|交叉校验| CACHE[前缀缓存诊断]
    end
    subgraph A4["A4: ast_grep × review"]
        REV[review worker] -->|pattern| AG[ast_grep 精确匹配]
        AG -->|file:line:col| FINDING[审查发现]
    end
```

## 安全不变量

1. 所有改动均为**可选增强**，不改变现有默认行为
2. A1 仅扩展 patcher 的 allowedTools 列表，不修改 profile-registry 中的其他 profile
3. A2 仅新增 cognitive mirror 字段，不修改已有字段的语义
4. A3 仅新增交叉校验日志，不改变 cache 策略
5. A4 仅在 review worker prompt 中建议使用 ast_grep，不强制

## 任务拆解

### 任务 A1：ast_edit 接入 patcher worker

**文件:** `src/agent/profile-registry.ts`、`src/agent/worker-prompts.ts`

**改动：** patcher profile 的 `allowedTools` 数组追加 `'ast_edit'`

**验证：**
```bash
npx tsc --noEmit
node --import tsx --test src/agent/__tests__/profile-registry.test.ts
```

**commit:** `feat(patcher): add ast_edit to patcher toolset`

---

### 任务 A2：convergence precision + tokenEfficiency 接入 cognitive mirror

**文件:** `src/context/cognitive-mirror.ts`、`src/context/__tests__/cognitive-mirror.test.ts`、`src/agent/loop-factory.ts`

**改动：**
- `CognitiveMirrorState` 新增两个可选字段：
  ```typescript
  convergencePrecision?: number  // 0-1, 收敛检测精度指标（加权平均 novelty + oscillation 等）
  outputEfficiency?: number      // tokenEfficiency 当前值
  ```
- `loop-factory.ts` 在构建 cognitive mirror 快照时，从 `self.latestConvergenceResult?.signals` 提取 precision 和 tokenEfficiency

**验证：**
```bash
npx tsc --noEmit
node --import tsx --test src/context/__tests__/cognitive-mirror.test.ts
```

**commit:** `feat(cognitive-mirror): add convergence precision + output efficiency dimensions`

---

### 任务 A3：tokenEfficiency × cache 诊断交叉校验

**文件:** `src/agent/loop-factory.ts`（或新增 `src/agent/diagnostics.ts`）、`src/agent/__tests__/loop-factory.test.ts`

**改动：**
- 在 convergence 计算后（`loop.ts:1187` 附近），将 `signals.tokenEfficiency` 写入 cache-log 的额外字段
- 已有的 `cache-log.jsonl` 每轮记录 `{ turn, input_tokens, cache_read, cache_creation }`，追加 `token_efficiency: number`
- 可选：当 tokenEfficiency 从 >0.5 骤降到 <0.2 时，同时检查 cache hit rate 是否也骤降——如果是，输出诊断线索 "possible cache-break compensation loop"

**验证：**
```bash
npx tsc --noEmit
node --import tsx --test src/agent/__tests__/loop-factory.test.ts
```

**commit:** `feat(diagnostics): cross-validate tokenEfficiency with cache hit rate`

---

### 任务 A4：ast_grep 引导 review worker prompt

**文件:** `src/agent/profile-registry.ts` 的 `reviewer` profile

**改动：** reviewer 的 `expertisePrompt` 末尾追加一段建议：
```
For code search in review tasks, prefer ast_grep over grep when the target is a known syntax pattern (e.g., "find all async functions that don't have try-catch"). ast_grep matches AST nodes, not text, and won't produce false positives from comments or string literals.
```

**验证：**
```bash
npx tsc --noEmit
node --import tsx --test src/agent/__tests__/profile-registry.test.ts
```

**commit:** `feat(review): suggest ast_grep for syntax-pattern code search in review worker`

## 条件矩阵

| 条件 | A1 | A2 | A3 | A4 |
|------|:--:|:--:|:--:|:--:|
| patcher 调用 `ast_edit` 替换 `var→const` | patcher 可获得 ast_edit | - | - | - |
| agent 收敛检测精度提升 | - | mirror 展示 precision | - | - |
| tokenEfficiency 暴跌 + cache miss | - | - | 交叉校验日志 | - |
| review worker 搜索代码模式 | - | - | - | 建议 ast_grep |
| 零影响现有行为 | ✓ | ✓ | ✓ | ✓ |

## 执行顺序

A1 → A2 → A3 → A4（独立，可并行）。总改动约 6 文件 115 行，4 个独立 commit。
