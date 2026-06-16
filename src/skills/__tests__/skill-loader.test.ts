import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { SkillRegistry, parseSkillMarkdown, listSkillFiles, importSkillsIntoRivet } from '../skill-loader.js'
import { validatePathSafe } from '../../tools/path-validate.js'

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

  it('importSkillsIntoRivet copies a project .claude skill into .rivet/skills (idempotent)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-import-'))
    const srcDir = join(cwd, '.claude', 'skills', 'foo')
    mkdirSync(join(srcDir, 'references'), { recursive: true })
    writeFileSync(join(srcDir, 'SKILL.md'), '---\ndescription: foo\n---\n\nbody', 'utf-8')
    writeFileSync(join(srcDir, 'references', 'r.md'), 'r', 'utf-8')

    const res = importSkillsIntoRivet(cwd, ['foo'])
    assert.deepEqual(res.copied, ['foo'])
    assert.deepEqual(res.skipped, [])
    assert.ok(existsSync(join(cwd, '.rivet', 'skills', 'foo', 'SKILL.md')))
    assert.ok(existsSync(join(cwd, '.rivet', 'skills', 'foo', 'references', 'r.md')))

    // second run is a no-op (does not overwrite local copy)
    const again = importSkillsIntoRivet(cwd, ['foo'])
    assert.deepEqual(again.copied, [])
    assert.deepEqual(again.skipped, ['foo'])
  })

  it('importSkillsIntoRivet reports missing skills as errors', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-import-miss-'))
    const res = importSkillsIntoRivet(cwd, ['nope'])
    assert.deepEqual(res.copied, [])
    assert.equal(res.errors.length, 1)
    assert.match(res.errors[0]!, /nope: not found/)
  })

  it('Tier-3 sub-files of a .rivet/skills directory skill are readable (path boundary)', () => {
    // A directory skill lives under cwd/.rivet/skills — its sub-files must pass
    // the read boundary so the model can actually open what <skill-files> lists.
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-tier3-'))
    const skillDir = join(cwd, '.rivet', 'skills', 'pdf')
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: x\n---\n\nbody', 'utf-8')
    writeFileSync(join(skillDir, 'references', 'api.md'), 'api', 'utf-8')

    const reg = new SkillRegistry()
    reg.loadFromDirectory(join(cwd, '.rivet', 'skills'))
    const def = reg.get('pdf')!
    const sub = join(def.skillDir!, 'references', 'api.md')

    // both absolute and as the model would receive it from <skill-files>
    assert.equal(validatePathSafe(cwd, sub, 'read').ok, true)
    // boundary still bites for escapes
    assert.equal(validatePathSafe(cwd, '../../etc/passwd', 'read').ok, false)
  })
})
