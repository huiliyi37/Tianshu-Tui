/**
 * B1 worker 归属回流（T1-T3）：worker changedFiles 写回主控 ledger 后，
 * autoOwnFromLedger 自动认领为 owned——修复 worker 写入不在主控 owned 集
 * （需 adopt 补交）的机制根因。
 *
 * 链路测试用真实 TaskLedger/OwnershipLedger/WorktreeBaseline（不 mock 中间层）；
 * 集成测试 mock coordinator（边界接口）验证 createDelegateTaskTool 接线。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger, type OwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createDelegateTaskTool, type DelegateTaskCoordinator } from '../../tools/delegate-task.js'
import type { CoordinatorRun } from '../coordinator.js'

/** 空 baseline：无 pre-existing dirty/untracked——新文件 registerOwned 进 ownedSet。 */
function makeEmptyBaseline() {
  return createWorktreeBaseline({
    head: '',
    preExistingDirty: [],
    preExistingUntracked: [],
    tracked: [],
    untracked: [],
  } as never)
}

function makeRun(changedFiles: string[]): CoordinatorRun {
  return {
    status: 'completed',
    selectedModel: 'deepseek-v4-pro',
    results: [{
      workOrderId: 'wo_backfill',
      status: 'passed',
      summary: 'Worker wrote files.',
      findings: [],
      artifacts: [],
      changedFiles,
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }],
    packet: '<worker_results>packet</worker_results>',
  }
}

/** backfill 回调（delegate-task 注入点语义）：写回 ledger + 立即 registerOwned。 */
function makeBackfill(taskLedger: ReturnType<typeof createTaskLedger>, ownership: OwnershipLedger) {
  return (files: string[]): void => {
    for (const f of files) {
      taskLedger.record({ type: 'file_write', path: f })
      ownership.registerOwned(f)
    }
  }
}

describe('worker 归属回流 — 链路（真实 ledger/ownership/baseline）', () => {
  it('写回 ledger 后 autoOwnFromLedger 认领为 owned（registerOwned 非必需）', () => {
    const taskLedger = createTaskLedger({ taskId: 't' })
    const ownership = createOwnershipLedger({ baseline: makeEmptyBaseline(), taskLedger })

    // 只写 ledger（模拟 backfill 只 record 的最小形态）
    for (const f of ['src/worker-new.ts', 'src/worker-edit.ts']) {
      taskLedger.record({ type: 'file_write', path: f })
    }
    ownership.autoOwnFromLedger()

    assert.ok(ownership.isOwned('src/worker-new.ts'), 'ledger file_write 必须被 autoOwnFromLedger 认领')
    assert.ok(ownership.isOwned('src/worker-edit.ts'))
    assert.ok(ownership.getOwnedFiles().includes('src/worker-new.ts'))
  })

  it('backfill（record + registerOwned）后即时 owned，无需 auto-own', () => {
    const taskLedger = createTaskLedger({ taskId: 't' })
    const ownership = createOwnershipLedger({ baseline: makeEmptyBaseline(), taskLedger })
    const backfill = makeBackfill(taskLedger, ownership)

    backfill(['src/worker-immediate.ts'])

    assert.ok(ownership.isOwned('src/worker-immediate.ts'), 'registerOwned 必须即时生效')
    assert.equal(taskLedger.getEvents().filter(e => e.type === 'file_write').length, 1)
  })
})

describe('worker 归属回流 — delegate_task 工具接线（mock coordinator）', () => {
  it('passed worker 的 changedFiles 经 backfill 写回 ledger + ownership', async () => {
    const taskLedger = createTaskLedger({ taskId: 't' })
    const ownership = createOwnershipLedger({ baseline: makeEmptyBaseline(), taskLedger })
    const backfill = makeBackfill(taskLedger, ownership)

    const coordinator: DelegateTaskCoordinator = {
      delegate: async () => makeRun(['src/worker-file-a.ts', 'src/worker-file-b.ts']),
    }
    const tool = createDelegateTaskTool(coordinator, undefined, undefined, undefined, backfill)

    await tool.execute({
      toolUseId: 'tu_backfill',
      cwd: '/repo',
      input: { objective: 'write worker files' },
    } as never)

    assert.ok(ownership.isOwned('src/worker-file-a.ts'), 'delegate_task 完成后 changedFiles 必须进 owned')
    assert.ok(ownership.isOwned('src/worker-file-b.ts'))
    const writes = taskLedger.getEvents().filter(e => e.type === 'file_write')
    assert.equal(writes.length, 2)
    assert.ok(writes.every(e => e.path?.startsWith('src/worker-file-')), 'ledger 必须记录 worker 写入路径')
  })

  it('failed/blocked worker 的 changedFiles 不写回（只认 passed）', async () => {
    const taskLedger = createTaskLedger({ taskId: 't' })
    const ownership = createOwnershipLedger({ baseline: makeEmptyBaseline(), taskLedger })
    const backfill = makeBackfill(taskLedger, ownership)

    const coordinator: DelegateTaskCoordinator = {
      delegate: async () => ({
        status: 'completed',
        selectedModel: 'deepseek-v4-pro',
        results: [{
          workOrderId: 'wo_failed',
          status: 'failed',
          summary: 'Worker failed.',
          findings: [],
          artifacts: [],
          changedFiles: ['src/worker-partial.ts'],
          risks: [],
          nextActions: [],
          failureReason: 'timeout',
          evidenceStatus: 'unverified',
        }],
        packet: '<worker_results>packet</worker_results>',
      }),
    }
    const tool = createDelegateTaskTool(coordinator, undefined, undefined, undefined, backfill)

    await tool.execute({
      toolUseId: 'tu_backfill_failed',
      cwd: '/repo',
      input: { objective: 'write worker files' },
    } as never)

    assert.equal(ownership.getOwnedFiles().length, 0, 'failed worker 的文件不得进入 owned')
    assert.equal(taskLedger.getEvents().filter(e => e.type === 'file_write').length, 0)
  })

  it('backfill 未注入时行为不变（向后兼容）', async () => {
    const coordinator: DelegateTaskCoordinator = {
      delegate: async () => makeRun(['src/worker-file.ts']),
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_no_backfill',
      cwd: '/repo',
      input: { objective: 'write worker files' },
    } as never)

    assert.equal(result.isError, false, '无 backfill 时工具必须正常返回')
  })
})
