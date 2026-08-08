import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { color, fg, ANSI } from '../../engine/ansi.js'
import { getTheme } from '../../theme.js'
import { frameTitleCenter, frameTitleLeft } from '../overlay-frame.js'

const theme = getTheme(3)
const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function assertFrameColorRestored(line: string, width: number, nestedColor: string): void {
  const nestedStart = line.indexOf(fg(nestedColor))
  assert.notEqual(nestedStart, -1, 'fixture must contain the nested foreground style')
  const innerReset = line.indexOf(ANSI.RESET, nestedStart)
  assert.notEqual(innerReset, -1, 'fixture must contain an inner ANSI reset')
  const suffix = line.slice(innerReset + ANSI.RESET.length)

  assert.ok(
    suffix.startsWith(fg(theme.dim)),
    'frame suffix must explicitly restore the structural border color after nested content resets',
  )
  assert.equal(stringWidth(stripAnsi(line)), width)
}

describe('overlay title frame styling', () => {
  it('left title restores the frame color after a styled badge', () => {
    const title = `设置 /config   ${color('● 2 项未保存', theme.warning)}`
    assertFrameColorRestored(frameTitleLeft(title, 72, theme), 72, theme.warning)
  })

  it('centered title restores the frame color after styled content', () => {
    const title = `主题 ${color('Graphite', theme.primary, { bold: true })}`
    assertFrameColorRestored(frameTitleCenter(title, 60, theme), 60, theme.primary)
  })
})
