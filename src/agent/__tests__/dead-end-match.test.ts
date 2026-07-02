import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDeadEndTarget, matchesDeadEnd } from '../dead-end-match.js'

describe('normalizeDeadEndTarget', () => {
  it('存量脏数据 cd <repo> &&（截断尾）→ 空串，永不匹配', () => {
    assert.equal(normalizeDeadEndTarget('cd /Users/banxia/app/deepseek-tui/opencode-tui && '), '')
  })

  it('legacy 摘要前缀 处理 xxx... → 剥离', () => {
    assert.equal(normalizeDeadEndTarget('处理 src/legacy/mod...'), 'src/legacy/mod')
  })

  it('新格式带 cd 样板 → 剥出实际命令', () => {
    assert.equal(normalizeDeadEndTarget('cd /repo && npx tsc --noEmit'), 'npx tsc --noEmit')
  })
})

describe('matchesDeadEnd', () => {
  it('normalize 后 <5 字符 → 不匹配（短碎片消毒）', () => {
    assert.equal(matchesDeadEnd('ls', ['ls -la /src']), false)
  })

  it('有意义 target 双向子串仍工作', () => {
    assert.equal(matchesDeadEnd('npx tsc --noEmit', ['cd /repo && npx tsc --noEmit --watch'.slice(0, 50)]), true)
  })

  it('占位 target（<pending> 等）跳过', () => {
    assert.equal(matchesDeadEnd('npx tsc --noEmit', ['<pending>']), false)
  })
})
