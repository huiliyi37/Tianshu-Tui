import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createCcrHook, _RULES_FOR_TESTING, _fillTemplate, _isTestIntent } from '../hooks/cognitive-capsule-router.js'
import type { AdvisoryEntry } from '../advisory-bus.js'
import type { EvidenceState } from '../evidence.js'
import type { RuntimeHookContext, RuntimeHookSnapshot } from '../runtime-hooks.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'

// ─── Helpers ─────────────────────────────────────────────────────

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    confidence: 1.0,
    complexity: 0.3,
    momentum: 0.5,
    stability: 0.8,
    freshness: 0.9,
    pressure: 0.1,
    ...overrides,
  }
}

function makeVigor(overrides: Partial<VigorState> = {}): VigorState {
  return {
    tonic: 0.7,
    phasic: 0.0,
    curiosity: 0.5,
    vigor: 0.8,
    variability: 0.1,
    history: [0.8],
    ...overrides,
  }
}

function makeEvidence(overrides: Partial<EvidenceState> = {}): EvidenceState {
  return {
    filesModified: new Set<string>(),
    filesRead: new Set<string>(),
    deliveryStatus: 'unverified',
    ...overrides,
  } as EvidenceState
}

function makeSnapshot(overrides: Partial<RuntimeHookSnapshot> = {}): RuntimeHookSnapshot {
  return {
    cwd: '/test',
    turn: 5,
    recentToolHistory: [],
    sensorium: makeSensorium(),
    strategy: null,
    vigor: makeVigor(),
    gitChangeRate: 0,
    season: null,
    ...overrides,
  }
}

interface TestHarness {
  submitted: AdvisoryEntry[]
  convergenceTriggered: boolean
  evidence: EvidenceState
  run: (snapshot: RuntimeHookSnapshot) => void
}

function createHarness(evidenceOverrides: Partial<EvidenceState> = {}): TestHarness {
  const submitted: AdvisoryEntry[] = []
  let convergenceTriggered = false
  const evidence = makeEvidence(evidenceOverrides)

  const hook = createCcrHook({
    advisoryBus: {
      submit(entry: AdvisoryEntry) { submitted.push(entry) },
    },
    wasConvergenceTriggered: () => convergenceTriggered,
    getEvidenceState: () => evidence,
  })

  return {
    submitted,
    get convergenceTriggered() { return convergenceTriggered },
    set convergenceTriggered(v: boolean) { convergenceTriggered = v },
    evidence,
    run(snapshot: RuntimeHookSnapshot) {
      const ctx: RuntimeHookContext = {
        snapshot,
        effects: {
          setSensorium() {},
          setStrategy() {},
          setVigor() {},
          setGitChangeRate() {},
          injectUserMessage() {},
          requestThetaCheck() {},
          emitPhaseChange() {},
          emitDecisionShift() {},
          markClaimStale() {},
        },
      }
      hook.run(ctx)
    },
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('CognitiveCapsuleRouter', () => {
  describe('fillTemplate', () => {
    it('replaces known variables', () => {
      const result = _fillTemplate('modified {files_modified} files at turn {turn}', {
        files_modified: 3,
        turn: 7,
      })
      assert.equal(result, 'modified 3 files at turn 7')
    })

    it('leaves unknown variables as-is', () => {
      const result = _fillTemplate('{known} and {unknown}', { known: 'yes' })
      assert.equal(result, 'yes and {unknown}')
    })
  })

  describe('isTestIntent', () => {
    it('detects run_tests tool', () => {
      assert.equal(_isTestIntent('run_tests', 'src/foo.ts'), true)
    })

    it('detects test in target', () => {
      assert.equal(_isTestIntent('read_file', 'src/__tests__/foo.test.ts'), true)
    })

    it('detects edit tools (likely about to test)', () => {
      assert.equal(_isTestIntent('edit_file', 'src/foo.ts'), true)
    })

    it('returns false for read_file on non-test target', () => {
      assert.equal(_isTestIntent('read_file', 'src/foo.ts'), false)
    })
  })

  describe('convergence mutual exclusion', () => {
    it('does not fire when convergence is triggered', () => {
      const h = createHarness({ filesModified: new Set(['a', 'b', 'c']) })
      h.convergenceTriggered = true
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.1 }),
      }))
      assert.equal(h.submitted.length, 0)
    })
  })

  describe('P1: 瑶光 — low verification coverage', () => {
    it('fires when verif_cov < 0.3 and turn > 3', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【瑶光】'))
      assert.equal(h.submitted[0]!.category, 'discipline')
    })

    it('does not fire at turn 2', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 2,
        sensorium: makeSensorium({ confidence: 0.1 }),
      }))
      assert.equal(h.submitted.length, 0)
    })

    it('is suppressed when last tool is run_tests', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        recentToolHistory: [{ tool: 'run_tests', status: 'success', target: 'src/test.ts' }],
      }))
      assert.equal(h.submitted.length, 0)
    })
  })

  describe('P3 vs P1 priority: dual-deficit routes to 天权', () => {
    it('routes to 天权 when both verif_cov and vigor are low', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts', 'c.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.15 }),
        vigor: makeVigor({ vigor: 0.2 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【天权】'))
      assert.match(h.submitted[0]!.key, /ccr-天权-P3/)
    })

    it('routes to 瑶光 when verif_cov low but vigor normal', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts', 'c.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.15 }),
        vigor: makeVigor({ vigor: 0.7 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【瑶光】'))
      assert.match(h.submitted[0]!.key, /ccr-瑶光-P1/)
    })
  })

  describe('P2: 天璇 — low freshness', () => {
    it('fires when freshness < 0.25 and turn > 4', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 6,
        sensorium: makeSensorium({ freshness: 0.15 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【天璇】'))
      assert.equal(h.submitted[0]!.priority, 0.60)
    })
  })

  describe('P4: 天权 — high complexity', () => {
    it('fires when complexity > 0.7 and turn > 3', () => {
      const h = createHarness({ filesModified: new Set(['a', 'b', 'c', 'd']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ complexity: 0.85 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【天权】'))
      assert.match(h.submitted[0]!.key, /ccr-天权-P4/)
    })
  })

  describe('P5: 瑶光 — large diff unverified', () => {
    it('fires when files_modified > 5 and verif_cov < 0.5', () => {
      const files = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
      const h = createHarness({ filesModified: files })
      h.run(makeSnapshot({
        turn: 3,
        sensorium: makeSensorium({ confidence: 0.4 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【瑶光】'))
      assert.match(h.submitted[0]!.key, /ccr-瑶光-P5/)
    })
  })

  describe('P6: 天府 — low stability', () => {
    it('fires when stability < 0.2 and turn > 3', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ stability: 0.1 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【天府】'))
    })
  })

  describe('cooldown', () => {
    it('does not fire same star within cooldown window', () => {
      const h = createHarness()
      const snapshot = makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ freshness: 0.15 }),
      })
      h.run(snapshot)
      assert.equal(h.submitted.length, 1, 'first trigger')

      h.run(makeSnapshot({
        turn: 6,
        sensorium: makeSensorium({ freshness: 0.15 }),
      }))
      assert.equal(h.submitted.length, 1, 'blocked by cooldown')
    })

    it('fires again after cooldown expires', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ freshness: 0.15 }),
      }))
      assert.equal(h.submitted.length, 1)

      h.run(makeSnapshot({
        turn: 10, // 5 turns later, cooldown=4 for 天璇
        sensorium: makeSensorium({ freshness: 0.15 }),
      }))
      assert.equal(h.submitted.length, 2)
    })

    it('allows escalation override when value degrades to 50%', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ freshness: 0.2 }),
      }))
      assert.equal(h.submitted.length, 1)

      // Turn 7, within cooldown (4), but freshness degraded from 0.2 to 0.05 (<0.1)
      h.run(makeSnapshot({
        turn: 7,
        sensorium: makeSensorium({ freshness: 0.05 }),
      }))
      assert.equal(h.submitted.length, 2, 'escalation override')
    })
  })

  describe('shared star cooldown across rules', () => {
    it('P1 trigger puts P5 in cooldown (same star 瑶光)', () => {
      const files = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
      const h = createHarness({ filesModified: files })

      // P1 fires (verif_cov < 0.3, vigor normal)
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.match(h.submitted[0]!.key, /P1/)

      // P5 would match (files>5, verif<0.5) but 瑶光 in cooldown
      h.run(makeSnapshot({
        turn: 6,
        sensorium: makeSensorium({ confidence: 0.4 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      // P5 blocked by 瑶光 cooldown, but P4 or P2 might fire depending on values
      const p5Entries = h.submitted.filter(e => e.key.includes('P5'))
      assert.equal(p5Entries.length, 0, 'P5 blocked by shared 瑶光 cooldown')
    })
  })

  describe('one reminder per turn', () => {
    it('only submits one advisory even when multiple rules match', () => {
      const files = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
      const h = createHarness({ filesModified: files })
      h.run(makeSnapshot({
        turn: 6,
        sensorium: makeSensorium({
          confidence: 0.1,
          freshness: 0.1,
          stability: 0.1,
          complexity: 0.9,
        }),
        vigor: makeVigor({ vigor: 0.1 }),
      }))
      assert.equal(h.submitted.length, 1, 'exactly one advisory per turn')
    })
  })

  describe('no sensorium → no-op', () => {
    it('does nothing when sensorium is null', () => {
      const h = createHarness()
      h.run(makeSnapshot({ sensorium: null }))
      assert.equal(h.submitted.length, 0)
    })
  })

  describe('template variables', () => {
    it('fills files_modified and turn in advisory content', () => {
      const h = createHarness({ filesModified: new Set(['a', 'b', 'c']) })
      h.run(makeSnapshot({
        turn: 7,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.includes('3 个文件'))
    })
  })
})
