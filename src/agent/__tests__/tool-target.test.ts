import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bashCommandTarget, toolTargetFromInput } from '../tool-target.js'

describe('bashCommandTarget', () => {
  it('剥离 cd <path> && 样板后再截断——根因场景', () => {
    const cmd = 'cd /Users/banxia/app/deepseek-tui/opencode-tui && npx tsc --noEmit'
    assert.equal(bashCommandTarget(cmd), 'npx tsc --noEmit')
  })

  it('剥离带引号路径的 cd 样板', () => {
    assert.equal(bashCommandTarget('cd "/path with spaces/repo" && npm test'), 'npm test')
    assert.equal(bashCommandTarget("cd '/tmp/x' && ls"), 'ls')
  })

  it('连续多个 cd 段全部剥离', () => {
    assert.equal(bashCommandTarget('cd /a && cd /b && make'), 'make')
  })

  it('纯 cd 命令（无后续段）原样保留——cd 本身就是目标', () => {
    assert.equal(bashCommandTarget('cd /some/dir'), 'cd /some/dir')
  })

  it('剥离后仍超 50 字符则截断到 50', () => {
    const long = 'cd /repo && ' + 'x'.repeat(80)
    assert.equal(bashCommandTarget(long).length, 50)
    assert.equal(bashCommandTarget(long), 'x'.repeat(50))
  })

  it('无 cd 前缀的命令行为不变（纯截断）', () => {
    assert.equal(bashCommandTarget('npm run build'), 'npm run build')
    assert.equal(bashCommandTarget('y'.repeat(80)), 'y'.repeat(50))
  })
})

describe('toolTargetFromInput', () => {
  it('file_path > path > command 优先级保持', () => {
    assert.equal(toolTargetFromInput('edit_file', { file_path: 'a.ts', command: 'x' }), 'a.ts')
    assert.equal(toolTargetFromInput('grep', { path: 'src/' }), 'src/')
    assert.equal(toolTargetFromInput('bash', { command: 'cd /repo && npm test' }), 'npm test')
    assert.equal(toolTargetFromInput('todo', {}), 'todo')
  })

  it('视觉工具的 action 成为语义 target（2026-07-15）', () => {
    assert.equal(toolTargetFromInput('browser_debug', { action: 'screenshot' }), 'screenshot')
    assert.equal(
      toolTargetFromInput('browser_debug', { action: 'navigate', url: 'http://localhost:3000' }),
      'navigate http://localhost:3000',
    )
    assert.equal(toolTargetFromInput('computer_use', { action: 'snapshot', app: 'Finder' }), 'snapshot Finder')
  })

  it('非视觉工具的 action 字段不改变 target（git/plan 语义不受影响）', () => {
    assert.equal(toolTargetFromInput('git', { action: 'status' }), 'git')
    assert.equal(toolTargetFromInput('plan', { action: 'submit' }), 'plan')
  })
})
