import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractRegressionInventory,
  needleForItem,
  verifyRegressionInventory,
  formatInventoryReport,
} from '../regression-inventory.js'

// 重构行为等价契约（重构事故链缺口 3）：计划的「回归清单」章节 → 交付前逐项核验。

describe('extractRegressionInventory', () => {
  it('extracts list items under a 回归清单 heading, stopping at the next same-level heading', () => {
    const md = [
      '# 重构计划',
      '',
      '## 回归清单',
      '- 导航项 `settings` 仍然注册',
      '- [ ] 路由 `/api/plans` 仍然存在',
      '* 导出符号 `createLoop` 不变',
      '1. 命令入口 `/plan-list` 可用',
      '',
      '## 验证',
      '- 这条不属于清单',
    ].join('\n')
    const items = extractRegressionInventory(md)
    assert.equal(items.length, 4)
    assert.match(items[0]!, /settings/)
    assert.match(items[3]!, /plan-list/)
  })

  it('supports the english "Regression Inventory" heading', () => {
    const md = '## Regression Inventory\n- `exportedFn` still exported\n'
    assert.deepEqual(extractRegressionInventory(md), ['`exportedFn` still exported'])
  })

  it('returns empty when the section is absent', () => {
    assert.deepEqual(extractRegressionInventory('# 计划\n\n## 验证\n- npm test'), [])
  })

  it('keeps deeper sub-headings inside the section', () => {
    const md = [
      '## 回归清单',
      '### 路由',
      '- `/home` 路由',
      '### 导航',
      '- `sidebar` 导航项',
      '## 下一章',
      '- 不算',
    ].join('\n')
    const items = extractRegressionInventory(md)
    assert.deepEqual(items, ['`/home` 路由', '`sidebar` 导航项'])
  })
})

describe('needleForItem', () => {
  it('prefers the first backtick fragment', () => {
    assert.equal(needleForItem('导航项 `settingsSurface` 仍然注册'), 'settingsSurface')
  })

  it('falls back to the whole item text', () => {
    assert.equal(needleForItem('设置页仍可打开'), '设置页仍可打开')
  })
})

describe('verifyRegressionInventory', () => {
  it('classifies items via the injected searcher', () => {
    const results = verifyRegressionInventory(
      '/fake',
      ['`present-anchor` 仍在', '`gone-anchor` 仍在', '`weird` 状况'],
      (_cwd, needle) => needle === 'present-anchor' ? 'present' : needle === 'gone-anchor' ? 'missing' : 'unknown',
    )
    assert.deepEqual(results.map(r => r.status), ['present', 'missing', 'unknown'])
    assert.equal(results[1]!.needle, 'gone-anchor')
  })
})

describe('formatInventoryReport', () => {
  it('reports missing anchors with the refactor-loss warning', () => {
    const lines = formatInventoryReport([
      { item: '`a` 仍在', needle: 'a', status: 'present' },
      { item: '`b` 仍在', needle: 'b', status: 'missing' },
    ])
    assert.ok(lines.some(l => l.includes('1/2 仍存在')))
    assert.ok(lines.some(l => l.includes('❌') && l.includes('已消失')))
    assert.ok(lines.some(l => l.includes('重构丢功能')))
  })

  it('is empty for an empty result set', () => {
    assert.deepEqual(formatInventoryReport([]), [])
  })
})
