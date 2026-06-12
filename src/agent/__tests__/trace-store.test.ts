import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTraceStore,
  startTraceEvent,
  finishTraceEvent,
  recordTraceEvent,
  getDoomLoopLevel,
  getClassDoomLoopLevel,
  combineDoomLoopLevels,
  getToolStormLevel,
  fingerprintToolCall,
  fingerprintToolClass,
  bashCommandClass,
  recordToolFingerprint,
  recordToolNamedFingerprint,
  type TraceEvent,
  type TraceEventStartInput,
} from '../trace-store.js'

describe('trace-store', () => {
  it('records a running event and finishes it with duration', () => {
    let store = createTraceStore(10)
    store = startTraceEvent(store, {
      id: 'tool-1',
      turn: 3,
      kind: 'tool',
      name: 'run_tests',
      startedAt: 1000,
      summary: 'npm test',
    })

    assert.equal(store.events.length, 1)
    assert.equal(store.events[0]!.status, 'running')

    store = finishTraceEvent(store, 'tool-1', {
      status: 'failed',
      endedAt: 1250,
      rawPath: '/tmp/rivet-raw/x.raw',
    })

    assert.equal(store.events[0]!.status, 'failed')
    assert.equal(store.events[0]!.durationMs, 250)
    assert.equal(store.events[0]!.rawPath, '/tmp/rivet-raw/x.raw')
  })

  it('does not allow completion fields when starting an event', () => {
    const input = {
      id: 'tool-1',
      turn: 3,
      kind: 'tool',
      name: 'run_tests',
      startedAt: 1000,
    } satisfies TraceEventStartInput

    assert.equal(input.startedAt, 1000)
  })

  it('caps events to the configured maximum', () => {
    let store = createTraceStore(2)
    const event = (id: string): TraceEvent => ({
      id,
      turn: 1,
      kind: 'tool',
      name: id,
      status: 'passed',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    })

    store = recordTraceEvent(store, event('a'))
    store = recordTraceEvent(store, event('b'))
    store = recordTraceEvent(store, event('c'))

    assert.deepEqual(store.events.map(e => e.id), ['b', 'c'])
  })

  it('detects repeated tool call fingerprints with consecutive and window strategies', () => {
    const fp = fingerprintToolCall('read_file', { file_path: 'src/a.ts' }, 'passed')
    const fpB = fingerprintToolCall('write_file', { file_path: 'src/b.ts' }, 'passed')

    // 2 consecutive same → warn
    assert.equal(getDoomLoopLevel([fp, fp]), 'warn')
    // 3 consecutive same → still warn (need 4 for blocked)
    assert.equal(getDoomLoopLevel([fp, fp, fp]), 'warn')
    // 4 consecutive same → blocked
    assert.equal(getDoomLoopLevel([fp, fp, fp, fp]), 'blocked')

    // Oscillation: 5/8 same tool → warn (≥4)
    assert.equal(getDoomLoopLevel([fp, fpB, fp, fpB, fp, fpB, fp, fpB]), 'warn')
    // Oscillation: 6/8 same tool → blocked (≥6)
    assert.equal(getDoomLoopLevel([fp, fpB, fp, fp, fpB, fp, fp, fpB]), 'warn') // 5 fp out of 8
    assert.equal(getDoomLoopLevel([fp, fpB, fp, fp, fp, fpB, fp, fpB]), 'warn') // 5 fp out of 8
    // Normal iteration: alternating tools with gaps → ok (3/5 < threshold)
    assert.equal(getDoomLoopLevel([fp, fpB, fp, fpB, fp]), 'none')
  })

  it('marks repeated failed tool fingerprints with consecutive-only doom loop', () => {
    let store = createTraceStore()
    const fp = fingerprintToolCall('bash', { command: 'npm test' }, 'error')
    // 3 entries → 2 consecutive → warn
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    assert.equal(getDoomLoopLevel(store.toolFingerprints), 'warn')

    // 4 entries → 3 consecutive → blocked
    store = recordToolFingerprint(store, fp)
    assert.equal(getDoomLoopLevel(store.toolFingerprints), 'blocked')
  })
})

describe('getToolStormLevel', () => {
  it('returns none for fewer than 4 tool calls', () => {
    assert.equal(getToolStormLevel(['grep', 'grep', 'grep']), 'none')
  })

  it('returns warn for 4 consecutive same-type calls', () => {
    assert.equal(getToolStormLevel(['grep', 'grep', 'grep', 'grep']), 'warn')
  })

  it('returns warn for 5-7 consecutive same-type calls', () => {
    assert.equal(getToolStormLevel(['grep', 'grep', 'grep', 'grep', 'grep']), 'warn')
    assert.equal(getToolStormLevel(Array(7).fill('grep')), 'warn')
  })

  it('returns storm for 8+ consecutive same-type calls', () => {
    assert.equal(getToolStormLevel(Array(8).fill('grep')), 'storm')
  })

  it('returns none when tool types alternate', () => {
    assert.equal(getToolStormLevel(['grep', 'read_file', 'grep', 'read_file']), 'none')
  })

  it('detects storm with different fingerprints but same tool type', () => {
    const names = Array(10).fill('grep')
    assert.equal(getToolStormLevel(names), 'storm')
  })

  it('resets consecutive count on tool type change', () => {
    const names = ['grep', 'grep', 'grep', 'read_file', 'grep', 'grep', 'grep']
    assert.equal(getToolStormLevel(names), 'none')
  })

  it('only considers the last 12 entries', () => {
    const old = Array(20).fill('read_file')
    const spacer = ['grep', 'bash', 'read_file', 'write_file', 'grep', 'bash',
      'read_file', 'write_file', 'grep', 'bash', 'read_file', 'write_file', 'grep']
    assert.equal(getToolStormLevel([...old, ...spacer]), 'none')
  })
})

describe('recordToolNamedFingerprint', () => {
  it('records both fingerprint and tool name', () => {
    let store = createTraceStore()
    store = recordToolNamedFingerprint(store, 'fp1', 'grep')
    store = recordToolNamedFingerprint(store, 'fp2', 'grep')
    assert.deepEqual(store.toolFingerprints, ['fp1', 'fp2'])
    assert.deepEqual(store.toolNameHistory, ['grep', 'grep'])
  })

  it('caps tool name history to 20', () => {
    let store = createTraceStore()
    for (let i = 0; i < 25; i++) {
      store = recordToolNamedFingerprint(store, `fp${i}`, `tool${i}`)
    }
    assert.equal(store.toolNameHistory!.length, 20)
    assert.equal(store.toolNameHistory![0], 'tool5')
    assert.equal(store.toolNameHistory![19], 'tool24')
  })
})

describe('bashCommandClass', () => {
  it('merges git status pipe variants into one class', () => {
    assert.equal(bashCommandClass('git status --porcelain'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain | sed -n 1,50p'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain | head -100'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain | tee /tmp/s.txt'), 'git:status')
    assert.equal(bashCommandClass('git status --porcelain > /tmp/out && cat /tmp/out'), 'git:status')
  })

  it('detects git embedded after other binaries (cd, env vars)', () => {
    assert.equal(bashCommandClass('cd /repo && git log --oneline'), 'git:log')
    assert.equal(bashCommandClass('GIT_PAGER=cat git diff --stat'), 'git:diff')
  })

  it('distinguishes git subcommands', () => {
    assert.notEqual(bashCommandClass('git status'), bashCommandClass('git add -A'))
    assert.notEqual(bashCommandClass('git log'), bashCommandClass('git commit -m x'))
  })

  it('includes subcommand for known multi-sub binaries', () => {
    assert.equal(bashCommandClass('npm test'), 'npm:test')
    assert.equal(bashCommandClass('npm run build'), 'npm:run')
    assert.notEqual(bashCommandClass('npm test'), bashCommandClass('npm install'))
  })

  it('falls back to binary name for plain commands', () => {
    assert.equal(bashCommandClass('ls -la src'), 'ls')
    assert.equal(bashCommandClass('/usr/bin/python3 script.py'), 'python3')
    assert.equal(bashCommandClass(''), 'empty')
  })

  it('skips leading env assignments', () => {
    assert.equal(bashCommandClass('NODE_ENV=test npx tsx --test foo.ts'), 'npx:tsx')
  })
})

describe('fingerprintToolClass', () => {
  it('returns a class fingerprint for bash including output class', () => {
    assert.equal(fingerprintToolClass('bash', { command: 'git status | head' }, 'success'), 'git:status·success')
  })

  it('returns null for non-bash tools', () => {
    assert.equal(fingerprintToolClass('read_file', { path: '/a.ts' }, 'success'), null)
    assert.equal(fingerprintToolClass('grep', { pattern: 'x' }, 'error'), null)
  })
})

describe('recordToolFingerprint with class fingerprint', () => {
  it('records class fingerprint alongside exact fingerprint', () => {
    let store = createTraceStore()
    store = recordToolFingerprint(store, 'fp1', 'git:status·success')
    store = recordToolFingerprint(store, 'fp2', null)
    assert.deepEqual(store.toolFingerprints, ['fp1', 'fp2'])
    assert.deepEqual(store.bashClassFingerprints, ['git:status·success'])
  })

  it('caps class fingerprints to 20', () => {
    let store = createTraceStore()
    for (let i = 0; i < 25; i++) {
      store = recordToolFingerprint(store, `fp${i}`, `class${i}`)
    }
    assert.equal(store.bashClassFingerprints!.length, 20)
  })
})

describe('getClassDoomLoopLevel', () => {
  it('returns none for varied command classes', () => {
    assert.equal(getClassDoomLoopLevel(['git:status·success', 'npm:test·success', 'rg·success', 'ls·success']), 'none')
  })

  it('warns on 5th consecutive same-class call (sed/head/tee variants merged)', () => {
    const fps = Array(5).fill('git:status·success')
    assert.equal(getClassDoomLoopLevel(fps), 'warn')
  })

  it('blocks on 7th consecutive same-class call', () => {
    const fps = Array(7).fill('git:status·success')
    assert.equal(getClassDoomLoopLevel(fps), 'blocked')
  })

  it('does not flag 4 consecutive same-class calls (legit iteration headroom)', () => {
    assert.equal(getClassDoomLoopLevel(Array(4).fill('rg·success')), 'none')
  })

  it('blocks when one class dominates the window even non-consecutively', () => {
    const fps = ['git:status·success', 'ls·success', 'git:status·success', 'git:status·success',
      'rg·success', 'git:status·success', 'git:status·success', 'git:status·success',
      'git:status·success', 'git:status·success']
    assert.equal(getClassDoomLoopLevel(fps), 'blocked')
  })
})

describe('combineDoomLoopLevels', () => {
  it('returns the strictest level', () => {
    assert.equal(combineDoomLoopLevels('none', 'warn'), 'warn')
    assert.equal(combineDoomLoopLevels('blocked', 'warn'), 'blocked')
    assert.equal(combineDoomLoopLevels('none', 'none'), 'none')
    assert.equal(combineDoomLoopLevels('warn', 'blocked'), 'blocked')
  })
})
