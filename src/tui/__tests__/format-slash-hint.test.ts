import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterSlashCommands,
  formatSlashHint,
  formatSlashMenu,
  slashCompletionTarget,
  slashArgsHint,
  SLASH_HINT_MAX_VISIBLE,
  computeSlashMenuBudget,
  type SlashHintEntry,
} from '../format/slash-hint.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

const COMMANDS = [
  { name: '/help', description: 'Show all commands' },
  { name: '/compact', description: 'Compact conversation context' },
  { name: '/model list', description: 'List available models' },
  { name: '/cost', description: 'Show session cost' },
  { name: '/clear', description: 'Clear conversation' },
  { name: '/exit', description: 'Quit' },
  { name: '/verbose', description: 'Toggle verbose' },
  { name: '/review', description: 'Run code review' },
  { name: '/review max', description: 'Run full squadron review' },
]

describe('filterSlashCommands', () => {
  it('empty query returns all', () => {
    assert.equal(filterSlashCommands(COMMANDS, '').length, COMMANDS.length)
  })

  it('substring match on name', () => {
    const out = filterSlashCommands(COMMANDS, 'comp')
    assert.ok(out.some(c => c.name === '/compact'))
  })

  it('substring match on description', () => {
    const out = filterSlashCommands(COMMANDS, 'cost')
    assert.ok(out.some(c => c.name === '/cost'))
  })

  it('fuzzy subsequence match', () => {
    const out = filterSlashCommands(COMMANDS, 'hlp')
    assert.ok(out.some(c => c.name === '/help'))
  })

  it('no match returns empty', () => {
    assert.deepEqual(filterSlashCommands(COMMANDS, 'zzzzqq'), [])
  })

  it('ranks name prefix match above fuzzy/description match', () => {
    // "revi" → /review (prefix) and /review max (prefix) should beat any
    // description-only or fuzzy matches
    const out = filterSlashCommands(COMMANDS, 'revi')
    assert.equal(out[0]!.name, '/review')
    assert.equal(out[1]!.name, '/review max')
  })

  it('ranks name prefix above substring above fuzzy above description', () => {
    // query 're' → 'review' (name prefix after stripping /), 'review max' (prefix)
    const out = filterSlashCommands(COMMANDS, 're')
    assert.equal(out[0]!.name, '/review')
    assert.equal(out[1]!.name, '/review max')
  })
})

describe('formatSlashHint', () => {
  it('non-slash input returns empty', () => {
    assert.deepEqual(formatSlashHint({ input: 'hello', commands: COMMANDS }, theme), [])
  })

  it('renders selected marker on first entry + footer', () => {
    const lines = formatSlashHint({ input: '/he', commands: COMMANDS }, theme).map(stripAnsi)
    assert.ok(lines[0]!.startsWith('❯ /help'))
    assert.ok(lines[lines.length - 1]!.includes('tab complete'))
  })

  it('caps visible entries and shows scroll indicators', () => {
    const lines = formatSlashHint({ input: '/', commands: COMMANDS }, theme).map(stripAnsi)
    // 5 visible + footer (selectedIdx=0 → scrollOffset=0, no "↑ above")
    assert.equal(lines.length, SLASH_HINT_MAX_VISIBLE + 1)
    // Footer should show overflow count and navigation hints
    assert.ok(lines[lines.length - 1]!.includes(`${COMMANDS.length - SLASH_HINT_MAX_VISIBLE} more`), 'shows overflow count')
    assert.ok(lines[lines.length - 1]!.includes('↓'), 'has down scroll indicator')
  })

  it('input /revi surfaces /review at top with ❯ marker', () => {
    const lines = formatSlashHint({ input: '/revi', commands: COMMANDS }, theme).map(stripAnsi)
    assert.ok(lines.length >= 2)
    assert.ok(lines[0]!.startsWith('❯ /review'), 'first visible line should be ❯ /review')
  })

  it('no matches returns empty array', () => {
    assert.deepEqual(formatSlashHint({ input: '/zzzzqq', commands: COMMANDS }, theme), [])
  })
})

describe('slashCompletionTarget', () => {
  it('returns first filtered command', () => {
    assert.equal(slashCompletionTarget('/he', COMMANDS), '/help')
  })

  it('returns null without matches or slash prefix', () => {
    assert.equal(slashCompletionTarget('/zzzzqq', COMMANDS), null)
    assert.equal(slashCompletionTarget('he', COMMANDS), null)
  })

  it('honours selectedIdx for arrow-key navigation', () => {
    // filterSlashCommands now ranks by relevance, so we use filterSlashCommands
    // to get the expected ordering and verify selectedIdx selects within that.
    const filtered = filterSlashCommands(COMMANDS, 'comp')
    assert.ok(filtered.length >= 1)
    assert.equal(slashCompletionTarget('/comp', COMMANDS, 0), filtered[0]!.name)
    // out-of-range idx clamps to last
    assert.equal(slashCompletionTarget('/comp', COMMANDS, 99), filtered[filtered.length - 1]!.name)
  })
})

describe('formatSlashHint scroll window', () => {
  it('selectedIdx in middle shows scroll indicators above and below', () => {
    // 9 commands, maxVisible=5. Selecting index 6 (past midpoint) should show "↑ above"
    const lines = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 6 }, theme).map(stripAnsi)
    // Should have "↑ N above" indicator
    assert.ok(lines.some(l => l.includes('↑') && l.includes('above')), 'shows scroll-up indicator')
  })

  it('selectedIdx near bottom pins to end', () => {
    const lines = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 8 }, theme).map(stripAnsi)
    // Last visible command should be the last in COMMANDS (/review max)
    const visibleCmds = lines.filter(l => l.includes('/'))
    assert.ok(visibleCmds.some(l => l.includes('/review max')), 'last command visible when at bottom')
  })

  it('scrolling down moves window forward', () => {
    // At idx 0, first visible is /help. At idx 5, /help should scroll off.
    const lines0 = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 0 }, theme).map(stripAnsi)
    const lines5 = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 5 }, theme).map(stripAnsi)
    // /help visible at idx 0 but NOT at idx 5
    assert.ok(lines0.some(l => l.includes('/help')), '/help visible at top')
    assert.ok(!lines5.some(l => l.includes('/help') && !l.includes('above')), '/help scrolled off at idx 5')
  })

  it('footer shows ↵ run hint', () => {
    const lines = formatSlashHint({ input: '/he', commands: COMMANDS }, theme).map(stripAnsi)
    assert.ok(lines[lines.length - 1]!.includes('↵'), 'footer has Enter hint')
  })
})

describe('slashArgsHint（P3-2 ghost text 匹配）', () => {
  const CMDS = [
    { name: '/effort', description: 'Set reasoning effort', argsHint: 'off|low|medium|high|max' },
    { name: '/model', description: 'Switch model', argsHint: 'list|<model-id>' },
    { name: '/model list', description: 'List models' },
    { name: '/help', description: 'Show all commands' },
  ]

  it('「命令名+单个空格」精确形态 → 返回 argsHint', () => {
    assert.equal(slashArgsHint(CMDS, '/effort '), 'off|low|medium|high|max')
    assert.equal(slashArgsHint(CMDS, '/model '), 'list|<model-id>')
  })

  it('命令名未完整（前缀）→ null', () => {
    assert.equal(slashArgsHint(CMDS, '/eff '), null)
    assert.equal(slashArgsHint(CMDS, '/effort'), null, '无尾随空格不提示')
  })

  it('继续输入参数即失配（第二字符出现 → null）', () => {
    assert.equal(slashArgsHint(CMDS, '/effort m'), null)
    assert.equal(slashArgsHint(CMDS, '/effort  '), null, '多个空格不提示')
  })

  it('无 argsHint 的命令 / 非斜杠输入 / 多行输入 → null', () => {
    assert.equal(slashArgsHint(CMDS, '/help '), null)
    assert.equal(slashArgsHint(CMDS, 'effort '), null)
    assert.equal(slashArgsHint(CMDS, '/effort \n'), null)
  })

  it('名含参数的命令条目在「裸名+空格」不误匹配（/model list 不吃 /model 的提示）', () => {
    assert.equal(slashArgsHint(CMDS, '/model list '), null)
  })
})

describe('formatSlashMenu（已过滤列表的纯格式化）', () => {
  it('空列表返回空数组', () => {
    assert.deepEqual(formatSlashMenu({ items: [], selected: 0 }, theme), [])
  })

  it('选中项带 ❯ 标记，非选中项为普通缩进', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 0 }, theme).map(stripAnsi)
    assert.ok(lines[0]!.startsWith('❯ /help'), 'first item marked selected')
    assert.ok(lines[1]!.startsWith('  '), 'second item not selected')
  })

  it('selected 越界时 clamp 到合法范围', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 99 }, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('/review max')), 'clamps to last item')
    const linesNeg = formatSlashMenu({ items: COMMANDS, selected: -5 }, theme).map(stripAnsi)
    assert.ok(linesNeg[0]!.startsWith('❯ /help'), 'clamps negative to first item')
  })

  it('超过 maxVisible 时截断并显示 ↓ 指示', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 0 }, theme).map(stripAnsi)
    assert.equal(lines.length, SLASH_HINT_MAX_VISIBLE + 1, '5 visible + footer')
    assert.ok(lines[lines.length - 1]!.includes(`${COMMANDS.length - SLASH_HINT_MAX_VISIBLE} more`), 'shows overflow count')
  })

  it('中间选中显示上下滚动指示', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 6 }, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('↑') && l.includes('above')), 'shows scroll-up indicator')
    assert.ok(lines[lines.length - 1]!.includes('↓'), 'shows scroll-down indicator')
  })

  it('footer 固定导航提示 + footerNote 插入', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 0, footerNote: '核心 5/9 · 输入即过滤' }, theme).map(stripAnsi)
    const footer = lines[lines.length - 1]!
    assert.ok(footer.includes('核心 5/9 · 输入即过滤'), 'footerNote in footer')
    assert.ok(footer.includes('tab complete'), 'navigation hint preserved')
    assert.ok(footer.includes('↵ run'), 'enter hint preserved')
  })

  it('无 footerNote 时 footer 不出现空段', () => {
    const lines = formatSlashMenu({ items: COMMANDS.slice(0, 2), selected: 0 }, theme).map(stripAnsi)
    const footer = lines[lines.length - 1]!
    assert.ok(!footer.includes('· ·'), 'no empty segment in footer')
    assert.ok(!footer.includes('undefined'), 'no undefined leak')
  })
})

// ── computeSlashMenuBudget（TUI 钉底：菜单高度钳制）──
// 预算 = maxRows - chromeRows - inputRows；充足时 5 项 + footer，
// 空间不足压缩菜单项（footer 保留），极端只保输入框（1 项无 footer），
// 预算耗尽菜单完全不显示（钉底优先：宁可无菜单也不超行触发终端滚动）。

describe('computeSlashMenuBudget（菜单高度钳制）', () => {
  it('空间充足：5 项 + footer（与现状一致）', () => {
    assert.deepEqual(
      computeSlashMenuBudget({ chromeRows: 5, inputRows: 2, maxRows: 23, designMaxVisible: 5 }),
      { visibleItems: 5, hideFooter: false },
    )
  })

  it('空间不足：压缩菜单项但保留 footer（预算 4 → 3 项 + footer = 4 行）', () => {
    assert.deepEqual(
      computeSlashMenuBudget({ chromeRows: 17, inputRows: 2, maxRows: 23, designMaxVisible: 5 }),
      { visibleItems: 3, hideFooter: false },
    )
  })

  it('预算仅 1 行：1 项无 footer（最少可见反馈）', () => {
    assert.deepEqual(
      computeSlashMenuBudget({ chromeRows: 20, inputRows: 2, maxRows: 23, designMaxVisible: 5 }),
      { visibleItems: 1, hideFooter: true },
    )
  })

  it('预算耗尽：菜单不显示（钉底优先，不超行）', () => {
    assert.deepEqual(
      computeSlashMenuBudget({ chromeRows: 21, inputRows: 2, maxRows: 23, designMaxVisible: 5 }),
      { visibleItems: 0, hideFooter: true },
    )
  })

  it('预算大于设计上限：钳制到 5 项', () => {
    assert.deepEqual(
      computeSlashMenuBudget({ chromeRows: 3, inputRows: 1, maxRows: 40, designMaxVisible: 5 }),
      { visibleItems: 5, hideFooter: false },
    )
  })
})

describe('formatSlashMenu hideFooter', () => {
  it('hideFooter 时不渲染 footer 行', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 0, hideFooter: true }, theme).map(stripAnsi)
    assert.ok(!lines.some(l => l.includes('↑↓ navigate')), '无导航提示行')
    assert.ok(lines.some(l => l.includes('/help')), '菜单项仍在')
  })

  it('hideFooter 且 visibleItems=0 → 空数组（无菜单空间）', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 0, maxVisible: 0, hideFooter: true }, theme)
    assert.deepEqual(lines, [])
  })

  it('默认（无 hideFooter）footer 保留', () => {
    const lines = formatSlashMenu({ items: COMMANDS, selected: 0 }, theme).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('↑↓ navigate')), '导航提示保留')
  })
})

// ── 钉底不变量合成断言（F3）：菜单实际输出行数 ≤ 预算 ──
// 探针复现场景固化：scrollOffset>0 时 overflowAbove 指示行曾使输出 5 行 > 预算 4 行。

const MANY_COMMANDS: SlashHintEntry[] = Array.from({ length: 20 }, (_, i) => ({
  name: `/cmd${i}`,
  description: `desc${i}`,
}))

describe('菜单输出行数 ≤ 预算（整帧不变量）', () => {
  it('scrollOffset>0 时指示行并入 footer，输出行数不超预算', () => {
    const budget = computeSlashMenuBudget({ chromeRows: 17, inputRows: 2, maxRows: 23, designMaxVisible: 5 })
    assert.deepEqual(budget, { visibleItems: 3, hideFooter: false })
    // selected=10 → scrollOffset>0（滚动窗口中间/底部）——旧实现多 1 行 ↑ N above → 5 行超预算
    const lines = formatSlashMenu({ items: MANY_COMMANDS, selected: 10, maxVisible: budget.visibleItems, hideFooter: budget.hideFooter }, theme)
    assert.ok(lines.length <= 4, `菜单输出 ${lines.length} 行 ≤ 预算 4 行（整帧不变量）`)
    // 信息不减：↑ 指示仍在（并入 footer）
    assert.ok(lines.some(l => l.includes('↑') && l.includes('above')), '↑ 指示并入 footer 行保留')
  })

  it('hideFooter 时输出行数 = 可见项数', () => {
    const budget = computeSlashMenuBudget({ chromeRows: 20, inputRows: 2, maxRows: 23, designMaxVisible: 5 })
    assert.deepEqual(budget, { visibleItems: 1, hideFooter: true })
    const lines = formatSlashMenu({ items: MANY_COMMANDS, selected: 0, maxVisible: budget.visibleItems, hideFooter: budget.hideFooter }, theme)
    assert.equal(lines.length, 1, 'hideFooter 且无滚动时恰 1 行')
  })
})

describe('formatSlashHint 预算钳制透传（F2：Esc 后无钳制通道）', () => {
  it('maxVisible/hideFooter 透传到内部菜单格式化', () => {
    const lines = formatSlashHint({ input: '/c', commands: COMMANDS, selectedIdx: 0, maxVisible: 2, hideFooter: true }, theme)
    assert.ok(lines.length <= 2, `钳制后 ≤ 2 行（实际 ${lines.length}）`)
    assert.ok(!lines.some(l => l.includes('↑↓ navigate')), '无 footer')
  })

  it('不传钳制参数时行为不变（兼容旧调用）', () => {
    const lines = formatSlashHint({ input: '/c', commands: COMMANDS, selectedIdx: 0 }, theme)
    assert.ok(lines.length > 0)
    assert.ok(lines.some(l => l.includes('↑↓ navigate')), 'footer 保留')
  })
})
