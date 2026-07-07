import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeadEndDetectorHook } from '../dead-end-detector.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'
import type { PheromoneDeposit } from '../../../context/stigmergy.js'

function makeCtx(turn = 1): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function edit(file: string, success = true): RuntimeToolEvent {
  return {
    name: 'edit_file', success,
    input: { file_path: file }, target: file,
  } as unknown as RuntimeToolEvent
}

function verifyFail(failureClass?: string): RuntimeToolEvent {
  return {
    name: 'run_tests', success: false, isError: true, failureClass,
  } as unknown as RuntimeToolEvent
}

function verifyPass(): RuntimeToolEvent {
  return { name: 'run_tests', success: true } as unknown as RuntimeToolEvent
}

function bashVerifyFail(cmd: string): RuntimeToolEvent {
  return {
    name: 'bash', success: false, isError: true,
    input: { command: cmd }, target: cmd,
  } as unknown as RuntimeToolEvent
}

function harness() {
  const submitted: AdvisoryEntry[] = []
  const deposits: PheromoneDeposit[] = []
  const hook = createDeadEndDetectorHook({
    advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    deposit: async d => { deposits.push(d) },
  })
  return { submitted, deposits, hook }
}

describe('dead-end-detector 缺口 A', () => {
  it('同文件 2 次 edit→verify-fail 循环触发 advisory + stigmergy 沉积', async () => {
    const { submitted, deposits, hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    assert.equal(submitted.length, 0) // 1 循环不触发
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'dead-end-file')
    assert.equal(submitted[0]!.category, 'dead_end')
    assert.match(submitted[0]!.content, /src\/a\.ts/)
    assert.equal(deposits.length, 1)
    assert.equal(deposits[0]!.path, 'src/a.ts')
    assert.equal(deposits[0]!.signal, 'dead-end')
  })

  it('advisory 出生即带 tool_appears expect 谓词(因果账本)', async () => {
    const { submitted, hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    const expect = submitted[0]!.expect
    assert.ok(expect)
    assert.equal(expect.kind, 'tool_appears')
    if (expect.kind === 'tool_appears') {
      assert.ok(expect.tools.includes('read_file'))
      assert.ok(expect.tools.includes('grep'))
      assert.equal(expect.withinTurns, 2)
    }
  })

  it('中间 verify pass 清零——不构成死路', async () => {
    const { submitted, hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyPass()) // 通过 → 全清
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    assert.equal(submitted.length, 0)
    assert.equal(hook.getCycleCount('src/a.ts'), 1)
  })

  it('timeout / env_missing 类失败不计入循环', async () => {
    const { submitted, hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail('timeout'))
    await hook.run(makeCtx(), verifyFail('env_missing'))
    assert.equal(hook.getCycleCount('src/a.ts'), 0)
    // 语义失败仍然计
    await hook.run(makeCtx(), verifyFail('assertion'))
    assert.equal(hook.getCycleCount('src/a.ts'), 1)
    assert.equal(submitted.length, 0)
  })

  it('一次验证失败对同文件只记一次循环(editPending 消费制)', async () => {
    const { hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    await hook.run(makeCtx(), verifyFail()) // 无新 edit,不再计
    assert.equal(hook.getCycleCount('src/a.ts'), 1)
  })

  it('触发一次性——同文件继续循环不重复告警', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 4; i++) {
      await hook.run(makeCtx(), edit('src/a.ts'))
      await hook.run(makeCtx(), verifyFail())
    }
    assert.equal(submitted.length, 1)
  })

  it('不同文件独立计数', async () => {
    const { submitted, hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    await hook.run(makeCtx(), edit('src/b.ts'))
    await hook.run(makeCtx(), verifyFail())
    assert.equal(hook.getCycleCount('src/a.ts'), 1)
    assert.equal(hook.getCycleCount('src/b.ts'), 1)
    assert.equal(submitted.length, 0)
  })

  it('bash 测试命令的失败也算 verify fail', async () => {
    const { submitted, hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), bashVerifyFail('npm test'))
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), bashVerifyFail('npx tsx --test src/x.test.ts'))
    assert.equal(submitted.length, 1)
  })

  it('非验证类 bash 失败不计', async () => {
    const { hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), bashVerifyFail('ls /nonexistent'))
    assert.equal(hook.getCycleCount('src/a.ts'), 0)
  })

  it('编辑失败(写盘失败)不进入 pending', async () => {
    const { hook } = harness()
    await hook.run(makeCtx(), edit('src/a.ts', false))
    await hook.run(makeCtx(), verifyFail())
    assert.equal(hook.getCycleCount('src/a.ts'), 0)
  })
})
