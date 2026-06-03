# REM Playbook-Reflect — 跨 Session 模式检测

> 日期：2026-06-04
> 来源：联动 #3 REM 阶段（recall-gated NREM 设计文档 §6）
> 前置：NREM recall-gate 已实现（`canRecallClaim` + `promoteEligibleClaims`）
> 状态：设计阶段

---

## 1. 问题

当前 playbook-reflect 只在单个 session 结束时运行：如果 session 的 vigor variability 高或 stability 低，就提取 retrospective 中的根因和建议存为 `PlaybookBullet`。但这有两个结构性缺陷：

1. **无跨 session 视角**：每个 session 独立反思，无法检测"这个项目反复出现同一类问题"的跨 session 模式。PlaybookStore 是 per-project 的（`.rivet/playbook.jsonl`），但 reflect 逻辑没有跨 session 比较能力。
2. **无泛化能力**：每次提取的 bullet 是具体的（如"验证反馈不足 + 策略振荡组合"），没有抽象为通用模式（如"涉及多个子系统并行修改时，验证覆盖率不足"）。

REM 阶段要解决的核心问题：**从多次 session 的反思结果中提取跨 session 重复出现的模式，并只巩固这些模式**。

---

## 2. 现有基础设施

### 2.1 已有模块

| 模块 | 位置 | 职责 |
|------|------|------|
| `playbook-reflect-hook.ts` | `src/agent/hooks/` | PostSession hook，触发条件检查 + retrospect 生成 + bullet 提取 |
| `playbook.ts` | `src/agent/` | PlaybookBullet 类型、extractBullets、deduplicateBullets、matchBullets、decayImportance、enforceCapacity |
| `playbook-store.ts` | `src/agent/` | JSONL 持久化 (.rivet/playbook.jsonl)、load/save/addBullets/query/recordUsage |
| `retrospect.ts` | `src/agent/` | NTSB 四层分析报告生成（事实时间线、四层分析、根因判定、寻址建议） |
| `dream.ts` | `src/agent/` | Session-end knowledge distillation → `.rivet/knowledge/project-memory.md` |
| `session-registry.ts` | `src/agent/` | SQLite 跨 session 注册表（session 元数据、文件 claim、事件发布/订阅、cycle relay） |
| `promotion.ts` | `src/context/` | `canRecallClaim` + `evaluatePromotion` — claim 晋升管道 |
| `cross-session-hook.ts` | `src/agent/hooks/` | PreTurn hook，消费其他 session 的事件注入动态 appendix |

### 2.2 数据流现状

```
Session 结束
  → PostSession hooks:
    1. dream-distill: 决策蒸馏 → .rivet/knowledge/project-memory.md
    2. playbook-reflect: shouldReflect? → generateRetrospect → extractBullets → store.addBullets
    3. telemetry-flush: 遥测写入
    4. songline (可选): cycle relay 沉积
```

PlaybookBullet 在 session 运行时通过 `matchBullets(keywords)` 被查询，匹配到的 bullet 注入 prompt context。

### 2.3 关键约束

- **Prefix Cache 安全**：任何注入 prompt 的内容必须通过 volatile appendix 或 dynamic section 实现，不能破坏 static prefix。
- **PlaybookStore 是同步的**：`load()` / `save()` 使用 `readFileSync` / `writeFileAtomicSync`。跨 session 检测也必须保持同步或仅在 postSession 中异步执行。
- **SessionRegistry 是 SQLite**：跨 session 查询能力已存在，但当前仅用于文件 claim 和事件路由。

---

## 3. 设计

### 3.1 核心概念：PatternBullet

REM 阶段引入新的知识单元 `PatternBullet`，与现有的 `PlaybookBullet` 平行但层次更高：

| 维度 | PlaybookBullet（NREM） | PatternBullet（REM） |
|------|----------------------|---------------------|
| 来源 | 单次 session 的 retrospect | 多次 session 的 bullet 聚合 |
| 粒度 | 具体教训（"验证反馈不足"） | 抽象模式（"并行修改多子系统时验证不足"） |
| 生命周期 | session 结束时写入 | 跨 session 反复出现时巩固 |
| 淘汰 | decayImportance + enforceCapacity | 连续 3+ session 未重现则抑制 |
| 触发 | shouldReflect 门控通过 | 跨 session 频率门控通过 |

**决策：PatternBullet 复用 PlaybookBullet 结构**，不引入新类型。理由：
- 现有的 `matchBullets` / `deduplicateBullets` / `decayImportance` 算法已成熟
- 通过 `context` 字段区分：NREM bullet 的 context 是 `'root-cause' | 'recommendation'`，REM bullet 的 context 是 `'pattern:recurring'` 或 `'pattern:suppressed'`
- 减少新代码，复用已有基础设施

### 3.2 跨 Session 模式检测算法

#### Step 1: Session Retrospect 指纹

每次 session 的 retrospect 生成一个**指纹**，用于跨 session 比较：

```typescript
interface RetrospectFingerprint {
  sessionId: string
  rootCauseKeywords: string[]    // 从 §3 根因判定提取
  recommendationKeywords: string[] // 从 §4 寻址建议提取
  stabilityTrend: 'stable' | 'falling' | 'rising'
  confidenceTrend: 'stable' | 'falling' | 'rising'
  maxPressure: number
  toolFailureRate: number
  bulletIds: string[]            // 本次 session 提取的 bullet id
}
```

#### Step 2: 跨 Session 相似度比较

在 playbook-reflect-hook 的 postSession 中，除了提取当前 session 的 bullets，还执行**模式检测**：

```typescript
function detectCrossSessionPatterns(
  currentFingerprint: RetrospectFingerprint,
  historicalFingerprints: RetrospectFingerprint[],
  existingBullets: PlaybookBullet[],
): PlaybookBullet[]
```

逻辑：
1. 在 `historicalFingerprints` 中找到与当前 session 的 `rootCauseKeywords` 重叠度 ≥ 0.5 的历史 session
2. 对于每个匹配的历史 session，检查是否已有对应的 PlaybookBullet
3. 如果已有：增加其 `importance`（跨 session 强化）
4. 如果没有且匹配 session 数 ≥ 2：创建新的 PatternBullet，context 标记为 `'pattern:recurring'`

#### Step 3: 抑制性过滤

```typescript
function suppressStalePatterns(
  bullets: PlaybookBullet[],
  recentFingerprints: RetrospectFingerprint[],
): PlaybookBullet[]
```

- 连续 3 次 session 中没有重现的 pattern → context 更新为 `'pattern:suppressed'`
- suppressed 状态的 bullet 的 `importance` 加速衰减
- 下次再出现时自动解除 suppressed 状态

### 3.3 Retrospect 指纹存储

指纹存储在 **SessionRegistry** 中（复用现有 SQLite 基础设施），新增一张表：

```sql
CREATE TABLE IF NOT EXISTS retrospect_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  root_cause_keywords TEXT NOT NULL,    -- JSON array
  recommendation_keywords TEXT NOT NULL, -- JSON array
  stability_trend TEXT NOT NULL,
  confidence_trend TEXT NOT NULL,
  max_pressure REAL NOT NULL,
  tool_failure_rate REAL NOT NULL,
  bullet_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  UNIQUE(session_id)
);
```

选择 SessionRegistry 的理由：
- 已有 SQLite 连接，无需新数据存储
- 跨 session 查询能力天然存在
- cleanupOldEvents 已有清理机制，可扩展

### 3.4 完整数据流

```
Session 结束
  → PostSession: playbook-reflect-hook
    1. shouldReflect? → No: 跳过
    2. generateRetrospect(input)
    3. extractBullets(report) → currentBullets
    4. buildRetrospectFingerprint(report, currentBullets) → fingerprint
    5. storeFingerprint(registry, fingerprint) → 存入 SQLite
    6. loadHistoricalFingerprints(registry, limit=10) → historical
    7. detectCrossSessionPatterns(fingerprint, historical, existing) → patternBullets
    8. store.addBullets([...currentBullets, ...patternBullets])
    9. suppressStalePatterns(store.load(), historical) → 更新 store
```

### 3.5 shouldReflect 的 REM 扩展

当前 `shouldReflect` 的门控条件：
- `vigor.variability > 0.3` 或 `> 0.15`（中等或高波动）
- `sensorium.stability < 0.5`（低稳定性）
- `doomLevel !== 'none'`（陷入 doom loop）

REM 扩展：即使 session 表现良好（`shouldReflect` 返回 false），也可以执行**轻量模式检测**：

```typescript
function shouldRunREM(
  vigor: VigorState,
  sensorium: Sensorium,
  doomLevel: DoomLoopLevel | string,
  sessionCount: number, // SessionRegistry 中该项目的 session 数量
): 'full' | 'light' | 'skip'
```

- `'full'`：原 shouldReflect 通过 → 完整 reflect + 模式检测
- `'light'`：shouldReflect 未通过，但 sessionCount ≥ 3 → 只做指纹存储 + 模式检测（跳过 retrospect 生成和 bullet 提取）
- `'skip'`：shouldReflect 未通过且 sessionCount < 3 → 完全跳过

这确保即使每个 session 都很顺利，跨 session 模式也能被检测到。

---

## 4. 模块变更

### 4.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/agent/retrospect-fingerprint.ts` | 指纹类型定义 + 构建 + 序列化 |
| `src/agent/__tests__/retrospect-fingerprint.test.ts` | 指纹构建和比较测试 |

### 4.2 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/playbook.ts` | 新增 `detectCrossSessionPatterns` + `suppressStalePatterns` + `shouldRunREM` |
| `src/agent/playbook-store.ts` | 新增 `fingerprintTableName` 参数（可选），与 SessionRegistry 协作 |
| `src/agent/hooks/playbook-reflect-hook.ts` | 扩展 deps 以包含 SessionRegistry，集成 REM 流程 |
| `src/agent/session-registry.ts` | 新增 `storeFingerprint` / `loadFingerprints` 方法 |
| `src/agent/__tests__/playbook.test.ts` | 覆盖 detectCrossSessionPatterns / suppressStalePatterns / shouldRunREM |
| `src/agent/__tests__/session-registry.test.ts` | 覆盖指纹存储和查询 |

### 4.3 不变的文件

- `retrospect.ts`：报告生成逻辑不变
- `dream.ts`：dream distillation 职责独立，不受影响
- `cross-session-hook.ts`：事件路由不变
- `playbook-store.ts` 的 load/save 接口不变

---

## 5. 测试策略

### 5.1 单元测试

| 测试 | 覆盖 |
|------|------|
| `buildRetrospectFingerprint` | 从 retrospect 报告中正确提取关键词和趋势 |
| `fingerprintSimilarity` | 相似度计算正确（重叠度阈值、边界条件） |
| `detectCrossSessionPatterns` | 2+ session 匹配时生成 pattern bullet；无匹配时不生成 |
| `detectCrossSessionPatterns` | 已有 pattern bullet 时强化而非重复创建 |
| `suppressStalePatterns` | 3+ session 未重现时标记 suppressed |
| `suppressStalePatterns` | suppressed bullet 再次匹配时恢复 |
| `shouldRunREM` | full / light / skip 三种路径的正确门控 |
| `storeFingerprint` / `loadFingerprints` | SQLite 正确存储和检索 |
| `deduplicateBullets` 与 pattern bullets | pattern bullet 与 NREM bullet 的去重正确 |

### 5.2 集成测试

- 构造 3 个 session 的 retrospect 指纹，验证第 3 个 session 触发 pattern 检测
- 验证 pattern bullet 通过 `matchBullets` 被正确匹配和注入

---

## 6. Prefix Cache 影响

**可控**。PatternBullet 通过现有的 `matchBullets` → prompt injection 路径注入。注入位置是 volatile context（dynamic appendix），不影响 static prefix。

需要注意的风险：
- PatternBullet 数量增长过快 → volatile appendix 膨胀 → 压缩频率增加
- 缓解：`enforceCapacity` 已限制 50 bullet 上限；`decayImportance` 已实现自然淘汰

---

## 7. 与其他系统的关系

### 7.1 与 NREM recall-gate 的关系

```
Session 运行中:
  context-injection.refreshActiveClaims()
    → promoteEligibleClaims(now, cwd)
      → canRecallClaim(claim, cwd)  // NREM: 检查证据可达性

Session 结束:
  playbook-reflect-hook
    → detectCrossSessionPatterns()  // REM: 跨 session 模式检测
    → suppressStalePatterns()       // REM: 抑制过滤
```

NREM 保证单个 claim 的证据可达性；REM 保证跨 session 知识的重复性和时效性。两者正交，互不依赖。

### 7.2 与 Dream Distillation 的关系

Dream（`dream.ts`）提取显式决策中的架构不变量，写入 `.rivet/knowledge/project-memory.md`。
Playbook-Reflect 提取 session 行为模式，写入 `.rivet/playbook.jsonl`。

两者互补：
- Dream = 显式知识（用户或 agent 明确说出的决策）
- Playbook-Reflect = 隐式知识（从行为模式中发现的规律）

REM 扩展不改变这个分工，只是增强了 Playbook-Reflect 的跨 session 能力。

### 7.3 与 Theta Phase Machine 的关系

Theta phase machine 调制 encoding/retrieval 周期，影响**运行时**行为。
REM 模式检测发生在 **postSession**，不受 theta 调制。

未来方向：theta 的 retrieval 阶段可以查询 pattern bullets，作为一致性检查的参考。

---

## 8. 实施优先级

| Phase | 内容 | 预估工作量 |
|-------|------|-----------|
| **P1** | `retrospect-fingerprint.ts` + 指纹存储到 SessionRegistry | 2h |
| **P2** | `detectCrossSessionPatterns` + 集成到 playbook-reflect-hook | 3h |
| **P3** | `suppressStalePatterns` + `shouldRunREM` 三级门控 | 2h |
| **P4** | 测试覆盖（单元 + 集成） | 2h |

总预估：~9h。可以拆分为 2-3 个独立 commit。

---

## 9. 开放问题

1. **指纹查询窗口**：`loadFingerprints(limit=10)` 的 limit 是否合适？大型项目可能有数百个 session，需要考虑性能。
2. **PatternBullet 的注入优先级**：pattern bullet 和 NREM bullet 混在同一个 store 中，matchBullets 不区分来源。是否需要给 pattern bullet 更高的 base importance？
3. **SessionRegistry 的生命周期**：SessionRegistry 使用 SQLite，需要确保 cleanupOldEvents 也清理 retrospect_fingerprints 表中的旧数据。
