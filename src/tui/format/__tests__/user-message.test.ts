import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import chalk from 'chalk'
import { color } from '../../engine/ansi.js'
import { getTheme } from '../../theme.js'
import { formatUserMessage } from '../user-message.js'

const theme = getTheme(3)

describe('formatUserMessage typography', () => {
  it('keeps the rail accented while rendering message copy as regular body text', () => {
    const marker = chalk.level < 3 ? '❯' : '▌'
    const lines = formatUserMessage({ content: '第一行\n第二行', width: 80 }, theme)
    const prefix = color(marker, theme.userColor, { bold: true })

    assert.deepEqual(lines, [
      `${prefix} ${color('第一行', theme.assistantColor)}`,
      `${prefix} ${color('第二行', theme.assistantColor)}`,
    ])
  })

  it('preserves the accented rail on blank continuation lines', () => {
    const marker = chalk.level < 3 ? '❯' : '▌'
    const prefix = color(marker, theme.userColor, { bold: true })

    assert.deepEqual(
      formatUserMessage({ content: '正文\n\n继续', width: 80 }, theme),
      [
        `${prefix} ${color('正文', theme.assistantColor)}`,
        prefix,
        `${prefix} ${color('继续', theme.assistantColor)}`,
      ],
    )
  })
})
