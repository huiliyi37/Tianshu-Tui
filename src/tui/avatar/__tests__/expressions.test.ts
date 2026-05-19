import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getFace, phaseToMood, phaseToMode } from '../expressions.js'
import type { StarPhase } from '../../../agent/star-event.js'

describe('phaseToMode', () => {
  it('returns wenxing for planning phases', () => {
    assert.equal(phaseToMode('tianshu-planning'), 'wenxing')
    assert.equal(phaseToMode('tianxuan-locating'), 'wenxing')
    assert.equal(phaseToMode('tianji-decomposing'), 'wenxing')
    assert.equal(phaseToMode('tianquan-contracting'), 'wenxing')
    assert.equal(phaseToMode('yaoguang-delivering'), 'wenxing')
  })

  it('returns wuxing for execution phases', () => {
    assert.equal(phaseToMode('yuheng-implementing'), 'wuxing')
    assert.equal(phaseToMode('kaiyang-testing'), 'wuxing')
  })

  it('returns wenxing for encore', () => {
    assert.equal(phaseToMode('tianshu-encore'), 'wenxing')
  })
})

describe('phaseToMood', () => {
  it('returns calm for planning', () => {
    assert.equal(phaseToMood('tianshu-planning', false, false), 'calm')
  })

  it('returns searching for locating', () => {
    assert.equal(phaseToMood('tianxuan-locating', false, false), 'searching')
  })

  it('returns focused for implementing', () => {
    assert.equal(phaseToMood('yuheng-implementing', false, false), 'focused')
  })

  it('returns focused for decomposing', () => {
    assert.equal(phaseToMood('tianji-decomposing', false, false), 'focused')
  })

  it('returns satisfied for contracting', () => {
    assert.equal(phaseToMood('tianquan-contracting', false, false), 'satisfied')
  })

  it('returns tense for testing', () => {
    assert.equal(phaseToMood('kaiyang-testing', false, false), 'tense')
  })

  it('returns content for delivering', () => {
    assert.equal(phaseToMood('yaoguang-delivering', false, false), 'content')
  })

  it('returns serious for encore', () => {
    assert.equal(phaseToMood('tianshu-encore', false, false), 'serious')
  })

  it('returns confused when stuck regardless of phase', () => {
    assert.equal(phaseToMood('yuheng-implementing', true, false), 'confused')
    assert.equal(phaseToMood('kaiyang-testing', true, false), 'confused')
    assert.equal(phaseToMood('tianshu-planning', true, false), 'confused')
  })

  it('returns surprised when test failing regardless of phase', () => {
    assert.equal(phaseToMood('kaiyang-testing', false, true), 'surprised')
    assert.equal(phaseToMood('yuheng-implementing', false, true), 'surprised')
  })

  it('stuck takes priority over test failing', () => {
    assert.equal(phaseToMood('kaiyang-testing', true, true), 'confused')
  })
})

describe('getFace', () => {
  it('returns correct face for calm mood', () => {
    const face = getFace('calm', 1)
    assert.equal(face.leftEye, '◠')
    assert.equal(face.mouth, '‿')
    assert.equal(face.rightEye, '◠')
  })

  it('returns correct face for searching mood', () => {
    const face = getFace('searching', 1)
    assert.equal(face.leftEye, '◉')
    assert.equal(face.mouth, '_')
    assert.equal(face.rightEye, '◉')
  })

  it('returns correct face for focused mood', () => {
    const face = getFace('focused', 1)
    assert.equal(face.leftEye, '●')
    assert.equal(face.mouth, '△')
    assert.equal(face.rightEye, '●')
  })

  it('returns correct face for satisfied mood', () => {
    const face = getFace('satisfied', 1)
    assert.equal(face.leftEye, '◡')
    assert.equal(face.mouth, '▽')
    assert.equal(face.rightEye, '◡')
  })

  it('returns correct face for content mood', () => {
    const face = getFace('content', 1)
    assert.equal(face.leftEye, '◡')
    assert.equal(face.mouth, '▿')
    assert.equal(face.rightEye, '◡')
  })

  it('returns correct face for tense mood', () => {
    const face = getFace('tense', 1)
    assert.equal(face.leftEye, '◎')
    assert.equal(face.mouth, '─')
    assert.equal(face.rightEye, '◎')
  })

  it('returns correct face for serious mood', () => {
    const face = getFace('serious', 1)
    assert.equal(face.leftEye, '●')
    assert.equal(face.mouth, '─')
    assert.equal(face.rightEye, '●')
  })

  it('returns correct face for confused mood', () => {
    const face = getFace('confused', 1)
    assert.equal(face.leftEye, '×')
    assert.equal(face.mouth, '~')
    assert.equal(face.rightEye, '×')
  })

  it('returns correct face for surprised mood', () => {
    const face = getFace('surprised', 1)
    assert.equal(face.leftEye, '○')
    assert.equal(face.mouth, '△')
    assert.equal(face.rightEye, '○')
  })

  it('returns correct face for greeting mood', () => {
    const face = getFace('greeting', 1)
    assert.equal(face.leftEye, '◠')
    assert.equal(face.mouth, '▽')
    assert.equal(face.rightEye, '◠')
  })

  it('blinks on tick divisible by 20', () => {
    const face = getFace('calm', 20)
    assert.equal(face.leftEye, '─')
    assert.equal(face.rightEye, '─')
    assert.equal(face.mouth, '‿')
  })

  it('does not blink on other ticks', () => {
    const face = getFace('calm', 19)
    assert.equal(face.leftEye, '◠')
  })

  it('does not blink on tick 0', () => {
    const face = getFace('calm', 0)
    assert.equal(face.leftEye, '◠')
  })

  it('preserves mouth during blink', () => {
    const face = getFace('focused', 40)
    assert.equal(face.leftEye, '─')
    assert.equal(face.mouth, '△')
    assert.equal(face.rightEye, '─')
  })
})
