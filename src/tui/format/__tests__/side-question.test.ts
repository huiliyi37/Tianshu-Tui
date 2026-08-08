import { it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { getTheme } from '../../theme.js'
import { renderSideQuestion } from '../side-question.js'

const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

it('renderSideQuestion uses monochrome chrome without changing the frame geometry', () => {
  const previous = process.env.RIVET_ASCII_UI
  process.env.RIVET_ASCII_UI = '0'
  try {
    const lines = renderSideQuestion({
      question: '这个报错是什么意思？',
      answer: '类型不匹配。',
      pending: false,
    }, 72, 14, getTheme(3))
    const title = stripAnsi(lines[1]!)

    assert.match(title, /◇ 侧问 · 不进入对话历史/)
    assert.doesNotMatch(title, /💬/u)
    assert.ok(lines.every(line => stringWidth(stripAnsi(line)) === 72))
  } finally {
    if (previous === undefined) delete process.env.RIVET_ASCII_UI
    else process.env.RIVET_ASCII_UI = previous
  }
})
