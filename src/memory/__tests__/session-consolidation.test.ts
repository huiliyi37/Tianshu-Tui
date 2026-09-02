import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildConsolidationPrompt, parseConsolidationOutput, applyConsolidation, consolidationEnabled,
} from '../session-consolidation.js'
import { readMemoryEntries } from '../unified-memory.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const root = () => { const d = mkdtempSync(join(tmpdir(), 'rivet-consol-')); roots.push(d); return d }

describe('session consolidation', () => {
  it('builds prompt with transcript and parses summary + procedures', () => {
    const input = { sessionId: 's1', transcript: 'user: fix cache\nassistant: done', objective: 'fix cache' }
    const prompt = buildConsolidationPrompt(input)
    assert.match(prompt, /会话摘要/)
    assert.match(prompt, /procedures/)
    assert.match(prompt, /fix cache/)

    const raw = '{"summary":"本次修复了前缀缓存。","procedures":[{"name":"缓存校准","whenToUse":"改缓存前","steps":["跑基线","对比命中率"]}]}'
    const output = parseConsolidationOutput(raw)
    assert.equal(output?.summary, '本次修复了前缀缓存。')
    assert.equal(output?.procedures.length, 1)
    assert.equal(output?.procedures[0]?.name, '缓存校准')
    assert.deepEqual(output?.procedures[0]?.steps, ['跑基线', '对比命中率'])
    // 结构性意外 → fail-closed
    assert.equal(parseConsolidationOutput('not json'), null)
  })

  it('writes summary and procedure entries to LTM with consolidation source', () => {
    const cwd = root()
    const written = applyConsolidation(cwd, 'session-1', {
      summary: '本文档完成了自适应记忆的缓存安全接入与测试校验。',
      procedures: [{ name: '缓存安全接入', whenToUse: '改 prompt 注入时', steps: ['走 appendixDelta', '不动 frozen'] }],
    })
    assert.equal(written, 2)
    const entries = readMemoryEntries(cwd)
    assert.equal(entries.length, 2)
    const summary = entries.find(e => e.topic === 'session-summary')
    const procedure = entries.find(e => e.topic === 'procedure')
    assert.equal(summary?.source, 'consolidation')
    assert.equal(procedure?.kind, 'reusable_design_pattern')
  })

  it('enabled by default, opt-out via env', () => {
    assert.equal(consolidationEnabled(undefined), true)
    assert.equal(consolidationEnabled('off'), false)
  })
})
