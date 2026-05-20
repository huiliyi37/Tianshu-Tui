import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFrame, WENXING_SEAL, WUXING_SEAL, TIANXU_SEAL, STAR_SEAL, STATUS_LABELS, GESTURES, getStringWidth } from '../frames.js'
import type { FaceExpression } from '../types.js'

describe('WENXING_SEAL', () => {
  it('has correct top line', () => {
    assert.equal(WENXING_SEAL.top, '╭文╮')
  })

  it('has correct middle line', () => {
    assert.equal(WENXING_SEAL.middle, '星│星')
  })

  it('has correct bottom line', () => {
    assert.equal(WENXING_SEAL.bottom, '╰┬╯')
  })
})

describe('WUXING_SEAL', () => {
  it('has correct top line', () => {
    assert.equal(WUXING_SEAL.top, '╭武╮')
  })

  it('has correct middle line', () => {
    assert.equal(WUXING_SEAL.middle, '曲│曲')
  })

  it('has correct bottom line', () => {
    assert.equal(WUXING_SEAL.bottom, '╰┬╯')
  })
})

describe('TIANXU_SEAL', () => {
  it('has correct top line', () => {
    assert.equal(TIANXU_SEAL.top, '╭天╮')
  })

  it('has correct middle line', () => {
    assert.equal(TIANXU_SEAL.middle, '枢│枢')
  })
})

describe('STAR_SEAL', () => {
  it('has star character', () => {
    assert.equal(STAR_SEAL.top, '╭✦╮')
    assert.equal(STAR_SEAL.middle, '星│星')
  })
})

describe('GESTURES', () => {
  it('has wenxing gesture (拱手)', () => {
    assert.ok(GESTURES.wenxing.includes('拱'))
  })

  it('has wuxing gesture (抱拳)', () => {
    assert.ok(GESTURES.wuxing.includes('拳'))
  })
})

describe('STATUS_LABELS', () => {
  it('has labels for all phases', () => {
    assert.ok(STATUS_LABELS['tianshu-planning'])
    assert.ok(STATUS_LABELS['tianxuan-locating'])
    assert.ok(STATUS_LABELS['tianji-decomposing'])
    assert.ok(STATUS_LABELS['tianquan-contracting'])
    assert.ok(STATUS_LABELS['yuheng-implementing'])
    assert.ok(STATUS_LABELS['kaiyang-testing'])
    assert.ok(STATUS_LABELS['yaoguang-delivering'])
    assert.ok(STATUS_LABELS['tianshu-encore'])
  })

  it('wenxing phases use ellipsis', () => {
    assert.ok(STATUS_LABELS['tianshu-planning'].includes('…'))
    assert.ok(STATUS_LABELS['tianxuan-locating'].includes('…'))
  })

  it('wuxing phases use exclamation', () => {
    assert.ok(STATUS_LABELS['yuheng-implementing'].includes('!'))
    assert.ok(STATUS_LABELS['kaiyang-testing'].includes('~'))
  })
})

describe('buildFrame', () => {
  const calmFace: FaceExpression = { leftEye: '◠', mouth: '‿', rightEye: '◠' }
  const focusedFace: FaceExpression = { leftEye: '●', mouth: '△', rightEye: '●' }

  it('returns AvatarFrame with correct structure', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    assert.ok(frame.crown)
    assert.ok(frame.face)
    assert.ok(frame.gesture)
    assert.ok(frame.status)
    assert.ok(frame.lines)
    assert.ok(frame.width > 0)
    assert.ok(frame.height > 0)
  })

  it('has correct height (7 lines)', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    assert.equal(frame.height, 7)
    assert.equal(frame.lines.length, 7)
  })

  it('includes seal crown in first lines', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    assert.ok(frame.lines[0]!.includes('╭'))
    assert.ok(frame.lines[0]!.includes('╮'))
    assert.ok(frame.lines[1]!.includes('│'))
    assert.ok(frame.lines[1]!.includes('星'))
    assert.ok(frame.lines[2]!.includes('╰'))
  })

  it('includes face expression in fourth line', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    assert.ok(frame.lines[3]!.includes('◠'))
    assert.ok(frame.lines[3]!.includes('‿'))
  })

  it('includes gesture in fifth and sixth lines', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    assert.ok(frame.lines[4]!.includes('拱'))
    assert.ok(frame.lines[5]!.includes('手'))
  })

  it('includes status label in last line', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    assert.ok(frame.lines[6]!.includes('思考中'))
  })

  it('uses wenxing seal for wenxing mode', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    assert.ok(frame.lines[0]!.includes('文'))
    assert.ok(frame.lines[1]!.includes('星'))
  })

  it('uses wuxing seal for wuxing mode', () => {
    const frame = buildFrame('wuxing', focusedFace, 'yuheng-implementing', null)
    assert.ok(frame.lines[0]!.includes('武'))
    assert.ok(frame.lines[1]!.includes('曲'))
  })

  it('uses tianxu seal for encore', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-encore', null)
    assert.ok(frame.lines[0]!.includes('天'))
    assert.ok(frame.lines[1]!.includes('枢'))
  })

  it('uses star seal for delivering', () => {
    const frame = buildFrame('wenxing', calmFace, 'yaoguang-delivering', null)
    assert.ok(frame.lines[0]!.includes('✦'))
  })

  it('adds domain badge for pojun', () => {
    const frame = buildFrame('wuxing', focusedFace, 'yuheng-implementing', 'pojun')
    const joined = frame.lines.join('')
    assert.ok(joined.includes('⚔'))
  })

  it('adds domain badge for tianfu', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', 'tianfu')
    const joined = frame.lines.join('')
    assert.ok(joined.includes('🛡'))
  })

  it('adds domain badge for tianliang', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', 'tianliang')
    const joined = frame.lines.join('')
    assert.ok(joined.includes('📏'))
  })

  it('width is consistent across all lines', () => {
    const frame = buildFrame('wenxing', calmFace, 'tianshu-planning', null)
    const expectedWidth = getStringWidth(frame.lines[0]!)
    for (const line of frame.lines) {
      assert.equal(getStringWidth(line), expectedWidth)
    }
  })

  it('lines are padded to consistent width', () => {
    const frame = buildFrame('wuxing', focusedFace, 'yuheng-implementing', null)
    const expectedWidth = getStringWidth(frame.lines[0]!)
    for (const line of frame.lines) {
      assert.equal(getStringWidth(line), expectedWidth)
    }
  })
})
