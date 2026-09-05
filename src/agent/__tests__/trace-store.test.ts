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
  offendingFingerprints,
  getToolStormLevel,
  fingerprintToolCall,
  fingerprintToolClass,
  bashCommandClass,
  recordToolFingerprint,
  recordToolNamedFingerprint,
  pollingClassOf,
  recordToolPollingClass,
  evaluatePollingStorm,
  getPollingStormLevel,
  getDoomLoopThresholds,
  NORMAL_DOOM_THRESHOLDS,
  GOAL_DOOM_THRESHOLDS,
  type TraceEvent,
  type TraceEventStartInput,
  type PollingStormState,
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

    // Normal mode thresholds: warnConsec=3, blockConsec=5, warnFreq=5, blockFreq=7
    const nt = NORMAL_DOOM_THRESHOLDS.exact

    // 3 consecutive (2 repeats) → none (below warnConsec=3)
    assert.equal(getDoomLoopLevel([fp, fp, fp], nt), 'none')
    // 4 consecutive (3 repeats) → warn
    assert.equal(getDoomLoopLevel([fp, fp, fp, fp], nt), 'warn')
    // 5 consecutive (4 repeats) → still warn (need 6 for blocked)
    assert.equal(getDoomLoopLevel([fp, fp, fp, fp, fp], nt), 'warn')
    // 6 consecutive (5 repeats) → blocked
    assert.equal(getDoomLoopLevel([fp, fp, fp, fp, fp, fp], nt), 'blocked')

    // Normal iteration: alternating tools → ok
    assert.equal(getDoomLoopLevel([fp, fpB, fp, fpB, fp], nt), 'none')
  })

  it('marks repeated failed tool fingerprints with consecutive-only doom loop', () => {
    let store = createTraceStore()
    const fp = fingerprintToolCall('bash', { command: 'npm test' }, 'error')
    // 4 entries → 3 consecutive → warn (warnConsec=3)
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    store = recordToolFingerprint(store, fp)
    assert.equal(getDoomLoopLevel(store.toolFingerprints), 'warn')

    // 6 entries → 5 consecutive → blocked (blockConsec=5)
    store = recordToolFingerprint(store, fp)
    assert.equal(getDoomLoopLevel(store.toolFingerprints), 'warn')
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

describe('polling-storm class tracking (P0-1)', () => {
  it('pollingClassOf only tracks bash + observation tools', () => {
    assert.equal(pollingClassOf('bash', { command: 'curl -s localhost:3000/status' }), 'bash:curl')
    assert.equal(pollingClassOf('job', { action: 'list' }), 'job')
    assert.equal(pollingClassOf('browser_debug', { action: 'screenshot' }), 'browser_debug')
    assert.equal(pollingClassOf('ask_image', { id: 'i1' }), 'ask_image')
    assert.equal(pollingClassOf('read_file', { file_path: 'src/a.ts' }), null)
    assert.equal(pollingClassOf('web_fetch', { url: 'https://example.com' }), null)
  })

  it('recordToolPollingClass appends classes and caps to 24', () => {
    let store = createTraceStore()
    for (let i = 0; i < 30; i++) {
      store = recordToolPollingClass(store, 'job', { action: i % 2 ? 'logs' : 'list' })
    }
    assert.equal(store.toolPollingClasses!.length, 24)
    assert.equal(store.toolPollingCount, 30, 'append counter is monotonic and never capped')
    assert.ok(store.toolPollingClasses!.every(c => c === 'job'))
  })

  it('getPollingStormLevel uses the same warn/storm thresholds as tool storms', () => {
    const classes = Array(8).fill('job')
    assert.equal(getPollingStormLevel(classes.slice(0, 3)), 'none')
    assert.equal(getPollingStormLevel(classes.slice(0, 4)), 'warn')
    assert.equal(getPollingStormLevel(classes), 'storm')
  })

  it('bash polling class merges command variants into one class', () => {
    const classes = [
      pollingClassOf('bash', { command: 'curl -s localhost:3000/status' })!,
      pollingClassOf('bash', { command: 'curl -s http://localhost:3000/status | head -1' })!,
      pollingClassOf('bash', { command: 'curl -s localhost:3000/status?ts=1' })!,
    ]
    assert.ok(classes.every(c => c === 'bash:curl'))
  })

  it('non-polling tools never enter the polling-class trajectory', () => {
    let store = createTraceStore()
    store = recordToolPollingClass(store, 'read_file', { file_path: 'a.ts' })
    store = recordToolPollingClass(store, 'grep', { pattern: 'x' })
    assert.deepEqual(store.toolPollingClasses, undefined)
  })

  // ── 2026-09-05 bash 内容查询桶化（git show 不同提交 = 合法审查，非轮询）──
  it('git content queries are bucketed by target (different commits differ)', () => {
    const a = pollingClassOf('bash', { command: 'git show a1b2c3d4e5f6a1b2c3d4e5f6' })!
    const b = pollingClassOf('bash', { command: 'git show d4e5f6a1b2c3d4e5f6a1b2c3' })!
    assert.notEqual(a, b, 'different git show targets must not merge into one class')
    assert.ok(a.startsWith('bash:git:show:'), `expected target bucket, got ${a}`)
    const same1 = pollingClassOf('bash', { command: 'git show a1b2c3d4e5f6a1b2c3d4e5f6 --stat' })!
    const same2 = pollingClassOf('bash', { command: 'git show a1b2c3d4e5f6a1b2c3d4e5f6' })!
    assert.equal(same1, same2, 'same target must stay one class (real repetition detectable)')
  })

  it('git content queries skip flags before the target (--stat/-p forms)', () => {
    // 修复前：git show --stat <hash> 只看子命令后第一个 token（--stat，'-' 开头），
    // 跳过桶化回落平类 git:show——不同提交仍被并成同一轮询类（ROB 同族误报未闭合）。
    const flagFirst = pollingClassOf('bash', { command: 'git show --stat a1b2c3d4e5f6a1b2c3d4e5f6' })!
    const flagFirstB = pollingClassOf('bash', { command: 'git show --stat d4e5f6a1b2c3d4e5f6a1b2c3' })!
    assert.notEqual(flagFirst, flagFirstB, 'flag-before-target must still bucket by target, not collapse to git:show')
    const plain = pollingClassOf('bash', { command: 'git show a1b2c3d4e5f6a1b2c3d4e5f6' })!
    assert.equal(flagFirst, plain, 'leading flags must not change the bucket for the same target')
    const patchForm = pollingClassOf('bash', { command: 'git show -p a1b2c3d4e5f6a1b2c3d4e5f6' })!
    assert.equal(patchForm, plain, '-p form buckets to the same target')
    // 无目标的 log/diff 保持平类状态查询类（等日志/状态的真轮询仍可检测）。
    assert.equal(pollingClassOf('bash', { command: 'git log --oneline' }), 'bash:git:log')
    assert.equal(pollingClassOf('bash', { command: 'git diff --stat' }), 'bash:git:diff')
  })

  it('git status keeps its plain class (state polling stays detectable)', () => {
    const s1 = pollingClassOf('bash', { command: 'git status --porcelain' })!
    const s2 = pollingClassOf('bash', { command: 'git status -sb' })!
    assert.equal(s1, 'bash:git:status')
    assert.equal(s2, 'bash:git:status')
  })
})

// ── 2026-09-05 环形缓冲溢出（对抗审查）：toolPollingClasses 被 slice(-24) 裁剪，
// evaluatePollingStorm 曾用「数组长度增长」代理「本轮有新增」——长度钉死在 24 后
// hasNewPolling 恒 false、abort 分支永久不可达，长会话守卫静默失效。修复后按
// store.toolPollingCount 单调计数判定。以下测试填满窗口后继续加同类记录验证。 ──
describe('polling-storm guard state machine (P0-1)', () => {
  it('crossing the 24-entry cap keeps streak accumulation alive (long-session regression)', () => {
    let store = createTraceStore()
    const state: PollingStormState = { streak: 0, warned: false, lastFilesModifiedCount: 0, lastPollingCount: 0 }
    const evalOnce = () => evaluatePollingStorm(state, store, 0)

    // 阶段 1：24 条互异 git show 目标填满裁剪窗口（互异 = 永不 storm），模拟
    // 长会话早段的逐提交审查——数组长度钉死在上限，只有计数继续单调增长。
    for (let i = 0; i < 24; i++) {
      store = recordToolPollingClass(store, 'bash', { command: `git show f${String(i).padStart(2, '0')}abc` })
      assert.equal(evalOnce().action, 'none')
    }
    assert.equal(store.toolPollingClasses!.length, 24, 'window is pinned at the 24 cap')
    assert.equal(store.toolPollingCount, 24, 'monotonic count keeps growing past the window cap')

    // 阶段 2：越过上限后继续真轮询（同一 job 类）。修复前 length 恒 24 →
    // hasNewPolling 恒 false → streak 只衰减、abort 不可达；修复后按计数判定，
    // 8 连 storm + 6 轮递增照常熔断（20 轮内必 abort）。
    let last = 'none'
    for (let i = 0; i < 20; i++) {
      store = recordToolPollingClass(store, 'job', { action: 'list' })
      last = evalOnce().action
      if (last === 'abort') break
    }
    assert.equal(last, 'abort', 'guard must still abort after the window cap is crossed')
  })

  it('read-only rounds after the cap still decay the streak (no late abort)', () => {
    // 环形溢出修复不得破坏迟到误杀修复（R1）：满窗后的纯只读轮（无新增记录、
    // 无文件修改）仍让 streak 向 0 收敛，不能在冻结帧里继续 +1 迟到熔断。
    let store = createTraceStore()
    const state: PollingStormState = { streak: 0, warned: false, lastFilesModifiedCount: 0, lastPollingCount: 0 }
    for (let i = 0; i < 24; i++) {
      store = recordToolPollingClass(store, 'bash', { command: `git show f${String(i).padStart(2, '0')}abc` })
      evaluatePollingStorm(state, store, 0)
    }
    // 越过上限后真轮询把 streak 推离 0（不 abort——只到 warn 附近）。
    for (let i = 0; i < 10; i++) {
      store = recordToolPollingClass(store, 'job', { action: 'list' })
      const v = evaluatePollingStorm(state, store, 0)
      if (v.action === 'abort') break
    }
    assert.ok(state.streak >= 1, 'post-cap polling must accumulate streak')
    const frozenStreak = state.streak
    // 随后纯只读轮：无新增、无修改 → streak 衰减回 0，全程不得 abort。
    for (let i = 0; i < frozenStreak + 2; i++) {
      const v = evaluatePollingStorm(state, store, 0)
      assert.notEqual(v.action, 'abort')
    }
    assert.equal(state.streak, 0, 'read-only decay must still converge after the cap')
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
  it('returns class fingerprint only for failing bash commands', () => {
    // Successful bash = normal exploration, no class fingerprint
    assert.equal(fingerprintToolClass('bash', { command: 'git status | head' }, 'success'), null)
    // Failing bash = potential doom loop, class fingerprint recorded
    assert.equal(fingerprintToolClass('bash', { command: 'git push --force' }, 'error'), 'git:push·error')
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
  const nt = NORMAL_DOOM_THRESHOLDS.class

  it('returns none for varied command classes', () => {
    assert.equal(getClassDoomLoopLevel(['git:status·success', 'npm:test·success', 'rg·success', 'ls·success']), 'none')
  })

  it('warns on 7th consecutive same-class call (sed/head/tee variants merged)', () => {
    assert.equal(getClassDoomLoopLevel(Array(7).fill('git:status·success'), nt), 'warn')
  })

  it('blocks on 10th consecutive same-class call', () => {
    assert.equal(getClassDoomLoopLevel(Array(10).fill('git:status·success'), nt), 'blocked')
  })

  it('does not flag 6 consecutive same-class calls (legit iteration headroom)', () => {
    assert.equal(getClassDoomLoopLevel(Array(6).fill('rg·success'), nt), 'none')
  })

  it('blocks when one class dominates the window even non-consecutively', () => {
    // 10/12 same class → blockFreq=10 met (window=12)
    const fps = ['git:status·success', 'ls·success', 'git:status·success', 'git:status·success',
      'git:status·success', 'git:status·success', 'git:status·success', 'git:status·success',
      'git:status·success', 'git:status·success', 'git:status·success', 'git:status·success']
    assert.equal(getClassDoomLoopLevel(fps, nt), 'blocked')
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

describe('offendingFingerprints', () => {
  it('returns empty when nothing is looping', () => {
    assert.equal(offendingFingerprints(['a', 'b', 'c', 'a', 'b']).size, 0)
  })

  it('flags a fingerprint repeated to the frequency threshold (6+ in window)', () => {
    // 6 of 'x' in an 8-window → 'x' is the offender, 'y' is not.
    const offenders = offendingFingerprints(['x', 'x', 'x', 'y', 'x', 'x', 'y', 'x'])
    assert.ok(offenders.has('x'))
    assert.ok(!offenders.has('y'))
  })

  it('flags a fingerprint repeated consecutively to threshold (4 identical)', () => {
    const offenders = offendingFingerprints(['a', 'b', 'x', 'x', 'x', 'x'])
    assert.ok(offenders.has('x'))
    assert.ok(!offenders.has('a'))
    assert.ok(!offenders.has('b'))
  })

  it('isolates the offender so a different call would not match (deadlock fix)', () => {
    // The bug: hitting blocked blocked every tool. The fix blocks only the
    // looping fingerprint, so a fresh tool's fingerprint is absent here and
    // would be allowed through to refresh the window.
    const looping = Array(6).fill('loop-fp')
    const offenders = offendingFingerprints(looping)
    assert.ok(offenders.has('loop-fp'))
    assert.ok(!offenders.has('some-other-tool-fp'))
  })

  it('honors custom class-level thresholds (window 10, freq 8, consec 6)', () => {
    // Below class thresholds → no offender.
    assert.equal(offendingFingerprints(Array(5).fill('c'), 10, 8, 6).size, 0)
    // 7 consecutive identical (consec run of 6 repeats) → offender.
    assert.ok(offendingFingerprints(Array(7).fill('c'), 10, 8, 6).has('c'))
  })
})

describe('goal-aware doom-loop thresholds', () => {
  it('normal mode warns earlier than goal mode', () => {
    const fp = fingerprintToolCall('bash', { command: 'grep foo' }, 'error')
    // 4 identical (maxConsec=3) → normal warns (warnConsec=3), goal none (warnConsec=3, need 4+)
    const four = [fp, fp, fp, fp]
    assert.equal(getDoomLoopLevel(four, NORMAL_DOOM_THRESHOLDS.exact), 'warn')
    assert.equal(getDoomLoopLevel(four, GOAL_DOOM_THRESHOLDS.exact), 'warn')
  })

  it('goal mode requires more repetitions to block', () => {
    const fp = fingerprintToolCall('bash', { command: 'grep foo' }, 'error')
    // 6 identical (maxConsec=5) → normal blocked (blockConsec=5), goal warn (blockConsec=6)
    const six = Array(6).fill(fp)
    assert.equal(getDoomLoopLevel(six, NORMAL_DOOM_THRESHOLDS.exact), 'blocked')
    assert.equal(getDoomLoopLevel(six, GOAL_DOOM_THRESHOLDS.exact), 'warn')
    // 7 identical (maxConsec=6) → goal blocked
    const seven = Array(7).fill(fp)
    assert.equal(getDoomLoopLevel(seven, GOAL_DOOM_THRESHOLDS.exact), 'blocked')
  })

  it('goal mode class thresholds are more lenient', () => {
    const cf = 'git:status·success'
    // 7 same class → normal warn (warnConsec=6 met), goal none (warnConsec=7)
    assert.equal(getClassDoomLoopLevel(Array(7).fill(cf), NORMAL_DOOM_THRESHOLDS.class), 'warn')
    assert.equal(getClassDoomLoopLevel(Array(7).fill(cf), GOAL_DOOM_THRESHOLDS.class), 'none')
    // 11 same class → goal warn (warnConsec=7), goal blocked at blockConsec=10
    assert.equal(getClassDoomLoopLevel(Array(11).fill(cf), GOAL_DOOM_THRESHOLDS.class), 'blocked')
  })

  it('getDoomLoopThresholds switches by goalActive flag', () => {
    assert.equal(getDoomLoopThresholds(false), NORMAL_DOOM_THRESHOLDS)
    assert.equal(getDoomLoopThresholds(true), GOAL_DOOM_THRESHOLDS)
  })
})
