import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeVolatilePayload, estimateContextTokens, formatVolatilePayloadReport } from '../payload-diagnostic.js'

describe('payload diagnostics', () => {
  it('returns an empty report for an empty block', () => {
    const report = analyzeVolatilePayload('')

    assert.equal(report.totalChars, 0)
    assert.equal(report.estimatedTokens, 0)
    assert.deepEqual(report.sections, [])
    assert.deepEqual(report.wasteCandidates, [])
  })

  it('estimates tokens with a simple chars/4 heuristic', () => {
    assert.equal(estimateContextTokens(''), 0)
    assert.equal(estimateContextTokens('abcd'), 1)
    assert.equal(estimateContextTokens('abcde'), 2)
  })

  it('recognizes top-level XML-like sections including self-closing tags', () => {
    const block = `<context>
<environment platform="darwin" cwd="/repo" />

<project-instructions>
Use TDD.
</project-instructions>

<active-claims count="1">
  <claim id="a" kind="decision" scope="session" confidence="0.9" evidence="e">Keep tests green.</claim>
</active-claims>
</context>`

    const report = analyzeVolatilePayload(block)
    const ids = report.sections.map(s => s.id)

    assert.ok(ids.includes('environment'))
    assert.ok(ids.includes('project-instructions'))
    assert.ok(ids.includes('active-claims'))
    assert.ok(!ids.includes('context'))
    assert.equal(report.totalChars, block.length)
    assert.ok(report.estimatedTokens > 0)
  })

  it('sorts sections by size descending', () => {
    const block = `<context>
<git-status>M a.ts</git-status>
<project-instructions>${'x'.repeat(100)}</project-instructions>
</context>`

    const report = analyzeVolatilePayload(block)

    assert.equal(report.sections[0]?.id, 'project-instructions')
  })

  it('flags large active claims as waste candidates', () => {
    const claims = Array.from({ length: 9 }, (_, i) => `  <claim id="${i}" kind="file_observation" scope="session" confidence="0.60" evidence="e">${'claim '.repeat(20)}</claim>`).join('\n')
    const block = `<context>
<active-claims count="9">
${claims}
</active-claims>
</context>`

    const report = analyzeVolatilePayload(block)

    assert.ok(report.wasteCandidates.some(c => c.id === 'active-claims' && c.reason.includes('9 claims')))
  })

  it('flags large project instructions and total payloads', () => {
    const block = `<context>
<project-instructions>${'x'.repeat(7000)}</project-instructions>
<git-status>${'m'.repeat(1300)}</git-status>
<historical-lessons>${'h'.repeat(900)}</historical-lessons>
<active-claims count="1"><claim id="a" kind="decision" scope="session" confidence="0.9" evidence="e">${'a'.repeat(3000)}</claim></active-claims>
</context>`

    const report = analyzeVolatilePayload(block)
    const candidateIds = report.wasteCandidates.map(c => c.id)

    assert.ok(candidateIds.includes('project-instructions'))
    assert.ok(candidateIds.includes('git-status'))
    assert.ok(candidateIds.includes('historical-lessons'))
    assert.ok(candidateIds.includes('active-claims'))
    assert.ok(candidateIds.includes('total'))
  })

  it('formats a readable report', () => {
    const report = analyzeVolatilePayload('<context><environment platform="darwin" /></context>')
    const text = formatVolatilePayloadReport(report)

    assert.ok(text.includes('Context Payload'))
    assert.ok(text.includes('Total:'))
    assert.ok(text.includes('Sections:'))
    assert.ok(text.includes('environment'))
  })
})
