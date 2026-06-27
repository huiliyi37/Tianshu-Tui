> **Status: APPROVED** — 2026-06-27T07:43:07.177Z

# omp 回流 P4 — sensorium complexity 改用 Shannon 熵

# omp 回流 P4 — sensorium complexity 改用 Shannon 熵

> 来源: `.rivet/knowledge/tianshu-omp-feature-inventory.md` 优先级 4

**目标:** `src/agent/sensorium.ts:computeComplexity` 从 `unique/total` 简单比率改为 Shannon 熵 `-Σ p_i × ln(p_i) / ln(n)`。

**收益:** 熵考虑分布偏斜——`{A×4, B×1}` 和 `{A×3, B×2}` 都是 `unique/total=0.4`，但前者更不均匀（更接近循环），熵能区分。窗口从固定的 5 扩大到全量 toolCallHistory。

---

## 事实流图

```mermaid
flowchart TD
    U(toolCallHistory: string[]) --> C{{computeComplexity}}
    C -->|old| O[unique / total, max 5]
    C -->|new| E[Shannon entropy / ln n, all entries]
    E --> S{{computeStrategy}}
    S --> P[StrategyProfile]
    P -.-> R[reasoningEffort threshold at complexity > 0.7]
```

---

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/agent/sensorium.ts` | `computeComplexity` 函数重写 |
| `src/agent/__tests__/sensorium.test.ts` | 更新旧断言 + 新增熵验证测试 |

---

## 条件矩阵

| 条件 | 旧值 | 新值 |
|------|------|------|
| `toolHistory = []` | 0 | 0（不变） |
| `toolHistory = ['a','a','a','a','a']` | 0.2 (1/5) | 0 (单工具零熵) |
| `toolHistory = ['a','b','a','b','a']` | 0.4 (2/5) | ~0.97 (均匀分布高熵) |
| `toolHistory = ['a','a','a','a','b']` | 0.4 (2/5) | ~0.72 (偏斜分布中熵) |
| 全量 vs 窗口 5 | 仅取最后 5 | 取全部（更稳定） |

---

## 任务拆解

### 任务 1: 重写 `computeComplexity` + 导出（`sensorium.ts`）

将 `computeComplexity` 改为 Shannon 熵实现，移除 `toolCallHistory.slice(-5)` 窗口限制。

**验证:**
```bash
npx tsc --noEmit
node --import tsx --test src/agent/__tests__/sensorium.test.ts
```

### 任务 2: 更新测试（`sensorium.test.ts`）

更新旧断言（`unique/total` 期望值不再有效），新增：空输入→0、单工具→0、均匀分布→高值、偏斜分布→中间值。

### 任务 3: 全量回归

```bash
npx tsc --noEmit
node --import tsx --test src/agent/__tests__/sensorium.test.ts
node --import tsx --test src/agent/__tests__/convergence-detector.test.ts
```

---

## omp 参考

```typescript
// omp packages/agent/src/sensorium.ts:157-168
function computeComplexity(toolNames: string[]): number {
  if (toolNames.length === 0) return 0
  const counts = new Map<string, number>()
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  if (counts.size === 1) return 0
  const n = toolNames.length
  let entropy = 0
  for (const count of counts.values()) { const p = count / n; entropy -= p * Math.log2(p) }
  const maxEntropy = Math.log2(counts.size)
  return maxEntropy > 0 ? entropy / maxEntropy : 0
}
```
