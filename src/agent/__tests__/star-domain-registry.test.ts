import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { STAR_DOMAINS } from '../star-domain.js'
import { StarDomainRegistry, starDomainRegistry } from '../star-domain-registry.js'

const _require = createRequire(import.meta.url)

describe('StarDomainRegistry — built-in domains', () => {
  test('has all 7 built-in domains', () => {
    const reg = new StarDomainRegistry()
    assert.equal(reg.getDomainIds().length, 7)
    for (const id of Object.keys(STAR_DOMAINS) as Array<keyof typeof STAR_DOMAINS>) {
      assert.ok(reg.has(id), `missing built-in domain: ${id}`)
      assert.equal(reg.get(id)!.isCustom, false)
    }
  })

  test('get() returns domain definition with all required fields', () => {
    const reg = new StarDomainRegistry()
    const tianquan = reg.get('tianquan')
    assert.ok(tianquan)
    assert.equal(tianquan.name, '天权')
    assert.equal(typeof tianquan.systemPromptSuffix, 'string')
    assert.ok(tianquan.systemPromptSuffix.length > 0)
    assert.ok(Array.isArray(tianquan.keywords))
    assert.ok(Array.isArray(tianquan.toolWhitelist))
    assert.ok(tianquan.uiPersona)
    assert.ok(tianquan.uiPersona.glyph)
  })

  test('matchDomain returns correct domain for known keywords', () => {
    const reg = new StarDomainRegistry()
    // '按计划实现功能' → tianliang scores 2 ('实现'+'按计划'), tianji scores 1 → tianliang
    assert.equal(reg.matchDomain('按计划实现功能'), 'tianliang')
    // '重构优化性能' → tianfu scores 3, tianji scores 1 → tianfu
    assert.equal(reg.matchDomain('重构优化性能'), 'tianfu')
  })

  test('matchDomain returns null on keyword tie', () => {
    const reg = new StarDomainRegistry()
    // '审查代码质量' → tianfu=1 ('审查'), tianquan=1 ('审查') → tie → null
    assert.equal(reg.matchDomain('审查代码质量'), null)
    // '探索新的可能性' → pojun=1 ('探索'), tianxuan=1 ('探索') → tie → null
    assert.equal(reg.matchDomain('探索新的可能性'), null)
  })

  test('matchDomain returns null when no keywords match', () => {
    const reg = new StarDomainRegistry()
    assert.equal(reg.matchDomain('hello world xyz'), null)
  })

  test('matchDomain returns null on tie', () => {
    // Both pojun and tianxuan have '探索' keyword → tie
    const reg = new StarDomainRegistry()
    // pojun: '探索', tianxuan: '探索' — both score 1, tie → null
    const result = reg.matchDomain('探索')
    // If both score equal and there are only 2, result is null
    // Let's verify the actual keyword overlap
    const pojunKw = reg.get('pojun')!.keywords
    const tianxuanKw = reg.get('tianxuan')!.keywords
    const bothHaveExplore = pojunKw.some(k => k === '探索') && tianxuanKw.some(k => k === '探索')
    if (bothHaveExplore) {
      assert.equal(result, null)
    }
  })

  test('list() returns all domains', () => {
    const reg = new StarDomainRegistry()
    assert.equal(reg.list().length, 7)
  })
})

describe('StarDomainRegistry — user domain loading', () => {
  const tmpBase = join(tmpdir(), `rivet-domain-reg-test-${Date.now()}`)

  test('loads a valid user domain from directory', () => {
    const dir = join(tmpBase, 'test-load')
    mkdirSync(join(dir, 'machao'), { recursive: true })
    writeFileSync(join(dir, 'machao', 'card.md'), [
      '---',
      'name: 马超',
      'motto: 长驱直入，势不可挡',
      'decisionStyle: bold',
      'courageThreshold: 0.2',
      "keywords: ['网络', '渗透', '安全', 'attack', 'network']",
      "toolWhitelist: ['read_file', 'bash', 'grep']",
      'separator: thick',
      'accent: error',
      'glyph: ⚔',
      '---',
      '',
      '你是马超——突击手。快速渗透网络层，发现安全弱点。',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(errors.length, 0)
      assert.ok(loaded.includes('machao'))

      const machao = reg.get('machao')
      assert.ok(machao)
      assert.equal(machao.name, '马超')
      assert.equal(machao.isCustom, true)
      assert.equal(machao.systemPromptSuffix, '你是马超——突击手。快速渗透网络层，发现安全弱点。')
      assert.deepEqual(machao.keywords, ['网络', '渗透', '安全', 'attack', 'network'])
      assert.equal(machao.uiPersona.glyph, '⚔')
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('rejects override of built-in domain', () => {
    const dir = join(tmpBase, 'test-override')
    mkdirSync(join(dir, 'tianquan'), { recursive: true })
    writeFileSync(join(dir, 'tianquan', 'card.md'), [
      '---',
      'name: 假天权',
      'motto: fake',
      "keywords: ['fake']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'fake suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /cannot override built-in/)
      // Original tianquan is intact
      assert.equal(reg.get('tianquan')!.name, '天权')
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('rejects duplicate custom domain id', () => {
    const dir = join(tmpBase, 'test-dup')
    mkdirSync(join(dir, 'machao'), { recursive: true })
    mkdirSync(join(dir, 'machao2'), { recursive: true })
    const card = [
      '---',
      'name: 马超',
      'motto: 突击',
      "keywords: ['attack']",
      "toolWhitelist: ['read_file']",
      'id: machao',
      '---',
      '',
      'suffix',
    ].join('\n')
    writeFileSync(join(dir, 'machao', 'card.md'), card)
    writeFileSync(join(dir, 'machao2', 'card.md'), card)

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 1)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /duplicate custom domain id/)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('rejects invalid domain id characters', () => {
    const dir = join(tmpBase, 'test-bad-id')
    mkdirSync(join(dir, 'BAD DOMAIN!'), { recursive: true })
    writeFileSync(join(dir, 'BAD DOMAIN!', 'card.md'), [
      '---',
      'name: Bad',
      'motto: bad',
      "keywords: ['bad']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /Invalid domain id/)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('clamps courageThreshold to [0, 1]', () => {
    const dir = join(tmpBase, 'test-clamp')
    mkdirSync(join(dir, 'brave'), { recursive: true })
    writeFileSync(join(dir, 'brave', 'card.md'), [
      '---',
      'name: 勇者',
      'motto: brave',
      'courageThreshold: 999',
      "keywords: ['brave']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 1)
      assert.equal(errors.length, 0)
      assert.equal(reg.get('brave')!.courageThreshold, 1)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('truncates long systemPromptSuffix to 2000 chars', () => {
    const dir = join(tmpBase, 'test-truncate')
    mkdirSync(join(dir, 'talker'), { recursive: true })
    writeFileSync(join(dir, 'talker', 'card.md'), [
      '---',
      'name: 话痨',
      'motto: talk',
      "keywords: ['talk']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'x'.repeat(3000),
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 1)
      assert.equal(errors.length, 0)
      assert.equal(reg.get('talker')!.systemPromptSuffix.length, 2000)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('rejects arrays whose sanitized values are empty', () => {
    const dir = join(tmpBase, 'test-sanitized-empty')
    mkdirSync(join(dir, 'empty-tools'), { recursive: true })
    writeFileSync(join(dir, 'empty-tools', 'card.md'), [
      '---',
      'name: Empty Tools',
      "keywords: ['valid']",
      "toolWhitelist: ['']",
      '---',
      '',
      'suffix',
    ].join('\n'))
    mkdirSync(join(dir, 'numeric-keywords'), { recursive: true })
    writeFileSync(join(dir, 'numeric-keywords', 'card.md'), [
      '---',
      'name: Numeric Keywords',
      'keywords: [1, 2, 3]',
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 2)
      assert.ok(errors.some(e => e.includes('toolWhitelist must contain')))
      assert.ok(errors.some(e => e.includes('keywords must contain')))
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('reports parse errors gracefully', () => {
    const dir = join(tmpBase, 'test-error')
    mkdirSync(join(dir, 'bad-domain'), { recursive: true })
    writeFileSync(join(dir, 'bad-domain', 'card.md'), 'not valid yaml at all')

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0)
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /Missing YAML frontmatter/)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test('handles missing directory gracefully', () => {
    const reg = new StarDomainRegistry()
    const { loaded, errors } = reg.loadFromDirectory('/nonexistent/path')
    assert.equal(loaded.length, 0)
    assert.equal(errors.length, 0)
  })
})

describe('starDomainRegistry singleton', () => {
  test('is an instance of StarDomainRegistry', () => {
    assert.ok(starDomainRegistry instanceof StarDomainRegistry)
  })

  test('has the 7 built-in domains', () => {
    assert.equal(starDomainRegistry.getDomainIds().length, 7)
  })
})

// ─── P0-A2 fail-closed: sanitize-then-validate ────────────────
describe('parseDomainCard — P0-A2 fail-closed validation', () => {
  const tmpBase = join(tmpdir(), `rivet-p0a2-test-${Date.now()}`)

  test('toolWhitelist:[1,2,3] → rejected (all non-string items filtered, empty after sanitize)', () => {
    const dir = join(tmpBase, 'test-nonstring-wl')
    mkdirSync(join(dir, 'numwhitelist'), { recursive: true })
    // The YAML parser parses [1,2,3] as an array of numbers
    writeFileSync(join(dir, 'numwhitelist', 'card.md'), [
      '---',
      'name: NumberWL',
      'motto: test',
      "keywords: ['test']",
      'toolWhitelist: [1, 2, 3]',
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0, 'should not load domain with non-string toolWhitelist')
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /toolWhitelist must contain at least one non-empty string/)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test("keywords:[''] → rejected (empty string filtered, no real keywords)", () => {
    const dir = join(tmpBase, 'test-empty-kw')
    mkdirSync(join(dir, 'emptykw'), { recursive: true })
    writeFileSync(join(dir, 'emptykw', 'card.md'), [
      '---',
      'name: EmptyKW',
      'motto: test',
      "keywords: ['']",
      "toolWhitelist: ['read_file']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0, 'should not load domain with empty-string keywords')
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /keywords must contain at least one non-empty string/)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  test("toolWhitelist:[''] → rejected (empty string filtered)", () => {
    const dir = join(tmpBase, 'test-empty-wl')
    mkdirSync(join(dir, 'emptywl'), { recursive: true })
    writeFileSync(join(dir, 'emptywl', 'card.md'), [
      '---',
      'name: EmptyWL',
      'motto: test',
      "keywords: ['test']",
      "toolWhitelist: ['']",
      '---',
      '',
      'suffix',
    ].join('\n'))

    try {
      const reg = new StarDomainRegistry()
      const { loaded, errors } = reg.loadFromDirectory(dir)
      assert.equal(loaded.length, 0, 'should not load domain with empty-string toolWhitelist')
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /toolWhitelist must contain at least one non-empty string/)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})

// ─── P1-1 matchDomain unified: custom domain visible at runtime ──
describe('P1-1 — custom domain visible to runtime matchDomain', () => {
  test('runtime matchDomain (star-domain.ts delegate) sees custom domain in singleton registry', async () => {
    const tmpBase = join(tmpdir(), `rivet-p11-test-${Date.now()}`)
    const dir = join(tmpBase, 'test-rt-match')
    mkdirSync(join(dir, 'machao'), { recursive: true })
    writeFileSync(join(dir, 'machao', 'card.md'), [
      '---',
      'name: 马超',
      'motto: 长驱直入',
      "keywords: ['penetration', '渗透', '安全测试']",
      "toolWhitelist: ['read_file', 'bash', 'grep']",
      '---',
      '',
      '突击手',
    ].join('\n'))

    try {
      // Load into the GLOBAL singleton — this is what runtime matchDomain delegates to
      const { loaded } = starDomainRegistry.loadFromDirectory(dir)
      assert.ok(loaded.includes('machao'))

      // Use dynamic ESM import to get the runtime matchDomain (same as dispatcher.ts uses)
      const { matchDomain: runtimeMatchDomain } = await import('../star-domain.js')

      const match = runtimeMatchDomain('进行网络渗透安全测试')
      assert.equal(match, 'machao', 'runtime matchDomain (star-domain.ts) should see custom domain via registry singleton')
    } finally {
      // Cleanup: remove custom domain so it doesn't leak
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ;(starDomainRegistry as unknown as { domains: Map<string, unknown> }).domains.delete('machao')
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})
