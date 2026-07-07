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

function verifyFail(failureClass?: string, resultContent?: string): RuntimeToolEvent {
  return {
    name: 'run_tests', success: false, isError: true, failureClass, resultContent,
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

  it('不同失败指纹不计入盲改循环（递进调试）', async () => {
    const { submitted, hook } = harness()
    // 编辑文件
    await hook.run(makeCtx(), edit('src/a.ts'))
    // 第一次验证失败：test_a, expected 1 to equal 2
    await hook.run(makeCtx(), verifyFail('assertion',
      '✖ test_a (5ms)\n  AssertionError: expected 1 to equal 2\n'))
    assert.equal(submitted.length, 0)
    // 再次编辑
    await hook.run(makeCtx(), edit('src/a.ts'))
    // 第二次验证失败：test_b, 不同的错误消息 — 指纹变了
    await hook.run(makeCtx(), verifyFail('assertion',
      '✖ test_b (3ms)\n  AssertionError: expected "foo" to equal "bar"\n'))
    // 指纹不同 → 不计入盲改，不触发 advisory
    assert.equal(submitted.length, 0)
    assert.equal(hook.getCycleCount('src/a.ts'), 1) // 重置为 1
  })

  it('相同失败指纹触发盲改检测（同 bug 反复修）', async () => {
    const { submitted, hook } = harness()
    const sameError = '✖ test_a (5ms)\n  AssertionError: expected 1 to equal 2\n'
    // 第一次循环
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail('assertion', sameError))
    assert.equal(submitted.length, 0)
    // 第二次循环 — 相同错误
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail('assertion', sameError))
    // 指纹相同 → 触发盲改 advisory
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /盲改/)
  })

  it('resultContent 为 undefined 时回退到旧行为（不计指纹）', async () => {
    const { submitted, hook } = harness()
    // 无 resultContent → extractFailureFingerprint 返回 null → 正常计数
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail()) // 无 resultContent
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail()) // 无 resultContent
    // 仍然触发（旧行为不变）
    assert.equal(submitted.length, 1)
  })

  it('verify pass 清除已沉积的 dead-end 信息素', async () => {
    const { submitted, deposits, hook } = harness()
    // 先触发一次死路沉积
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), verifyFail())
    assert.equal(submitted.length, 1) // 死路触发
    const deadDeposit = deposits.find(d => d.path === 'src/a.ts' && d.signal === 'dead-end' && d.strength === 0.8)
    assert.ok(deadDeposit, 'should have dead-end deposition with strength 0.8')

    // verify pass → 应沉积 strength=0 覆盖
    await hook.run(makeCtx(), verifyPass())
    const clearedDeposit = deposits.filter(d => d.path === 'src/a.ts' && d.signal === 'dead-end').at(-1)
    assert.ok(clearedDeposit, 'should have a clearing deposit for src/a.ts')
    assert.equal(clearedDeposit!.strength, 0, 'verify pass should clear pheromone with strength=0')
  })

  it('verify pass 清除多个文件的 dead-end 信息素', async () => {
    const { deposits, hook } = harness()
    // 两个文件各有死路
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), edit('src/b.ts'))
    await hook.run(makeCtx(), verifyFail())
    await hook.run(makeCtx(), edit('src/a.ts'))
    await hook.run(makeCtx(), edit('src/b.ts'))
    await hook.run(makeCtx(), verifyFail())
    // 两个文件都触发了
    const aDead = deposits.filter(d => d.path === 'src/a.ts' && d.signal === 'dead-end')
    const bDead = deposits.filter(d => d.path === 'src/b.ts' && d.signal === 'dead-end')
    assert.ok(aDead.some(d => d.strength === 0.8), 'file a should have strength=0.8 deposition')
    assert.ok(bDead.some(d => d.strength === 0.8), 'file b should have strength=0.8 deposition')

    // verify pass → 两个文件都应清除
    await hook.run(makeCtx(), verifyPass())
    const aCleared = deposits.filter(d => d.path === 'src/a.ts' && d.signal === 'dead-end').at(-1)
    const bCleared = deposits.filter(d => d.path === 'src/b.ts' && d.signal === 'dead-end').at(-1)
    assert.equal(aCleared!.strength, 0)
    assert.equal(bCleared!.strength, 0)
  })
})
