import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PlanCache } from '../plan-cache.js'

describe('PlanCache', () => {
  it('records and looks up a plan by keyword overlap', () => {
    const cache = new PlanCache()
    cache.record('add pagination to users endpoint', [
      { tool: 'read_file', target: 'src/routes/users.ts' },
      { tool: 'edit_file', target: 'src/routes/users.ts' },
      { tool: 'bash', target: 'npm test' },
    ])
    const hit = cache.lookup('add pagination to posts endpoint')
    assert.ok(hit)
    assert.equal(hit.steps.length, 3)
    assert.equal(hit.steps[0]!.tool, 'read_file')
  })

  it('returns null for unrelated tasks', () => {
    const cache = new PlanCache()
    cache.record('fix database migration', [
      { tool: 'read_file', target: 'migrations/001.sql' },
      { tool: 'edit_file', target: 'migrations/001.sql' },
    ])
    const hit = cache.lookup('update CSS styles for header')
    assert.equal(hit, null)
  })

  it('invalidates entries when file changes', () => {
    const cache = new PlanCache()
    cache.record('refactor users module', [
      { tool: 'read_file', target: 'src/users.ts' },
      { tool: 'edit_file', target: 'src/users.ts' },
    ])
    assert.equal(cache.size(), 1)
    cache.invalidate('src/users.ts')
    assert.equal(cache.size(), 0)
  })

  it('rejects plans with too few steps', () => {
    const cache = new PlanCache()
    const result = cache.record('simple task', [{ tool: 'bash', target: 'ls' }])
    assert.equal(result, null)
    assert.equal(cache.size(), 0)
  })

  it('evicts oldest entries when full', () => {
    const cache = new PlanCache({ maxEntries: 3 })
    for (let i = 0; i < 5; i++) {
      cache.record(`task number ${i} unique${i}`, [
        { tool: 'read_file', target: `file${i}.ts` },
        { tool: 'edit_file', target: `file${i}.ts` },
      ])
    }
    assert.equal(cache.size(), 3)
  })

  it('records and matches Chinese task descriptions (CJK bigram keywords)', () => {
    const cache = new PlanCache()
    const recorded = cache.record('给用户接口加分页功能', [
      { tool: 'read_file', target: 'src/routes/users.ts' },
      { tool: 'edit_file', target: 'src/routes/users.ts' },
    ])
    assert.ok(recorded, 'Chinese description must produce keywords (was silently dropped before)')
    const hit = cache.lookup('给帖子接口加分页功能')
    assert.ok(hit)
    assert.equal(hit.steps.length, 2)
  })

  it('does not cross-match unrelated Chinese tasks', () => {
    const cache = new PlanCache()
    cache.record('修复数据库迁移脚本报错', [
      { tool: 'read_file', target: 'migrations/001.sql' },
      { tool: 'edit_file', target: 'migrations/001.sql' },
    ])
    assert.equal(cache.lookup('优化页面渲染性能'), null)
  })
})
