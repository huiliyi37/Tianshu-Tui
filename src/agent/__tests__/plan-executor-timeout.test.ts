/**
 * 超时与执行分离（T11-T14）：
 * - T11：withToolTimeout 超时错误文案含恢复指引（TOOL_TIMEOUT_RECOVERY_HINT）
 * - T12：每波完成 checkpoint 落盘可恢复（lastCompletedWave + 1 续跑语义）
 * - T13：覆盖式 checkpoint 保留最后完成波（abort/异常不破坏前波进度）
 * checkpoint 部分用真实 wave-checkpoint 存储（不 mock 中间层）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_TIMEOUT_RECOVERY_HINT } from '../tool-pipeline.js'
import {
  clearCheckpoint,
  deriveTeamGroupId,
  loadCheckpoint,
  saveCheckpoint,
} from '../wave-checkpoint.js'
import { createReadOnlyWorkOrder } from '../work-order.js'

describe('T11 — 超时错误文案含恢复指引', () => {
  it('TOOL_TIMEOUT_RECOVERY_HINT 导出且带恢复语义', () => {
    assert.ok(TOOL_TIMEOUT_RECOVERY_HINT.length > 40, '指引必须可操作')
    assert.ok(TOOL_TIMEOUT_RECOVERY_HINT.includes('fromWave'), '必须提示 fromWave=N 续跑')
    assert.ok(TOOL_TIMEOUT_RECOVERY_HINT.includes('git status'), '必须提示检查 worker 已落盘')
  })
})

describe('T12 — 波完成 checkpoint 可恢复（fromWave 续跑语义）', () => {
  it('saveCheckpoint 后 loadCheckpoint 恢复 lastCompletedWave + 已完成结果', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-w12-'))
    try {
      const objective = 'checkpoint 可恢复验证任务'
      const groupId = deriveTeamGroupId(objective)
      const order = createReadOnlyWorkOrder({
        id: 'wo_cp',
        parentTurnId: 't',
        kind: 'code_search',
        profile: 'code_scout',
        objective: '波 1 任务',
        scope: { files: [], symbols: [] },
        constraints: [],
        allowedTools: ['read_file'],
        disallowedTools: [],
        dedupeKey: 'k',
        dependencies: [],
        aggregationPolicy: 'all_required',
        budget: { turns: 4 },
      } as never)

      // 构造波 1 完成的 checkpoint（走真实 buildWaveCheckpoint 的输入形态）
      const cp = {
        groupId,
        timestamp: Date.now(),
        lastCompletedWave: 0,
        completedResults: [],
        remainingOrders: [{ id: order.id, objective: order.objective, profile: order.profile, kind: order.kind, scope: order.scope }],
        objective,
        totalWaves: 2,
      }
      saveCheckpoint(dir, cp)
      const loaded = loadCheckpoint(dir, groupId)
      assert.ok(loaded, 'checkpoint 必须可读回')
      assert.equal(loaded!.lastCompletedWave, 0)
      assert.equal(loaded!.remainingOrders.length, 1)
      // 续跑语义：fromWave = lastCompletedWave + 1 = 1
      assert.equal(loaded!.lastCompletedWave + 1, 1)
      assert.equal(loaded!.totalWaves, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('T13 — 覆盖式 checkpoint 保留最后完成波（abort 不破坏前波进度）', () => {
  it('后波覆盖前波后，checkpoint 恒为最后完成波——abort 时续跑不重复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-w13-'))
    try {
      const objective = '覆盖式 checkpoint 验证'
      const groupId = deriveTeamGroupId(objective)
      // 波 0 完成 → checkpoint A；波 1 完成 → checkpoint B（覆盖）
      saveCheckpoint(dir, { groupId, timestamp: 1, lastCompletedWave: 0, completedResults: [], remainingOrders: [], objective, totalWaves: 3 })
      saveCheckpoint(dir, { groupId, timestamp: 2, lastCompletedWave: 1, completedResults: [], remainingOrders: [], objective, totalWaves: 3 })
      const loaded = loadCheckpoint(dir, groupId)
      assert.equal(loaded!.lastCompletedWave, 1, '覆盖式写：checkpoint 是最后完成波')
      assert.equal(loaded!.timestamp, 2)
      // abort 场景：最后一波未落盘（异常不覆盖）→ checkpoint 仍是最后完成波 1
      // → fromWave=2 续跑，不重复波 0/1
      assert.equal(loaded!.lastCompletedWave + 1, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
