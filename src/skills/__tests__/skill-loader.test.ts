import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillRegistry, parseSkillMarkdown, listSkillFiles } from '../skill-loader.js'

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

  it('loads directory skills alongside flat skills, recording skillDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-skills-dir-'))
    // flat skill — no skillDir
    writeFileSync(join(root, 'flat.md'), `---
name: flat
description: flat skill
---

Flat body.`, 'utf-8')
    // directory skill with sub-files — skillDir recorded
    const myDir = join(root, 'myskill')
    mkdirSync(join(myDir, 'references'), { recursive: true })
    mkdirSync(join(myDir, 'scripts'), { recursive: true })
    writeFileSync(join(myDir, 'SKILL.md'), `---
description: a directory skill
---

Router body.`, 'utf-8')
    writeFileSync(join(myDir, 'references', 'a.md'), 'ref a', 'utf-8')
    writeFileSync(join(myDir, 'scripts', 'run.py'), 'print(1)', 'utf-8')

    const reg = new SkillRegistry()
    const res = reg.loadFromDirectory(root)
    assert.ok(res.loaded.includes('flat'))
    assert.ok(res.loaded.includes('myskill'))

    const flat = reg.get('flat')!
    assert.equal(flat.skillDir, undefined)

    const dirSkill = reg.get('myskill')!
    assert.equal(dirSkill.skillDir, myDir)
    assert.equal(dirSkill.body, 'Router body.')
    assert.equal(dirSkill.description, 'a directory skill')
  })

  it('listSkillFiles enumerates sub-files but excludes SKILL.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-skill-files-'))
    const myDir = join(root, 'pdf')
    mkdirSync(join(myDir, 'references'), { recursive: true })
    mkdirSync(join(myDir, 'scripts'), { recursive: true })
    writeFileSync(join(myDir, 'SKILL.md'), '---\ndescription: x\n---\n\nbody', 'utf-8')
    writeFileSync(join(myDir, 'references', 'a.md'), 'a', 'utf-8')
    writeFileSync(join(myDir, 'scripts', 'run.py'), 'x', 'utf-8')

    const files = listSkillFiles(myDir)
    const paths = files.map(f => f.path)
    assert.ok(paths.includes('references/'))
    assert.ok(paths.includes('references/a.md'))
    assert.ok(paths.includes('scripts/run.py'))
    assert.ok(!paths.includes('SKILL.md'))
  })
})
