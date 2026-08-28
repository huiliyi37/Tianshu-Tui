/**
 * prompt-footer 测试 — 输入框下方键位提示行。
 *
 * 对齐公开仓 prompt-footer 语义：左 mode 段恒保留，右 hints 段从后往前丢
 * 直到放得下。只列真的能按的键（同 command-palette hotkey 裁决）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatPromptFooter } from '../format/prompt-footer.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

const base = { width: 120 }

describe('formatPromptFooter', () => {
  it('正常模式提示 / 命令、ctrl+j 换行、ctrl+p 面板', () => {
    const [line] = formatPromptFooter(base, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('normal'), `mode 段: ${plain}`)
    assert.ok(plain.includes('/ 命令'), `hint: ${plain}`)
    assert.ok(plain.includes('ctrl+j 换行'), `hint: ${plain}`)
    assert.ok(plain.includes('ctrl+p 面板'), `hint: ${plain}`)
  })

  it('换行模式提示 换行中/enter 换行/shift+enter 退出', () => {
    const [line] = formatPromptFooter({ ...base, newlineMode: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('换行中'), `hint: ${plain}`)
    assert.ok(plain.includes('enter 换行'), `hint: ${plain}`)
    assert.ok(plain.includes('shift+enter 退出'), `hint: ${plain}`)
    assert.ok(!plain.includes('/ 命令'), '换行模式不再提示正常 hints')
  })

  it('agentBusy 时提示打断键，不再显示命令提示', () => {
    const [line] = formatPromptFooter({ ...base, agentBusy: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('esc 打断'), `hint: ${plain}`)
    assert.ok(plain.includes('ctrl+c 打断'), `hint: ${plain}`)
    assert.ok(!plain.includes('/ 命令'), `busy 不提示命令: ${plain}`)
  })

  it('approvalPending 时提示审批动作', () => {
    const [line] = formatPromptFooter({ ...base, approvalPending: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('y 允许'), `hint: ${plain}`)
    assert.ok(plain.includes('esc 取消'), `hint: ${plain}`)
  })

  it('窄宽度从后往前丢 hints，mode 恒保留', () => {
    const [narrow] = formatPromptFooter({ width: 40 }, theme)
    const plain = stripAnsi(narrow ?? '')
    assert.ok(plain.startsWith('normal'), `mode 保留: ${plain}`)
    assert.ok(plain.includes('/ 命令'), '第一个 hint 是高频项，最先保留')
    assert.ok(!plain.includes('ctrl+p 面板'), '尾部 hint 被丢')
    // 丢到极限：mode 放得下就必须输出
    const [tiny] = formatPromptFooter({ width: 10 }, theme)
    assert.ok(stripAnsi(tiny ?? '').includes('normal'), '再窄 mode 也在')
  })
})
