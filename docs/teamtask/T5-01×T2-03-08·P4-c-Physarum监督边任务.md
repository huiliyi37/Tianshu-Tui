# T5×T2-03 P4-c 任务 · Team → Physarum 监督边

> 日期：2026-06-08  
> 性质：P4 后续任务包  
> 前置：P4-b TeamScopeHealth、收官-1 TeamEpisode 聚合、T2-01 physarum 文件访问线。  
> 目标：把 team 已完成、已集成、scope 健康的执行事实，转成 physarum 文件图的监督信号；让 team 成为文件协同世界模型的高质量训练场。

---

## 0. 一句话

**P4-c 不是把计划依赖直接写进 physarum；P4-c 是只把成功闭环后的实际变更事实写成监督边。**

team 的计划图是高质量意图，但 physarum 学的是 repo 世界里的文件转移。监督边只能来自：

```text
已完成 worker + 已集成 diff + actual changed files + 跨 wave / 显式 dependsOn
```

同 wave 并行任务没有可靠时序，不写 A→B 方向；失败、blocked、未集成、scope leak 高风险的片段不写学习边。

---

## 1. 前置闸

P4-c 开始前必须确认：

1. `src/repo/physarum-engine.ts` 的方向语义已正确：
   - `recordFileAccess('src/b.ts', 1)` → `recordFileAccess('src/a.ts', 2)` 能让 `predictNext('src/b.ts')` 推荐 `src/a.ts`。
   - 已有测试覆盖 reverse lexicographic direction。
2. polluted persisted edges 已过滤：
   - `isIndexablePhysarumFile()` 只允许 repo 相对源码文件；
   - `loadFromDb()` 丢弃 `read_file` 等工具名污染边；
   - `cleanupPersistedEdges()` 可清理持久化污染。
3. `TeamEpisode` 已能聚合跨 `fromWave` fragments。
4. `TeamScopeHealth` 已能用 observed diff 检出 scope leak。
5. 本任务不得绕过 `recordFlow()` 建边要求；方向更新必须遵守 physarum 引擎当前安全序列。

缺任一项时，P4-c 只能写纯函数 shadow 事件，不允许调用 physarum engine。

---

## 2. 范围

### 做

1. 新建 `src/agent/team-physarum-supervision.ts`
   - 从 `TeamEpisode` 构造监督候选边。
   - 只使用 `episode.changedFiles.observedChangedFiles` 优先；没有 observed 才可用 reported，且 reason 标注降级。
   - 按 wave / task 关系生成：
     - 跨 wave：前一 wave actual files → 后一 wave actual files。
     - 显式 dependsOn：前置 task actual files → 后继 task actual files。
   - 同 wave 并行任务只可记录 co-occurrence shadow，不写方向。

2. 定义 `TeamPhysarumSupervisionEvent`
   - append-only telemetry。
   - 记录 source episode、候选边、skipped reason、scope health、applied 与否。

3. 新增应用函数
   - `buildTeamPhysarumSupervision(episode, options)`：纯函数，默认 shadow。
   - `applyTeamPhysarumSupervision(engine, event)`：只有事件安全且 `apply=true` 时调用 physarum。
   - 写入顺序必须是：
     1. `recordFlow(fileA,fileB,turn)`
     2. `recordSequentialEdit(fileA,fileB,dtTurns)`
   - 不直接改 edge.direction。

4. 安全过滤
   - 失败 / blocked / evidence failed 的 fragment 不产边。
   - episode incomplete 不产边。
   - `TeamScopeHealth.severity === 'high'` 不产边。
   - actual files 为空不产边。
   - 非 indexable 文件不产边。
   - 同一 wave 内不产 directional edge。

5. 持久化
   - 复用 `saveBanditState(kind,json)`。
   - kind 形如：
     `team_physarum_supervision:${objectiveHash}:${sessionId}:${timestamp}:${hash}`。
   - append-only，不覆盖同一 episode 的二次复核。

6. 补测试
   - 跨 wave 成功 episode 产生方向边。
   - 同 wave 并行任务不产生方向边。
   - failed / blocked fragment 不产边。
   - high scope leak 不产边。
   - 非 indexable 文件不产边。
   - apply 时确实 `recordFlow` 先于 `recordSequentialEdit`。

### 不做

- 不使用计划 `task.files` 代替实际 diff。
- 不把 failed / blocked / 未集成 wave 写入 physarum。
- 不调用 `detectAnomaly()` 作为监督边依据。
- 不让 physarum 反过来影响 team scheduler。
- 不写新 DB schema。
- 不接 P4-d model-tier bandit。

---

## 3. 数据结构

建议第一版：

```ts
export interface TeamPhysarumSupervisionEdge {
  fromFile: string
  toFile: string
  relation: 'cross_wave' | 'explicit_dependency'
  fromWaveId: string
  toWaveId: string
  sourceTaskIds: string[]
  targetTaskIds: string[]
  dtTurns: number
}

export interface TeamPhysarumSupervisionEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  episodeKey: string
  applied: boolean
  safeToApply: boolean
  edges: TeamPhysarumSupervisionEdge[]
  skipped: Array<{ reason: string; detail: string }>
  scopeSeverity: 'healthy' | 'low' | 'medium' | 'high'
  timestamp: number
}
```

---

## 4. 监督边规则

### 4.1 使用执行事实

actual files 选择与 P4-b 保持一致：

```ts
actualFiles = observedChangedFiles.length > 0
  ? observedChangedFiles
  : reportedChangedFiles
```

但 P4-c 比 P4-b 更保守：如果只有 reported，事件 `safeToApply` 可以为 true，但必须在 reason 中标明 `reported_files_fallback`；若 scope health 不是 healthy/low，默认 shadow-only。

### 4.2 跨 wave 有方向

```text
wave0 actual files → wave1 actual files
wave1 actual files → wave2 actual files
```

这是 team checkpoint 的真实执行顺序，允许写方向。

### 4.3 explicit dependency 有方向

只有当：

```text
taskB.dependsOn includes taskA
且 taskA/taskB 都完成并集成
且二者 actual files 非空
```

才写：

```text
taskA actual files → taskB actual files
```

### 4.4 同 wave 并行无方向

同一 wave 的多个 task 同时执行，不能构造 A→B。第一版只记录 skipped reason：`parallel_wave_no_order`。后续若要做共现边，需 physarum 支持无向/co-occurrence 语义，不在本任务。

---

## 5. 文件计划

### 5.1 新增 `src/agent/team-physarum-supervision.ts`

建议导出：

```ts
export function buildTeamPhysarumSupervision(
  episode: TeamEpisode,
  options?: { timestamp?: number; apply?: boolean },
): TeamPhysarumSupervisionEvent

export function applyTeamPhysarumSupervision(
  engine: Pick<PhysarumEngine, 'recordFlow' | 'recordSequentialEdit'>,
  event: TeamPhysarumSupervisionEvent,
  startTurn?: number,
): void

export function teamPhysarumSupervisionPersistKind(event: TeamPhysarumSupervisionEvent): string

export function persistTeamPhysarumSupervision(store: Store | undefined | null, event: TeamPhysarumSupervisionEvent): void
```

### 5.2 测试

新增：

- `src/agent/__tests__/team-physarum-supervision.test.ts`

可选扩展：

- `src/repo/__tests__/physarum-engine.test.ts`：只在发现 engine 缺接口时补，不改核心方程。

---

## 6. 验收标准

必须满足：

1. complete + healthy 的两 wave episode 生成 `cross_wave` edges。
2. edge apply 后，`predictNext(fromFile)` 能推荐 `toFile`。
3. 同 wave 并行 task 不生成 directional edge。
4. 前置 task failed/blocked 时不生成依赖边。
5. high scope leak episode 不生成 applyable edge。
6. 非 indexable 文件被过滤。
7. 持久化 key append-only。
8. `recordFlow` 调用发生在 `recordSequentialEdit` 之前。

---

## 7. 验证命令

```bash
npm exec -- tsx --test src/agent/__tests__/team-physarum-supervision.test.ts
npm exec -- tsx --test src/agent/__tests__/team-scope-health.test.ts
npm exec -- tsx --test src/agent/__tests__/team-episode.test.ts
npm exec -- tsx --test src/repo/__tests__/physarum-engine.test.ts
npx tsc --noEmit
```

---

## 8. 天权称量

P4-c 可以在 P4-b 后做，但必须保持 **shadow-first / fact-only**：

- 它的价值是把 team 的高质量执行序列喂给世界模型；
- 它的风险是把计划意图、失败执行、scope leak 污染写进 physarum；
- 因此本任务的核心不是“多写边”，而是“宁可少写，也只写真边”。

完成 P4-c 后，T5/T2 主线就拥有：team episode、scope health、scheduler gated、physarum supervised learning 四块地基。再往后才适合进入 P4-d model-tier-bandit 或收官-2 shadow→gated 真启用。