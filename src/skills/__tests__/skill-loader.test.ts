import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillRegistry, parseSkillMarkdown } from '../skill-loader.js'

describe('skill-loader', () => {
  it('parses frontmatter and triggers', () => {
    const content = `---
name: tdd
description: Test-driven development workflow
triggers: [TDD, test-first]
---

Follow red-green-refactor.`
    const skill = parseSkillMarkdown(content, 'tdd.md')
    assert.equal(skill.name, 'tdd')
    assert.equal(skill.triggers.length, 2)
    assert.ok(skill.triggers.some(t => t.test('use TDD here')))
  })

  it('loads skills from directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-skills-'))
    writeFileSync(join(dir, 'review.md'), `---
name: review
description: Code review skill
triggers: ["review", "审查"]
---

Review carefully.`, 'utf-8')

    const reg = new SkillRegistry()
    const result = reg.loadFromDirectory(dir)
    assert.deepEqual(result.loaded, ['review'])
    assert.ok(reg.match('please review this code').length >= 1)
  })
})
