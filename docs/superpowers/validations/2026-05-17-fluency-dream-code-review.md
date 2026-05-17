# Session Fluency + Project Memory — Code Review & 修复记录

> **日期**: 2026-05-17
> **审查范围**: `bbc5f8b` ~ `a8bf8ab` — Session Fluency P1/P2, Project Memory Dream P2/P3, recall cwd closure, and TUI evidence preservation
> **审查者**: Claude Code

---

## 1. 审查结论

**APPROVE** — 核心逻辑正确，测试覆盖充分，会话影响项已收口到 `main` 基线。

---

## 2. 提交清单

| Commit | 内容 | 状态 |
|--------|------|------|
| `bbc5f8b` | Fluency P1: policy engine + stage-health + RoutineCounter | ✅ |
| `d64eb1e` | Fluency P2: UI integration — fold routine tools + stale warning | ✅ |
| `99a5a28` | Dream P2/P3: gate+dedup+decisions + topic-classify+recall+volatile | ✅ |
| `537c4b4` | Fix: atomic write + abort reset | ✅ |
| `a8bf8ab` | Closure fix: folded tool evidence, high-volume fluency signals, active-phase heartbeat, recall cwd knowledge lookup | ✅ |

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
| 3 | `fluency-policy.ts` / `fluency-hook.ts` | `outputRate`/`resultLength` 字段定义了但未进入策略决策 | `a8bf8ab` 已接入 high-volume inspect + coalescing 策略，并补回归测试 |
| 4 | `app.tsx` | routine tool folding 只递增计数，缺少 bounded evidence | `a8bf8ab` 已保留摘要型 tool log entry，避免“折叠=证据消失” |
| 5 | `recall.ts` | project knowledge 只读 `ctx.cwd`，正常 tool execution 未传 ctx 时查不到 `.rivet/knowledge/` | `a8bf8ab` 已回退到 `ToolCallParams.cwd`，并补测试 |
| 6 | `dream.ts` | `dedupKey.split(':')` — Windows 路径含 `:` 时拆分错误 | macOS/Linux 无影响，后续修复 |

### LOW

| # | 文件 | 问题 | 处理 |
|---|------|------|------|
| 7 | `fluency-hook.ts` | `updateSilence` 仅测试用，标记 `@internal` | 后续加注释 |
| 8 | `recall.ts` | `searchKnowledgeFiles` 无结果缓存 | 总文件 < 56KB，可接受 |

---

## 4. 验证结果

| 检查 | 结果 |
|------|------|
| Focused fluency/recall tests | ✅ 77 pass, 0 fail |
| Type check | ✅ Pass |
| Full tests | ✅ 1195 pass, 0 fail |
| Build | ✅ Pass |

---

## 5. 架构评估

### 优点

- **Fluency 策略引擎** 纯函数设计，与 UI 完全解耦，可独立测试
- **Dream 蒸馏** 模板化无 LLM 开销，去重和截断逻辑简洁
- **增量集成** 每个 Phase 只改最少代码，不影响现有行为

### 需要注意

- `FluencyTracker` 是 `useRef` 实例，不触发 React 重渲染；closure fix 已在 thinking/streaming/tool/live-output 路径 heartbeat，避免 stale 计时沿用旧事件。
- `foldRoutine` 在 verbose 模式下仍会保留 bounded evidence；后续如果要做 `/verbose` 联动，应只调整展开策略，不应回到无界 live rendering。
