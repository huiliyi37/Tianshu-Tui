/**
 * collapsed-polling 纯函数测试 — 轮询连击折叠（known-issue 2026-09-04 P1）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPollingFoldTool,
  pollingEntryLabel,
  computePollingStats,
  buildPollingSummaryText,
  formatCollapsedPollingGroup,
  formatCollapsedPollingGroupLive,
  CollapsedPollingBuffer,
  POLLING_EXPAND_MAX_ENTRIES,
  POLLING_ENTRY_CONTENT_MAX_CHARS,
  type CollapsedPollingGroup,
  type CollapsedPollingEntry,
} from '../format/collapsed-polling.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
const plain = (lines: string[]) => lines.map(stripAnsi)

function makeEntry(i: number, overrides: Partial<CollapsedPollingEntry> = {}): CollapsedPollingEntry {
  return {
    id: `id-${i}`,
    toolName: 'job',
    input: { action: 'list' },
    label: 'list',
    completed: true,
    startMs: Date.now() - 2000,
    endMs: Date.now() - 1800,
    content: `[a1] running · 3s · cmd ${i}`,
    ...overrides,
  }
}

function makeGroup(entries: Array<Partial<CollapsedPollingEntry>> = [], toolName = 'job'): CollapsedPollingGroup {
  return {
    toolName,
    entries: entries.map((e, i) => makeEntry(i, e)),
    startMs: Date.now() - 3000,
  }
}

// ── 分类 ───────────────────────────────────────────────────────

describe('isPollingFoldTool', () => {
  it('覆盖观察型工具六件套（与 agent pollingClassOf / 桌面 POLLING_FOLD_TOOLS 同集）', () => {
    for (const t of ['job', 'monitor', 'browser_debug', 'browser', 'computer_use', 'ask_image']) {
      assert.ok(isPollingFoldTool(t), `${t} 应在折叠集`)
    }
  })

  it('探索/调研工具不进轮询折叠（read/search 已有独立折叠组）', () => {
    for (const t of ['read_file', 'grep', 'glob', 'bash', 'web_fetch', 'write_file', 'todo']) {
      assert.ok(!isPollingFoldTool(t), `${t} 不应在折叠集`)
    }
  })

  it('大小写归一', () => {
    assert.ok(isPollingFoldTool('Job'))
    assert.ok(!isPollingFoldTool('Read_File'))
  })
})

// ── 单次调用标签 ───────────────────────────────────────────────

describe('pollingEntryLabel', () => {
  it('job: action + id', () => {
    assert.equal(pollingEntryLabel('job', { action: 'list' }), 'list')
    assert.equal(pollingEntryLabel('job', { action: 'await', id: 'a1' }), 'await a1')
  })

  it('monitor / browser_debug / ask_image', () => {
    assert.equal(pollingEntryLabel('monitor', { action: 'list' }), 'list')
    assert.equal(pollingEntryLabel('monitor', { action: 'subscribe', jobId: 'j9' }), 'subscribe j9')
    assert.equal(pollingEntryLabel('browser_debug', { action: 'screenshot' }), 'screenshot')
    assert.equal(pollingEntryLabel('browser_debug', { action: 'navigate', url: 'http://x' }), 'navigate http://x')
    assert.equal(pollingEntryLabel('ask_image', { id: 'i1' }), 'i1')
  })

  it('空 input 降级为工具名；超长截断', () => {
    assert.equal(pollingEntryLabel('job', {}), 'job')
    const long = pollingEntryLabel('job', { action: 'await', id: 'x'.repeat(100) })
    assert.ok(long.length <= 50 && long.endsWith('…'))
  })
})

// ── 统计与摘要 ─────────────────────────────────────────────────

describe('computePollingStats', () => {
  it('completed/pending/failed/lastCompleted', () => {
    const group = makeGroup([
      { id: '1', completed: true },
      { id: '2', completed: true, isError: true },
      { id: '3', completed: false, content: undefined },
    ])
    const stats = computePollingStats(group)
    assert.equal(stats.total, 3)
    assert.equal(stats.completed, 2)
    assert.equal(stats.pending, 1)
    assert.equal(stats.failed, 1)
    assert.equal(stats.lastCompleted?.id, '2')
  })
})

describe('buildPollingSummaryText', () => {
  it('落版：全成功', () => {
    const text = buildPollingSummaryText(makeGroup([{}, {}, {}]), false)
    assert.equal(text, '⏱ job 轮询 × 3（成功 3）')
  })

  it('落版：含失败与在途', () => {
    const group = makeGroup([
      { completed: true },
      { completed: true, isError: true },
      { completed: false, content: undefined },
    ])
    const text = buildPollingSummaryText(group, false)
    assert.equal(text, '⏱ job 轮询 × 3（成功 1 / 失败 1 / 在途 1）')
  })

  it('live：最近 OK / 最近失败 / 进行中', () => {
    assert.equal(buildPollingSummaryText(makeGroup([{}]), true), '⏱ job ×1 · 最近 OK')
    assert.equal(buildPollingSummaryText(makeGroup([{ isError: true }]), true), '⏱ job ×1 · 最近失败')
    assert.equal(buildPollingSummaryText(makeGroup([{ completed: false, content: undefined }]), true), '⏱ job ×1 · 进行中')
  })
})

// ── scrollback 渲染 ────────────────────────────────────────────

describe('formatCollapsedPollingGroup', () => {
  it('折叠态：一行摘要 + 最近明细行，含 ctrl+o 展开标记（pager 可识别）', () => {
    const group = makeGroup(Array.from({ length: 12 }, (_, i) => ({ content: `[a1] running · cmd ${i}` })))
    const lines = plain(formatCollapsedPollingGroup({ group, theme }))
    assert.equal(lines.length, 2)
    assert.ok(lines[0]!.includes('▶ ⏱ job 轮询 × 12（成功 12）'), lines[0])
    assert.ok(lines[0]!.includes('ctrl+o 展开'), lines[0])
    assert.ok(lines[1]!.includes('最近 list ✓'), lines[1])
    assert.ok(lines[1]!.includes('cmd 11'), '最近一条结果首行应可见')
    assert.ok(!lines[1]!.includes('cmd 10'), '更早结果不进折叠态卡片')
  })

  it('折叠态：失败计数进摘要，最近失败用 ✗', () => {
    const group = makeGroup([{}, {}, { isError: true, content: 'boom' }])
    const lines = plain(formatCollapsedPollingGroup({ group, theme }))
    assert.ok(lines[0]!.includes('（成功 2 / 失败 1）'), lines[0])
    assert.ok(lines[1]!.includes('最近 list ✗ boom'), lines[1])
  })

  it('展开态：逐条列出明细（# 序号 + 标签 + 成败 + 结果预览）', () => {
    const group = makeGroup([{}, { isError: true, content: 'err-line-1\nerr-line-2' }, {}])
    const lines = plain(formatCollapsedPollingGroup({ group, expanded: true, theme }))
    assert.ok(lines[0]!.startsWith('▼'), lines[0])
    assert.ok(!lines[0]!.includes('ctrl+o 展开'), '展开态不再带展开提示')
    assert.ok(lines.some(l => l.includes('#1 list ✓')), lines.join('|'))
    assert.ok(lines.some(l => l.includes('#2 list ✗')), lines.join('|'))
    assert.ok(lines.some(l => l.includes('err-line-1')), '失败结果尾部预览行 1')
    assert.ok(lines.some(l => l.includes('err-line-2')), '失败结果尾部预览行 2')
  })

  it('展开态：超过上限只列最近 N 条，更早的计数折叠', () => {
    const group = makeGroup(Array.from({ length: 25 }, (_, i) => ({ content: `line-${i}` })))
    const lines = plain(formatCollapsedPollingGroup({ group, expanded: true, theme }))
    assert.ok(lines.some(l => l.includes(`早前 ${25 - POLLING_EXPAND_MAX_ENTRIES} 次调用（已折叠）`)), lines.join('|'))
    assert.ok(lines.some(l => l.includes(`#${25} `)), '最近一条应列出')
    assert.ok(!lines.some(l => l.includes(`#${25 - POLLING_EXPAND_MAX_ENTRIES} `)), '超出上限的更早条目不列出')
    assert.ok(!lines.some(l => l.includes('line-0\n') || l.includes(' line-0')), '最早条目内容不列出')
  })

  it('展开态：长结果按行数截断并带隐藏标记', () => {
    const group = makeGroup([{ content: Array.from({ length: 10 }, (_, i) => `row${i}`).join('\n') }])
    const lines = plain(formatCollapsedPollingGroup({ group, expanded: true, theme }))
    assert.ok(lines.some(l => l.includes('已隐藏 7 行')), lines.join('|'))
  })

  it('全部在途：防御性渲染（结果待达）', () => {
    const group = makeGroup([{ completed: false, content: undefined }, { completed: false, content: undefined }])
    const lines = plain(formatCollapsedPollingGroup({ group, theme }))
    assert.ok(lines[0]!.includes('轮询 × 2（在途 2）'), lines[0])
    assert.ok(lines.some(l => l.includes('结果待达')), lines.join('|'))
  })
})

// ── live 渲染 ──────────────────────────────────────────────────

describe('formatCollapsedPollingGroupLive', () => {
  it('聚合行：⏱ 工具 ×N · 最近状态 · 耗时', () => {
    const group = makeGroup(Array.from({ length: 12 }, () => ({})))
    const lines = plain(formatCollapsedPollingGroupLive(group, theme, 80))
    assert.ok(lines[0]!.startsWith('● ⏱ job ×12 · 最近 OK'), lines[0])
    // 最近一条结果的末行作进度预览
    assert.ok(lines.some(l => l.includes('cmd 11')), lines.join('|'))
  })

  it('无完成调用时不渲染预览行', () => {
    const group = makeGroup([{ completed: false, content: undefined }])
    const lines = plain(formatCollapsedPollingGroupLive(group, theme, 80))
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.includes('进行中'), lines[0])
  })
})

// ── Buffer ─────────────────────────────────────────────────────

describe('CollapsedPollingBuffer', () => {
  it('同名连击累积；shouldBreak 只对异名', () => {
    const buf = new CollapsedPollingBuffer()
    buf.pushUse('a', 'job', { action: 'list' })
    buf.pushUse('b', 'job', { action: 'list' })
    assert.ok(!buf.shouldBreak('job'))
    assert.ok(buf.shouldBreak('monitor'))
    assert.ok(buf.shouldBreak('write_file'))
    assert.equal(buf.getActive()?.entries.length, 2)
  })

  it('attachResult 按 id 绑定（并行同名调用不串）', () => {
    const buf = new CollapsedPollingBuffer()
    buf.pushUse('id-A', 'job', { action: 'list' })
    buf.pushUse('id-B', 'job', { action: 'await', id: 'a1' })
    buf.attachResult('id-B', 'done B', false)
    buf.attachResult('id-A', 'done A', true)
    const g = buf.getActive()!
    assert.equal(g.entries[0]!.content, 'done A')
    assert.equal(g.entries[0]!.isError, true)
    assert.equal(g.entries[1]!.content, 'done B')
    assert.equal(g.entries[1]!.label, 'await a1')
  })

  it('异名 pushUse 防御性重开（外部应先 flush）', () => {
    const buf = new CollapsedPollingBuffer()
    buf.pushUse('a', 'job', {})
    buf.pushUse('b', 'monitor', {})
    assert.equal(buf.getActive()?.toolName, 'monitor')
    assert.equal(buf.getActive()?.entries.length, 1)
  })

  it('flush 取走组并清空；hasEntry/hasPending', () => {
    const buf = new CollapsedPollingBuffer()
    buf.pushUse('a', 'job', {})
    assert.ok(buf.hasEntry('a'))
    assert.ok(buf.hasPending())
    buf.attachResult('a', 'ok', false)
    assert.ok(!buf.hasPending())
    const g = buf.flush()
    assert.ok(g && g.entries.length === 1)
    assert.ok(!buf.isActive())
    assert.equal(buf.flush(), null)
  })

  it('单条结果内容超过上限时截断（聚合卡不留全量原文）', () => {
    const buf = new CollapsedPollingBuffer()
    buf.pushUse('a', 'browser_debug', { action: 'logs' })
    const big = 'x'.repeat(POLLING_ENTRY_CONTENT_MAX_CHARS + 500)
    buf.attachResult('a', big, false)
    const entry = buf.getActive()!.entries[0]!
    assert.ok(entry.content!.length < big.length)
    assert.ok(entry.content!.includes('聚合卡内截断'))
  })
})
