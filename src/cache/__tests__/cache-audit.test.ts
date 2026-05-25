import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { auditCacheRisk } from '../cache-audit.js'

describe('auditCacheRisk', () => {
  it('reports high risk for prompt engine changes', () => {
    const report = auditCacheRisk({ changedFiles: ['src/prompt/engine.ts'] })
    assert.equal(report.level, 'high')
    assert.equal(report.findings[0]?.level, 'high')
    assert.match(report.findings[0]?.reason ?? '', /request message layout/)
  })

  it('reports medium risk for tool result changes', () => {
    const report = auditCacheRisk({ changedFiles: ['src/tools/read-file.ts'] })
    assert.equal(report.level, 'medium')
    assert.equal(report.findings[0]?.level, 'medium')
  })

  it('uses the highest risk as report level', () => {
    const report = auditCacheRisk({ changedFiles: ['README.md', 'src/tools/grep.ts', 'src/prompt/static.ts'] })
    assert.equal(report.level, 'high')
    assert.equal(report.findings.length, 3)
  })
})
