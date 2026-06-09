# T5×T2-03 P4-b 任务 · Team Scope Health 与 False-Green 第二信号

> 日期：2026-06-08  
> 性质：P4 收官前置任务包  
> 前置：P0 TeamWaveTelemetry、P1 Reward Loop、P4-a Gated Team Scheduler Bandit、收官-1 TeamEpisode 聚合。  
> 目标：把 team 执行的 planned vs observed 文件差异提升为一等健康信号，为 false-green、scope leak、scheduler reward、后续 gated influence 提供结构化证据。

---

## 0. 一句话

**P4-b 不是做 physarum 异常检测；P4-b 是把“计划范围 vs 实际变更”的结构化对比做成 TeamScopeHealth，作为 false-green 的第二信号。**

当前已有事实地基：

- `TeamWaveTelemetry` 已记录 `planned.files` 与 `changedFiles.reportedChangedFiles / observedChangedFiles`。
- `TeamEpisode` 已能跨 `fromWave` 聚合 fragments，并优先用 observed diff 重新计算 scope leak。
- `team-reward.ts` 已把 scope leak 纳入 reward。
- `team-orchestrator.ts` 的 scheduler context 里仍有 `scopeLeakRate: 0`，说明调度学习还没真正吃到 scope health。

本任务补的是“健康信号本体”，不是让它立刻扩大行为影响。

---

## 1. 前置闸

P4-b 开始前必须具备：

1. `src/agent/team-wave-telemetry.ts` 能提供 planned files 与 changed files。
2. `src/agent/team-episode.ts` 已能聚合 episode，并区分 complete / incomplete。
3. `src/agent/team-scheduler-bandit.ts` 的 context 已预留 `scopeLeakRate`。
4. P4-a gate 保持默认 flag 关闭、down-only、安全规则优先。

缺任一项时，P4-b 只做纯函数与测试，不接 scheduler context。

---

## 2. 范围

### 做

1. 新建 `src/agent/team-scope-health.ts`
   - 输入 `TeamWaveTelemetry | TeamEpisode`。
   - 输出 `TeamScopeHealth`。
   - 优先使用 `observedChangedFiles`；没有 observed 时才使用 `reportedChangedFiles`；两者都没有时标记 `changedFilesSource:'unknown'`，不猜。

2. 定义健康指标
   - `leakedFiles = actual - planned`
   - `coveredFiles = actual ∩ planned`
   - `missingFiles = planned - actual`（只提示，不默认失败）
   - `scopeLeakRate = leakedFiles.length / actualFiles.length`
   - `coverageRate = coveredFiles.length / plannedFiles.length`
   - `severity = healthy | low | medium | high`

3. severity 规则第一版保守实现
   - 无 actual files：`healthy`，但 reason 标明 `no_actual_files_observed`。
   - 有 actual、无 planned：`high`。
   - 有 leaked files：至少 `medium`。
   - leaked files 触及高风险路径（配置、schema、lockfile、package、migration、prompt、security）升 `high`。
   - 只 missing、不 leaked：最多 `low`，不当 false-green。

4. 接入 reward / scheduler 的安全消费点
   - `team-reward.ts` 可复用 `TeamScopeHealth.scopeLeakRate`，避免重复散落计算。
   - `team-orchestrator.ts` 的 scheduler context 可从历史/当前 telemetry 注入 `scopeLeakRate`；若没有事实，仍为 0，不猜。
   - 不改变 `groupTeamTasks()` 的 hard gate。

5. 持久化 shadow 事件
   - 可选 `persistTeamScopeHealth(store,event)`，复用 `saveBanditState(kind,json)`。
   - kind 形如：`team_scope_health:${objectiveHash}:${sessionId}:${scopeKind}:${timestamp}:${hash}`。
   - append-only，不覆盖同一 episode 的多次复核。

6. 补测试
   - observed 优先于 reported。
   - worker 自报空但 observed diff 有泄漏时能检出。
   - planned 为空但 actual 非空为 high。
   - missing-only 不算泄漏。
   - 高风险 leaked file 升 high。
   - episode 多 wave 聚合后按全局 planned/actual 计算。

### 不做

- 不用 `physarum.detectAnomaly()` 当主信号。
- 不接 P4-c physarum 监督边。
- 不扩大 team scheduler 并行度。
- 不启用 model/tier gated 真切换。
- 不把 missingFiles 当失败；缺文件可能是任务无需修改或 worker 只读验证。
- 不信 worker 自报覆盖 actual diff；observed diff 永远优先。

---

## 3. 数据结构

建议第一版：

```ts
export type TeamScopeHealthSourceKind = 'team_wave' | 'team_episode'
export type TeamScopeHealthSeverity = 'healthy' | 'low' | 'medium' | 'high'

export interface TeamScopeHealth {
  schemaVersion: 1
  sourceKind: TeamScopeHealthSourceKind
  sourceKey: string
  sessionId: string
  objectiveHash: string
  plannedFiles: string[]
  actualFiles: string[]
  coveredFiles: string[]
  leakedFiles: string[]
  missingFiles: string[]
  changedFilesSource: 'diff_artifact' | 'worker_result' | 'unknown' | 'mixed'
  scopeLeakRate: number
  coverageRate: number
  severity: TeamScopeHealthSeverity
  reasons: string[]
  timestamp: number
}
```

---

## 4. 核心规则

### 4.1 actual files 选择

```ts
actualFiles = observedChangedFiles.length > 0
  ? observedChangedFiles
  : reportedChangedFiles.length > 0
    ? reportedChangedFiles
    : []
```

这条是 P4-b 的主梁：**worker 自报不能压过实际 diff。**

### 4.2 scope leak

```ts
leakedFiles = actualFiles.filter(file => !plannedSet.has(file))
scopeLeakRate = actualFiles.length === 0 ? 0 : leakedFiles.length / actualFiles.length
```

planned 为空但 actual 非空时，`scopeLeakRate=1`。

### 4.3 severity

建议第一版：

```ts
if (actualFiles.length === 0) severity = 'healthy'
else if (plannedFiles.length === 0) severity = 'high'
else if (leakedFiles.some(isHighRiskPath)) severity = 'high'
else if (leakedFiles.length > 0) severity = 'medium'
else if (missingFiles.length > 0) severity = 'low'
else severity = 'healthy'
```

高风险路径建议：

```ts
/(^|\/)(package-lock\.json|package\.json|tsconfig\.json|\.env|schema|migration|prompt|security|auth|config)(\/|$)/
```

实现时不要只靠字符串哨兵；把规则封装为 `isHighRiskScopePath(file:string): boolean`，测试覆盖路径段和文件名。

---

## 5. 文件计划

### 5.1 新增 `src/agent/team-scope-health.ts`

建议导出：

```ts
export function buildTeamWaveScopeHealth(event: TeamWaveTelemetry, options?: { timestamp?: number }): TeamScopeHealth

export function buildTeamEpisodeScopeHealth(episode: TeamEpisode, options?: { timestamp?: number }): TeamScopeHealth

export function teamScopeHealthPersistKind(event: TeamScopeHealth): string

export function persistTeamScopeHealth(store: TeamScopeHealthStore | undefined | null, event: TeamScopeHealth): void
```

### 5.2 修改 `src/agent/team-reward.ts`

把内部散落的 `normalizeScopeLeak(event)` 收敛到 `buildTeamWaveScopeHealth(event).scopeLeakRate`。

保持对外 reward 语义不变，现有测试应继续通过。

### 5.3 修改 `src/agent/team-episode.ts`

`deriveTeamEpisodeRewardInput()` 可用 `buildTeamEpisodeScopeHealth(episode).scopeLeakRate`，避免 episode 与 wave 两套 scope leak 规则漂移。

### 5.4 可选修改 `src/agent/team-orchestrator.ts`

如果当前执行点能拿到上一轮/当前 health，才把 `scopeLeakRate` 填入 scheduler context。拿不到就保持 `0`，不要从计划文本猜。

### 5.5 测试

新增：

- `src/agent/__tests__/team-scope-health.test.ts`

修改：

- `src/agent/__tests__/team-reward.test.ts`
- `src/agent/__tests__/team-episode.test.ts`
- 如接 scheduler context，再改 `src/agent/__tests__/team-orchestrator.test.ts`

---

## 6. 验收标准

必须满足：

1. worker self-report 空，但 observed diff 有计划外文件 → `leakedFiles` 非空，severity 至少 medium。
2. observed 与 reported 冲突时，observed 优先。
3. planned files 为空、actual 非空 → severity high，scopeLeakRate=1。
4. missing-only → severity low，不产生 false-green。
5. 高风险 leaked path → severity high。
6. `deriveTeamWaveRewardInput()` 与 `deriveTeamEpisodeRewardInput()` 使用同一 scope health 语义。
7. 持久化 kind append-only，不覆盖同一 source 的二次复核。

---

## 7. 验证命令

```bash
npm exec -- tsx --test src/agent/__tests__/team-scope-health.test.ts
npm exec -- tsx --test src/agent/__tests__/team-reward.test.ts
npm exec -- tsx --test src/agent/__tests__/team-episode.test.ts
npx tsc --noEmit
```

如果接入 scheduler context，再加：

```bash
npm exec -- tsx --test src/agent/__tests__/team-orchestrator.test.ts src/agent/__tests__/team-scheduler-bandit.test.ts
```

---

## 8. 天权称量

P4-b 的优先级高于 P4-c / P4-d：

- P4-c physarum 监督边依赖“执行事实”干净，否则会把 scope leak 写进世界模型。
- P4-d model-tier-bandit 与收官-2 gated 真启用依赖 false-green / scope leak 作为否决信号。
- 当前 scheduler context 已预留 `scopeLeakRate`，但还没有事实源；P4-b 正好补这条证据链。

因此，下一个任务建议开 **P4-b TeamScopeHealth**：它不改变行为，却让后续所有 gated influence 有更可靠的安全证据。