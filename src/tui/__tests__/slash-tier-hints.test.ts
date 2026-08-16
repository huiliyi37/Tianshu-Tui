/**
 * slash 命令提示分层契约（方案 B：核心层 + 全量过滤）。
 *
 * 背景：提示列表 65 条静态 + 动态 skills ≈ 80 条，空 query（输入恰好 `/`）时
 * 按定义序展示，普通用户在噪音墙里找不到常用命令。
 *
 * 契约：
 *  1. 空 query 只展示核心层（tier: 'core'，按核心序）；无 core 标注的清单
 *     （如纯 skill 列表）回退全量——分层是增强不是破坏
 *  2. 带任意过滤字符 → 全量过滤（现有评分排序不变），进阶命令照常可达
 *  3. footer 提示「核心 N/M · 输入即过滤全部 · ctrl+p 面板」引导发现全量
 *  4. 键导航（↑↓）/ Tab 补全 / Enter 提交与显示同集合（filterSlashCommands
 *     单点分层，三处消费自动一致）
 *  5. /undo、/resume 进入核心清单（有完整实现但此前不在提示列表——高频
 *     救命功能用户发现不了）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSlashCommands, formatSlashHint, slashCompletionTarget, type SlashHintEntry } from '../format/slash-hint.js'
import { getPaletteCommands } from '../command-palette.js'
import { makeApp, stripAnsi } from '../engine/__tests__/_harness.js'
import type { RivetTheme } from '../theme.js'

/** 模拟 main.ts 的提示注入：palette 命令映射为 SlashHintEntry（含 tier）。 */
function paletteHints(): SlashHintEntry[] {
  return getPaletteCommands()
    .filter(c => c.name.startsWith('/'))
    .map(c => ({ name: c.name, description: c.description, ...(c.tier === 'core' ? { tier: 'core' as const } : {}) }))
}

const fakeTheme: RivetTheme = new Proxy({} as RivetTheme, {
  get: (_t, key: string) => (key === 'dim' || key === 'primary' || key === 'secondary' || key === 'muted' ? '' : ''),
})

test('空 query 只展示核心层；无 core 标注回退全量', () => {
  const hints = paletteHints()
  const core = filterSlashCommands(hints, '')
  assert.ok(core.length > 0, '核心层非空')
  assert.ok(core.every(c => c.tier === 'core'), '空 query 结果全部为核心层')
  assert.ok(core.some(c => c.name === '/model'), '核心层含 /model')
  assert.ok(!core.some(c => c.name === '/starflow'), '进阶命令不进空 query 结果')
  assert.equal(core.length, new Set(core.map(c => c.name)).size, '核心层无重复')

  // 无 core 标注的清单（纯 skills 形态）回退全量——分层不破坏既有消费方
  const noTier: SlashHintEntry[] = [{ name: '/skill a', description: 'x' }, { name: '/skill b', description: 'y' }]
  assert.equal(filterSlashCommands(noTier, '').length, 2, '无 core 标注回退全量')
})

test('带过滤字符走全量：进阶命令照常可达', () => {
  const hints = paletteHints()
  const q = filterSlashCommands(hints, 'starf')
  assert.ok(q.some(c => c.name === '/starflow'), '输入 starf 过滤出进阶 /starflow')
  const b = filterSlashCommands(hints, 'btw')
  assert.ok(b.some(c => c.name === '/btw'), '输入 btw 过滤出进阶 /btw')
})

test('footer 提示核心计数与全量入口；过滤态不出现核心计数', () => {
  const hints = paletteHints()
  const idle = formatSlashHint({ input: '/', commands: hints, selectedIdx: 0 }, fakeTheme).join('\n')
  assert.ok(idle.includes('核心'), `空 query footer 含核心计数: ${idle.slice(-160)}`)
  assert.ok(idle.includes('过滤'), 'footer 引导继续输入过滤全量')

  const filtered = formatSlashHint({ input: '/starf', commands: hints, selectedIdx: 0 }, fakeTheme).join('\n')
  assert.ok(!filtered.includes('核心'), '过滤态 footer 不含核心计数')
})

test('Tab 补全目标在核心集合内（与显示同集合）', () => {
  const hints = paletteHints()
  const target = slashCompletionTarget('/', hints, 0)
  assert.equal(target, '/help', '空 query 首选补全为核心层第一条 /help')
  const target2 = slashCompletionTarget('/starf', hints, 0)
  assert.equal(target2, '/starflow', '过滤态补全进阶命令')
})

test('/undo 与 /resume 在核心清单（原为隐藏命令）', () => {
  const core = filterSlashCommands(paletteHints(), '')
  assert.ok(core.some(c => c.name === '/undo'), '/undo 进入核心层')
  assert.ok(core.some(c => c.name === '/resume'), '/resume 进入核心层')
})

test('端到端：输入 / 显示核心层，继续输入切换全量过滤', async () => {
  const t = makeApp()
  t.app.setSlashCommands(paletteHints())
  t.out.clear()
  t.stdin.dataHandler!('/')
  await new Promise(r => setTimeout(r, 30))
  const idle = stripAnsi(t.out.chunks.join(''))
  assert.ok(idle.includes('/model'), '核心序靠前的 /model 可见')
  assert.ok(!idle.includes('/btw'), '进阶命令不在空 query 可见集')

  t.out.clear()
  t.stdin.dataHandler!('b')
  await new Promise(r => setTimeout(r, 30))
  const filtered = stripAnsi(t.out.chunks.join(''))
  assert.ok(filtered.includes('/btw'), '继续输入 b 过滤出进阶 /btw（全量过滤）')
})
