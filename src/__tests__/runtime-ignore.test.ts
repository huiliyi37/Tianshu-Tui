import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('runtime ignore rules', () => {
  it('ignores runtime diagnostics while preserving canonical memory paths', () => {
    const content = readFileSync(join(process.cwd(), '.gitignore'), 'utf-8')
    assert.match(content, /^\.rivet\/runtime\/$/m)
    assert.match(content, /^\.rivet\/tmp\/$/m)
    assert.match(content, /^\.rivet\/prefix-diag\.jsonl$/m)
    assert.match(content, /^\.rivet\/knowledge\/memory\.jsonl$/m)
    // 公开仓策略：整目录忽略 .rivet/knowledge/ 禁止回灌（私有仓保持文件级策展）。
    // 带该标记时豁免整目录断言；无标记的开发仓形态下仍禁止整目录忽略。
    const publicRepoPolicy = content.includes('公开仓：禁止 knowledge 回灌')
    if (!publicRepoPolicy) {
      assert.doesNotMatch(content, /^\.rivet\/knowledge\/$/m)
    }
    assert.doesNotMatch(content, /^\.rivet\/knowledge\/project-memory\.md$/m)
  })
})
