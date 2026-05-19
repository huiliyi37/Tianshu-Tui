import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderAvatar, idleMoodOverride } from '../avatar-renderer.js'
import type { AvatarContext } from '../types.js'

describe('idleMoodOverride', () => {
  it('returns greeting for first turn with idleSeconds 0', () => {
    const mood = idleMoodOverride('calm', 1, 0)
    assert.equal(mood, 'greeting')
  })

  it('returns calm mood when idleSeconds < 30', () => {
    const mood = idleMoodOverride('calm', 5, 10)
    assert.equal(mood, 'calm')
  })

  it('returns searching when idleSeconds >= 30', () => {
    const mood = idleMoodOverride('calm', 5, 30)
    assert.equal(mood, 'searching')
  })

  it('returns confused when idleSeconds >= 60', () => {
    const mood = idleMoodOverride('calm', 5, 60)
    assert.equal(mood, 'confused')
  })

  it('does not override non-calm moods', () => {
    const mood = idleMoodOverride('focused', 5, 60)
    assert.equal(mood, 'focused')
  })

  it('does not override when stuck', () => {
    const mood = idleMoodOverride('confused', 5, 0)
    assert.equal(mood, 'confused')
  })
})

describe('renderAvatar', () => {
  it('renders a complete avatar frame', () => {
    const ctx: AvatarContext = {
      phase: 'tianshu-planning',
      alchemy: 'nigredo',
      domain: null,
      mood: 'calm',
      mode: 'wenxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.ok(result.lines.length > 0)
    assert.ok(result.width > 0)
  })

  it('renders wenxing mode with wenxing seal', () => {
    const ctx: AvatarContext = {
      phase: 'tianshu-planning',
      alchemy: 'albedo',
      domain: null,
      mood: 'calm',
      mode: 'wenxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.ok(result.lines[0]!.includes('文'))
    assert.ok(result.lines[1]!.includes('星'))
  })

  it('renders wuxing mode with wuxing seal', () => {
    const ctx: AvatarContext = {
      phase: 'yuheng-implementing',
      alchemy: 'citrinitas',
      domain: null,
      mood: 'focused',
      mode: 'wuxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.ok(result.lines[0]!.includes('武'))
    assert.ok(result.lines[1]!.includes('曲'))
  })

  it('includes domain badge when domain is set', () => {
    const ctx: AvatarContext = {
      phase: 'yuheng-implementing',
      alchemy: 'citrinitas',
      domain: 'pojun',
      mood: 'focused',
      mode: 'wuxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    const joined = result.lines.join('')
    assert.ok(joined.includes('⚔'))
  })

  it('uses tianxu seal for encore', () => {
    const ctx: AvatarContext = {
      phase: 'tianshu-encore',
      alchemy: 'albedo',
      domain: null,
      mood: 'serious',
      mode: 'wenxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.ok(result.lines[0]!.includes('天'))
    assert.ok(result.lines[1]!.includes('枢'))
  })

  it('uses star seal for delivering', () => {
    const ctx: AvatarContext = {
      phase: 'yaoguang-delivering',
      alchemy: 'rubedo',
      domain: null,
      mood: 'content',
      mode: 'wenxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.ok(result.lines[0]!.includes('✦'))
  })

  it('blinks on tick divisible by 20', () => {
    const ctx: AvatarContext = {
      phase: 'tianshu-planning',
      alchemy: 'nigredo',
      domain: null,
      mood: 'calm',
      mode: 'wenxing',
      tick: 20,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.ok(result.lines[3]!.includes('─'))
  })

  it('does not blink on other ticks', () => {
    const ctx: AvatarContext = {
      phase: 'tianshu-planning',
      alchemy: 'nigredo',
      domain: null,
      mood: 'calm',
      mode: 'wenxing',
      tick: 19,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.ok(result.lines[3]!.includes('◠'))
  })

  it('returns AvatarContext with correct metadata', () => {
    const ctx: AvatarContext = {
      phase: 'tianshu-planning',
      alchemy: 'nigredo',
      domain: null,
      mood: 'calm',
      mode: 'wenxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.equal(result.phase, 'tianshu-planning')
    assert.equal(result.mode, 'wenxing')
    // Note: mood is overridden to 'greeting' for first turn
    assert.equal(result.mood, 'greeting')
  })

  it('applies idle mood override for first turn', () => {
    const ctx: AvatarContext = {
      phase: 'tianshu-planning',
      alchemy: 'nigredo',
      domain: null,
      mood: 'calm',
      mode: 'wenxing',
      tick: 1,
      isStuck: false,
      isTestFailing: 0,
      idleSeconds: 0,
    }
    const result = renderAvatar(ctx)
    assert.equal(result.mood, 'greeting')
    assert.ok(result.lines[3]!.includes('▽'))
  })
})
