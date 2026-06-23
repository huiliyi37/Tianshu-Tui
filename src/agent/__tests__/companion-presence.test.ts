import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPresence, writePresence, formatPresenceForAppendix, type CompanionPresenceEntry } from '../companion-presence.js'

const TMP = join(process.cwd(), '.test-tmp', 'companion-presence-test')

describe('companion-presence', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(join(TMP, '.rivet'), { recursive: true })
  })
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  describe('loadPresence', () => {
    it('returns empty when no file exists', () => {
      const result = loadPresence(TMP)
      assert.deepStrictEqual(result, [])
    })

    it('returns empty for corrupted JSON', () => {
      writeFileSync(join(TMP, '.rivet', 'presence.json'), '{broken}')
      const result = loadPresence(TMP)
      assert.deepStrictEqual(result, [])
    })

    it('filters expired entries (>5 minutes)', () => {
      const entries: CompanionPresenceEntry[] = [
        { sessionId: 'old', starDomain: 'tianliang', objective: 'done', updatedAt: Date.now() - 6 * 60_000 },
        { sessionId: 'fresh', starDomain: 'tianshu', objective: 'working', updatedAt: Date.now() - 1000 },
      ]
      writeFileSync(join(TMP, '.rivet', 'presence.json'), JSON.stringify(entries))
      const result = loadPresence(TMP)
      assert.equal(result.length, 1)
      assert.equal(result[0]!.sessionId, 'fresh')
    })

    it('excludes own session', () => {
      const entries: CompanionPresenceEntry[] = [
        { sessionId: 'self', starDomain: 'tianshu', objective: 'test', updatedAt: Date.now() },
        { sessionId: 'other', starDomain: 'tianquan', objective: 'review', updatedAt: Date.now() },
      ]
      writeFileSync(join(TMP, '.rivet', 'presence.json'), JSON.stringify(entries))
      const result = loadPresence(TMP, 'self')
      assert.equal(result.length, 1)
      assert.equal(result[0]!.sessionId, 'other')
    })
  })

  describe('writePresence', () => {
    it('creates presence file from scratch', () => {
      writePresence(TMP, {
        sessionId: 's1',
        starDomain: 'tianshu',
        objective: 'implement feature',
        updatedAt: Date.now(),
      })
      assert.ok(existsSync(join(TMP, '.rivet', 'presence.json')))
      const loaded = loadPresence(TMP)
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.sessionId, 's1')
    })

    it('updates existing session entry', () => {
      const now = Date.now()
      writePresence(TMP, { sessionId: 's1', starDomain: 'tianshu', objective: '(active task)', updatedAt: now - 10_000 })
      writePresence(TMP, { sessionId: 's1', starDomain: 'tianshu', objective: '(follow-up)', updatedAt: now })
      const loaded = loadPresence(TMP)
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.objective, '(follow-up)')
    })

    it('appends new session without overwriting others', () => {
      const now = Date.now()
      writePresence(TMP, { sessionId: 's1', starDomain: 'tianshu', objective: 'a', updatedAt: now })
      writePresence(TMP, { sessionId: 's2', starDomain: 'tianquan', objective: 'b', updatedAt: now })
      const loaded = loadPresence(TMP)
      assert.equal(loaded.length, 2)
    })

    it('sanitizes worker protocol fragments at write time', () => {
      writePresence(TMP, {
        sessionId: 'worker-1',
        starDomain: '天梁',
        objective: 'Repair the previous answer so it is exactly one valid WorkerResult JSON object.',
        updatedAt: Date.now(),
      })
      const loaded = loadPresence(TMP)
      assert.equal(loaded[0]!.objective, '(internal)', 'protocol fragment should be sanitized at write time')
    })

    it('strips angle brackets at write time to prevent XML injection', () => {
      writePresence(TMP, {
        sessionId: 's1',
        starDomain: '天枢',
        objective: 'Fix <script>alert(1)</script> bug',
        updatedAt: Date.now(),
      })
      const loaded = loadPresence(TMP)
      assert.ok(!loaded[0]!.objective.includes('<'), 'angle brackets must be stripped at write time')
    })

    it('redacts user message text at write time to prevent cross-session leakage', () => {
      writePresence(TMP, {
        sessionId: 's1',
        starDomain: '天枢',
        objective: '审查 loop.ts 的超时逻辑',
        updatedAt: Date.now(),
      })
      const loaded = loadPresence(TMP)
      // User message text must never appear in presence.json — only safe labels.
      assert.equal(loaded[0]!.objective, '(active)')
      assert.ok(!loaded[0]!.objective.includes('审查'), 'user message text must not leak into presence store')
    })
  })

  describe('formatPresenceForAppendix', () => {
    it('returns empty string for no companions', () => {
      assert.equal(formatPresenceForAppendix([]), '')
    })

    it('formats companion entries as XML block', () => {
      const now = Date.now()
      const entries: CompanionPresenceEntry[] = [
        { sessionId: 's1', starDomain: '天梁', objective: '审查 loop.ts', updatedAt: now - 2 * 60_000, cognitiveState: { vigor: 0.7, stability: 0.85, season: 'summer' } },
      ]
      const result = formatPresenceForAppendix(entries)
      assert.ok(result.includes('<companion-presence>'))
      assert.ok(result.includes('</companion-presence>'))
      assert.ok(result.includes('天梁域'))
      assert.ok(result.includes('审查 loop.ts'))
      assert.ok(result.includes('stability 0.85'))
    })

    it('format trusts pre-sanitized data from writePresence', () => {
      // sanitizer is at write time now; formatPresenceForAppendix passes through.
      // Verify it does NOT re-sanitize (no double-filter needed).
      const now = Date.now()
      const entries: CompanionPresenceEntry[] = [
        { sessionId: 's1', starDomain: '天枢', objective: '正常 objective', updatedAt: now },
      ]
      const result = formatPresenceForAppendix(entries)
      assert.ok(result.includes('正常 objective'))
    })
  })
})
