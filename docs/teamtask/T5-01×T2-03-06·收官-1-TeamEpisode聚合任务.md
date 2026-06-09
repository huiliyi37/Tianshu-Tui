# T5×T2-03 收官-1 任务 · TeamEpisode 聚合还债

> 日期：2026-06-08  
> 性质：T5 收官前置任务包  
> 前置：P0 TeamWaveTelemetry、P1 Reward Loop、P4-a Gated Team Scheduler Bandit。  
> 目标：把跨 `fromWave` 的多个 wave fragment 聚合成一次完整 TeamEpisode，让 reward / bandit / 后续 gated influence 使用正确的 episode 级样本，而不是把一个任务的多阶段执行误当成多个独立样本。

---

## 0. 一句话

**收官-1 不是新增一个学习器；收官-1 是修正 Team 模式 reward 的采样单位：从 wave fragment 升到 TeamEpisode。**

这笔债来自 P1：当前 `TeamWaveTelemetry` 已记录 `objectiveHash`、`sessionId`、`fromWave`、`waveId`、`waveCount`，但 reward closure 仍以单个 `team_wave` 为 source。多 wave 任务通过 `fromWave` 分段执行时，一个真实任务会被拆成多个 reward 样本，后续 gated 启用会放大这个统计偏差。

---

## 1. 前置闸

收官-1 开始前必须确认：

1. `src/agent/team-wave-telemetry.ts` 已稳定记录：
   - `sessionId`
   - `objectiveHash`
   - `mode`
   - `fromWave`
   - `waveId`
   - `waveCount`
   - `planned.files`
   - `changedFiles.reportedChangedFiles / observedChangedFiles`
2. `src/agent/reward-loop.ts` 当前存在 `buildRewardClosureRecordFromTeamWave()`，且 sourceKind 只有 `routing_shadow | team_wave`。
3. `src/agent/team-reward.ts` 当前 reward 输入以单 wave telemetry 推导。
4. P4-a 的 scheduler gate 已落地，后续 gated influence 会消费 reward 历史；因此本任务必须在 model/tier 真 gated 前完成。

缺任一项时，本任务只允许新增纯聚合工具和测试，不允许替换 reward closure 写入路径。

---

## 2. 范围

### 做

1. 新建 `team-episode.ts`
   - 定义 `TeamEpisode` 与 `TeamEpisodeFragment`。
   - 按 `(sessionId, objectiveHash, mode)` 聚合 wave fragments。
   - 按 `fromWave` 排序，不按到达顺序猜。
   - 检测缺失 wave、重复 wave、waveCount 不一致、objective/session 混入。

2. 新增 episode reward 派生
   - 第一版不重写 P1 reward 公式。
   - 复用 `deriveTeamWaveRewardInput()` 的组件语义，做 episode 级聚合：
     - verification/review：按最保守语义聚合，任一失败即 episode 失败；缺失不猜。
     - falseGreen：任一 fragment false-green 即 episode false-green。
     - scopeLeak/conflict/rework：按 dispatched/status/files 加权或上界聚合，不能简单平均掩盖事故。

3. 扩展 reward closure 支持 `team_episode`
   - `RewardSourceKind` 增加 `'team_episode'`。
   - 新增 `buildRewardClosureRecordFromTeamEpisode()`。
   - 新增 `teamEpisodeKind()`，sourceKey 必须稳定、可追溯到 session/objective。
   - 保留 `team_wave` closure，不破坏历史消费者。

4. 新增 episode 聚合存储辅助
   - 可复用 `saveBanditState(kind,json)`，不新增 DDL。
   - 第一版 append-only 保存 `team_episode:*` 与 `reward_closure:team_episode:*`。
   - 不需要做跨进程锁；只提供纯函数 + store helper。

5. 补测试
   - 单 wave episode 与原 team_wave reward 等价或语义一致。
   - 多 wave 按 `fromWave` stitch。
   - 缺失 wave 不产出 complete episode reward，只产出 incomplete episode 或拒绝 closure。
   - 重复 `fromWave` 不静默覆盖。
   - false-green 任一 fragment 命中时 episode 保持负向信号。
   - scope leak 用 observed diff 优先，reported 次之，unknown 不猜。

### 不做

- 不启用 model 路由 / tier 真切换。
- 不修改 P4-a scheduler 的 gate 阈值。
- 不删除现有 `team_wave` reward closure。
- 不新增 MeridianDb schema / DDL。
- 不把 incomplete episode 当正 reward。
- 不用 `detectAnomaly()` 作为 scope-health 信号；scope-health 是 P4-b，另开任务。
- 不接 physarum 监督边；P4-c 需等 T2-01 direction / pollution 复核完成。

---

## 3. 数据结构

建议第一版：

```ts
export interface TeamEpisodeFragment {
  sourceKey: string
  telemetry: TeamWaveTelemetry
}

export interface TeamEpisode {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  mode: 'standard' | 'max'
  episodeKey: string
  complete: boolean
  waveCount: number
  observedWaveIndexes: number[]
  missingWaveIndexes: number[]
  duplicateWaveIndexes: number[]
  fragments: TeamEpisodeFragment[]
  planned: {
    taskIds: string[]
    files: string[]
    profiles: string[]
    authorities: string[]
    maxRisk: 'low' | 'medium' | 'high'
  }
  outcome: {
    dispatched: number
    statuses: Array<{ workOrderId: string; status: string; evidenceStatus: string }>
    verificationPassed?: boolean
    reviewVerdict?: string
  }
  changedFiles: {
    reportedChangedFiles?: string[]
    observedChangedFiles?: string[]
    changedFilesSource: 'diff_artifact' | 'worker_result' | 'unknown' | 'mixed'
  }
  timestamp: number
}
```

`episodeKey` 建议：

```text
team_episode:${objectiveHash}:${sessionId}:${mode}:${waveCount}
```

注意：`fromWave` 不是 episode identity，它只是 fragment index。

---

## 4. 聚合规则

### 4.1 分组

同一 episode 的必要条件：

```text
sessionId 相同
objectiveHash 相同
mode 相同
waveCount 相同或可判为同一计划版本
```

若 `waveCount` 不一致：

- 不合并为 complete episode。
- 记录 mismatch reason。
- 不生成 episode reward closure。

### 4.2 排序

按 `fromWave` 数值升序排序。

禁止按 timestamp 排序决定语义；timestamp 只能用于审计。

### 4.3 complete 判定

```ts
complete =
  duplicateWaveIndexes.length === 0 &&
  missingWaveIndexes.length === 0 &&
  observedWaveIndexes.length === waveCount
```

只有 `complete=true` 才允许写 `reward_closure:team_episode:*`。

### 4.4 reward 聚合

第一版保守规则：

| 组件 | episode 规则 |
|---|---|
| verificationPass | 任一 fragment 明确 false → false；全部 true → true；否则 undefined |
| reviewPass | 任一 fragment 明确 fail → false；全部 pass → true；否则 undefined |
| falseGreen | 任一 fragment true → true |
| normalizedConflict | 用 blocked/escalated 总数 ÷ dispatched/status denominator |
| normalizedRework | 用 failed/evidence failed 总数 ÷ denominator |
| normalizedScopeLeak | 用 episode planned files vs episode changed files 重新计算 |
| cost/latency | 仍为 0，不猜 |

这样保持 P1 权重不变，只修正采样边界。

---

## 5. 文件计划

### 5.1 新增 `src/agent/team-episode.ts`

职责：纯函数，无副作用。

建议导出：

```ts
export function teamEpisodeKey(input: Pick<TeamEpisode, 'objectiveHash' | 'sessionId' | 'mode' | 'waveCount'>): string

export function buildTeamEpisode(fragments: TeamWaveTelemetry[], options?: { timestamp?: number }): TeamEpisode

export function deriveTeamEpisodeRewardInput(episode: TeamEpisode): TeamWaveRewardInput | null

export function persistTeamEpisode(store: TeamEpisodeStore | undefined | null, episode: TeamEpisode): void
```

`deriveTeamEpisodeRewardInput()` 对 incomplete episode 返回 `null`，不抛错、不猜 reward。

### 5.2 修改 `src/agent/reward-loop.ts`

改动点：

```ts
export type RewardSourceKind = 'routing_shadow' | 'team_wave' | 'team_episode'
```

新增：

```ts
export function buildRewardClosureRecordFromTeamEpisode(
  episode: TeamEpisode,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord | null

export function recordTeamEpisodeRewardClosure(
  store: RewardClosureStore | undefined | null,
  episode: TeamEpisode,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord | null
```

`null` 表示 episode incomplete 或无法推导 reward，调用方不得保存 closure。

### 5.3 测试

新增：

- `src/agent/__tests__/team-episode.test.ts`

修改：

- `src/agent/__tests__/reward-loop.test.ts`

---

## 6. 验收标准

必须满足：

1. 单 wave：`TeamEpisode` 能 complete，reward closure sourceKind 为 `team_episode`。
2. 多 wave：`fromWave=1` 先到、`fromWave=0` 后到，仍按 0→1 stitch。
3. 缺 wave：不写 episode reward closure。
4. 重复 wave：不写 episode reward closure。
5. 任一 fragment false-green：episode reward 仍被 false-green 权重压低。
6. observed diff 优先于 reported changed files。
7. 现有 `team_wave` reward 测试不退化。

---

## 7. 验证命令

```bash
npm exec -- tsx --test src/agent/__tests__/team-episode.test.ts
npm exec -- tsx --test src/agent/__tests__/reward-loop.test.ts
npm exec -- tsx --test src/agent/__tests__/team-reward.test.ts
npx tsc --noEmit
```

若触碰 team orchestrator，再加：

```bash
npm exec -- tsx --test src/agent/__tests__/team-orchestrator.test.ts
```

---

## 8. 天权称量

收官-1 是 T5 gated 真启用前的硬前置，原因不是“功能缺失”，而是“统计单位错位”：

- P4-a 已经让 reward 能影响 team scheduler，但目前只在 down-only、flag 默认关的极小范围内安全试水。
- 收官-2 要让 model / tier 从 shadow 走向 gated，影响面比 P4-a 更大。
- 如果不先把 wave fragment stitch 成 episode，bandit 会把一个任务的阶段性片段当成多个独立样本，样本数、false-green rate、scope leak rate、reward margin 都会被污染。

因此，本任务优先级高于 P4-d / 收官-2；它不改变行为，只修正证据底座。完成后，再谈 shadow→gated 才有称量基础。
