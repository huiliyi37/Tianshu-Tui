import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createDestructiveGateState } from '../destructive-gate.js'
import { GIT_CLEAR_RE } from '../destructive-patterns.js'

describe('destructive-gate 决策矩阵', () => {
  test('无验证失败时不拦截 git 清场命令', () => {
    const gate = createDestructiveGateState()
    const d = gate.evaluate('bash', { command: 'git stash' })
    assert.equal(d.block, false)
  })

  test('验证失败后窗口内拦截 git 清场,消息含命令与放行指引', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    const d = gate.evaluate('bash', { command: 'git reset --hard HEAD' })
    assert.equal(d.block, true)
    if (d.block) {
      assert.match(d.message, /git reset --hard HEAD/)
      assert.match(d.message, /原样重发/)
      assert.match(d.message, /根因/)
    }
  })

  test('首次拦截、同一命令原样重发放行(显式坚持)', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, false)
    // 空白差异归一化后仍视为同一命令
    assert.equal(gate.evaluate('bash', { command: '  git   stash ' }).block, false)
  })

  test('不同的清场命令各自独立拦截一次', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
    assert.equal(gate.evaluate('bash', { command: 'git clean -fd' }).block, true)
    assert.equal(gate.evaluate('bash', { command: 'git clean -fd' }).block, false)
  })

  test('验证通过关窗:失败→通过→清场不拦截', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    gate.noteVerification('passed')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, false)
  })

  test('blocked 状态不开窗也不关窗', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('blocked')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, false)
    gate.noteVerification('failed')
    gate.noteVerification('blocked')
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
  })

  test('窗口按实际执行的工具计数过期(默认 3)', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    gate.noteToolExecuted()
    gate.noteToolExecuted()
    gate.noteToolExecuted()
    // 3 次仍在窗口内
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
    const gate2 = createDestructiveGateState()
    gate2.noteVerification('failed')
    for (let i = 0; i < 4; i++) gate2.noteToolExecuted()
    assert.equal(gate2.evaluate('bash', { command: 'git stash' }).block, false)
  })

  test('新的失败重置窗口计数', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    for (let i = 0; i < 3; i++) gate.noteToolExecuted()
    gate.noteVerification('failed')
    gate.noteToolExecuted()
    assert.equal(gate.evaluate('bash', { command: 'git stash' }).block, true)
  })

  test('非 bash 工具与非清场命令永不拦截', () => {
    const gate = createDestructiveGateState()
    gate.noteVerification('failed')
    assert.equal(gate.evaluate('read_file', { path: 'a.ts' }).block, false)
    assert.equal(gate.evaluate('bash', { command: 'git status' }).block, false)
    assert.equal(gate.evaluate('bash', { command: 'git stash pop' }).block, false)
    assert.equal(gate.evaluate('bash', { command: 'npm test' }).block, false)
    assert.equal(gate.evaluate('bash', {}).block, false)
  })
})

describe('GIT_CLEAR_RE 共享正则(迁移回归)', () => {
  test('匹配清场类,排除只读/恢复类', () => {
    for (const cmd of ['git stash', 'git reset --hard', 'git checkout -- .', 'git restore .', 'git clean -fd']) {
      assert.equal(GIT_CLEAR_RE.test(cmd), true, `should match: ${cmd}`)
    }
    for (const cmd of ['git stash pop', 'git stash list', 'git stash show', 'git stash apply', 'git diff', 'git log']) {
      assert.equal(GIT_CLEAR_RE.test(cmd), false, `should NOT match: ${cmd}`)
    }
  })
})
