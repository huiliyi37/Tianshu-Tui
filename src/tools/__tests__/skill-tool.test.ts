import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SKILL_TOOL } from '../skill.js'
import { skillRegistry } from '../../skills/skill-loader.js'
import type { ToolCallParams } from '../types.js'

const big = (n: number): string => 'y'.repeat(n)

function call(name: unknown): Promise<{ content: string; isError?: boolean }> {
  const params = { input: { name }, toolUseId: 't', cwd: process.cwd() } as ToolCallParams
  return SKILL_TOOL.execute(params)
}

describe('skill tool', () => {
  beforeEach(() => {
    // The shared registry persists across tests; register fresh fixtures.
    skillRegistry.register({ name: 'small', description: 'small one', triggers: [], body: 'do the thing' })
    skillRegistry.register({ name: 'jumbo', description: 'big one', triggers: [], body: big(20_000) })
  })

  it('returns the FULL body with no truncation', async () => {
    const res = await call('jumbo')
    assert.equal(res.isError, undefined)
    // 20KB body survives intact — both the leading and trailing chars.
    assert.ok(res.content.includes(big(20_000)))
    assert.ok(res.content.length >= 20_000)
  })

  it('wraps the body in a skill tag', async () => {
    const res = await call('small')
    assert.equal(res.content, '<skill name="small">\ndo the thing\n</skill>')
  })

  it('unknown skill → friendly error with available list, no throw', async () => {
    const res = await call('does-not-exist')
    assert.equal(res.isError, true)
    assert.match(res.content, /Skill not found/)
    assert.match(res.content, /Available skills:/)
    assert.match(res.content, /small/)
  })

  it('missing name → error', async () => {
    const res = await call('')
    assert.equal(res.isError, true)
    assert.match(res.content, /name is required/)
  })

  it('is cache-safe: definition embeds no concrete skill name', () => {
    assert.equal(SKILL_TOOL.definition.name, 'skill')
    assert.ok(!SKILL_TOOL.definition.description.includes('jumbo'))
    assert.ok(!SKILL_TOOL.definition.description.includes('small'))
    assert.equal(SKILL_TOOL.requiresApproval({} as ToolCallParams), false)
    assert.equal(SKILL_TOOL.isConcurrencySafe(), true)
  })

  it('handles skill with empty body gracefully', async () => {
    skillRegistry.register({ name: 'empty', description: 'no body', triggers: [], body: '' })
    const res = await call('empty')
    assert.equal(res.isError, undefined)
    // Empty body should still produce a valid wrapped result
    assert.equal(res.content, '<skill name="empty">\n\n</skill>')
  })

  it('flat skill (no skillDir) → no <skill-files> block', async () => {
    const res = await call('small')
    assert.ok(!res.content.includes('<skill-files'))
  })

  it('directory skill → appends <skill-files> tree after the full body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-skill-tool-'))
    const dir = join(root, 'pdf')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'references', 'api.md'), 'api', 'utf-8')
    writeFileSync(join(dir, 'extract.py'), 'x', 'utf-8')
    skillRegistry.register({
      name: 'pdf', description: 'pdf skill', triggers: [], body: 'ROUTER', skillDir: dir,
    })

    const res = await call('pdf')
    assert.equal(res.isError, undefined)
    // full body preserved
    assert.ok(res.content.includes('<skill name="pdf">\nROUTER\n</skill>'))
    // file tree appended
    assert.ok(res.content.includes(`<skill-files dir="${dir}"`))
    assert.ok(res.content.includes('references/api.md'))
    assert.ok(res.content.includes('extract.py'))
    assert.ok(!res.content.includes('SKILL.md'))
  })
})
