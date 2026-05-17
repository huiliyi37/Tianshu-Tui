# Session Fluency + Project Memory — Code Review & 修复记录

> **日期**: 2026-05-17
> **审查范围**: `bbc5f8b` ~ `537c4b4` — 13 源文件, ~1000 行新增
> **审查者**: Claude Code

---

## 1. 审查结论

**APPROVE** — 核心逻辑正确，测试覆盖充分，2 个会话影响的已修复。

---

## 2. 提交清单

| Commit | 内容 | 状态 |
|--------|------|------|
| `bbc5f8b` | Fluency P1: policy engine + stage-health + RoutineCounter | ✅ |
| `d64eb1e` | Fluency P2: UI integration — fold routine tools + stale warning | ✅ |
| `99a5a28` | Dream P2/P3: gate+dedup+decisions + topic-classify+recall+volatile | ✅ |
| `537c4b4` | Fix: atomic write + abort reset | ✅ |

---

## 3. 发现与修复

### HIGH（已修复）

| # | 文件 | 行 | 问题 | 修复 |
|---|------|-----|------|------|
| 1 | `dream.ts` | 141 | `writeFileSync` 未用 `writeFileAtomicSync`，crash 时可损坏 `.rivet/knowledge/` 文件 | 改为 `writeFileAtomicSync` |
| 2 | `app.tsx` | 864 | abort 时不重置 `foldedCountRef` + `FluencyTracker`，中断状态泄漏到下次 turn | 两个 abort 路径加 reset |

### MEDIUM

| # | 文件 | 问题 | 处理 |
|---|------|------|------|
| 3 | `fluency-policy.ts` | `outputRate`/`resultLength` 字段定义了但 computeFluencyPolicy 未使用 | 后续移除 |
| 4 | `dream.ts` | `dedupKey.split(':')` — Windows 路径含 `:` 时拆分错误 | macOS/Linux 无影响，后续修复 |

### LOW

| # | 文件 | 问题 | 处理 |
|---|------|------|------|
| 5 | `fluency-hook.ts` | `updateSilence` 仅测试用，标记 `@internal` | 后续加注释 |
| 6 | `recall.ts` | `searchKnowledgeFiles` 无结果缓存 | 总文件 < 56KB，可接受 |

---

## 4. 验证结果

| 检查 | 结果 |
|------|------|
| Type check | ✅ Pass |
| Tests | ✅ 1193 pass, 0 fail |

---

## 5. 架构评估

### 优点

- **Fluency 策略引擎** 纯函数设计，与 UI 完全解耦，可独立测试
- **Dream 蒸馏** 模板化无 LLM 开销，去重和截断逻辑简洁
- **增量集成** 每个 Phase 只改最少代码，不影响现有行为

### 需要注意

- `FluencyTracker` 是 `useRef` 实例，不触发 React 重渲染，由 2s 轮询 interval 驱动 stale 检测 — 有效但有 2s 延迟
- `foldRoutine` 在 verbose 模式下不自动禁用 — 后续可能需要 `/verbose` 联动
