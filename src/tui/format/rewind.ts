/**
 * Rewind overlay — ANSI 渲染器（对标 Claude Code 的 rewind 体验）。
 *
 * 采用统一面板骨架（overlay-frame）。两阶段流程：
 *  1. list   — 选择一条历史用户消息（回溯锚点）
 *  2. action — 对选中消息选择恢复粒度：仅对话 / 仅代码 / 对话+代码；
 *              代码相关动作附带「将改动哪些文件」的精确预览。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import {
  frameTop,
  frameBottom,
  frameTitle,
  frameFooter,
  frameLine,
  CURSOR,
  keyHints,
} from './overlay-frame.js'

export type RewindMode = 'convo' | 'code' | 'both'

export interface RewindFile {
  path: string
  action: 'restore' | 'delete'
}

export interface RewindEntry {
  /** 1-based display ordinal among the shown user messages. */
  index: number
  /** Index into the full message array — the true rewind boundary. */
  messageIndex: number
  content: string
  ts?: number
}

export interface RewindData {
  entries: RewindEntry[]
  selectedIndex: number
  /** Phase 2 state (injected by the app from overlay nav). */
  phase?: 'list' | 'action'
  actionIndex?: number
  /** Files a precise code rewind to the selected message would touch. */
  previewFiles?: RewindFile[]
}

const ACTIONS: { mode: RewindMode; title: string; desc: string }[] = [
  { mode: 'convo', title: '仅恢复对话', desc: '截断对话到此消息，不改动文件' },
  { mode: 'code', title: '仅恢复代码', desc: '把 agent 编辑的文件恢复到此消息时的状态' },
  { mode: 'both', title: '对话 + 代码', desc: '截断对话并把文件恢复到此刻' },
]

function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts || ts <= 0) return ''
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m 前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h 前`
  return `${Math.floor(h / 24)}d 前`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, Math.max(0, max - 1)) + '…' : flat
}

/** Windowed slice so the selected row stays visible in a bounded viewport. */
function windowed<T>(items: T[], selected: number, size: number): { slice: T[]; start: number } {
  if (items.length <= size) return { slice: items, start: 0 }
  let start = selected - Math.floor(size / 2)
  start = Math.max(0, Math.min(start, items.length - size))
  return { slice: items.slice(start, start + size), start }
}

export function renderRewind(data: RewindData, width: number, height: number, theme: RivetTheme): string[] {
  const phase = data.phase ?? 'list'
  const w = Math.max(20, width - 4)
  const contentRows = Math.max(3, height - 4) // top + title + footer + bottom

  const title = phase === 'action' ? '⏪ 回溯 · 选择恢复粒度' : '⏪ 回溯 · 选择回溯到的消息'
  const lines: string[] = [frameTop(width, theme), frameTitle(title, width, theme)]

  const body: string[] = []
  let footer: string

  if (data.entries.length === 0) {
    body.push('')
    body.push(`  ${color('没有可回溯的消息。', theme.muted)}`)
    footer = keyHints([['q', '取消']])
  } else {
    const selected = Math.max(0, Math.min(data.selectedIndex, data.entries.length - 1))
    if (phase === 'action') {
      buildActionBody(body, data, selected, w, theme)
      footer = keyHints([['↑↓', '选择动作'], ['Enter', '确认'], ['Esc', '返回']])
    } else {
      buildListBody(body, data, selected, w, contentRows, theme)
      footer = keyHints([['↑↓', '选择消息'], ['Enter', '下一步'], ['q', '取消']])
    }
  }

  for (let i = 0; i < contentRows; i++) lines.push(frameLine(body[i] ?? '', width, theme))
  lines.push(frameFooter(footer, width, theme))
  lines.push(frameBottom(width, theme))
  return lines
}

function buildListBody(body: string[], data: RewindData, selected: number, w: number, contentRows: number, theme: RivetTheme): void {
  const hasCounter = data.entries.length > contentRows
  const viewport = Math.max(1, contentRows - (hasCounter ? 1 : 0))
  const { slice, start } = windowed(data.entries, selected, viewport)
  slice.forEach((entry, i) => {
    const realIdx = start + i
    const isSel = realIdx === selected
    const marker = isSel ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const ord = color(`#${entry.index}`.padStart(3), isSel ? theme.primary : theme.muted)
    const time = entry.ts ? '  ' + color(relativeTime(entry.ts).padStart(6), theme.dim) : ''
    const budget = w - 12 - (time ? 8 : 0)
    const preview = oneLine(entry.content, budget)
    const text = isSel ? color(preview, theme.primary, { bold: true }) : color(preview, theme.secondary)
    body.push(` ${marker} ${ord}${time}  ${text}`)
  })
  if (hasCounter) body.push(`  ${color(`（${selected + 1}/${data.entries.length}）`, theme.dim)}`)
}

function buildActionBody(body: string[], data: RewindData, selected: number, w: number, theme: RivetTheme): void {
  const entry = data.entries[selected]
  if (entry) {
    body.push(` ${color('回溯到：', theme.dim)}${color(`#${entry.index}`, theme.muted)}  ${color(oneLine(entry.content, w - 14), theme.secondary)}`)
    body.push('')
  }

  const actIdx = Math.max(0, Math.min(data.actionIndex ?? 0, ACTIONS.length - 1))
  ACTIONS.forEach((a, i) => {
    const isSel = i === actIdx
    const marker = isSel ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const titleTxt = isSel ? color(a.title, theme.primary, { bold: true }) : color(a.title, theme.secondary)
    body.push(` ${marker} ${titleTxt}`)
    body.push(`     ${color(a.desc, theme.dim)}`)
  })

  const mode = ACTIONS[actIdx]?.mode
  if (mode === 'code' || mode === 'both') {
    body.push('')
    const files = data.previewFiles ?? []
    if (files.length === 0) {
      body.push(`  ${color('本消息之后没有 agent 编辑过的文件可精确恢复。', theme.muted)}`)
    } else {
      body.push(`  ${color(`将影响 ${files.length} 个文件：`, theme.muted)}`)
      const shown = files.slice(0, 8)
      shown.forEach(f => {
        const badge = f.action === 'delete' ? color('删除', theme.error) : color('还原', theme.primary)
        body.push(`    ${badge}  ${color(oneLine(f.path, w - 10), theme.secondary)}`)
      })
      if (files.length > shown.length) {
        body.push(`    ${color(`… 另有 ${files.length - shown.length} 个`, theme.dim)}`)
      }
    }
  }
}
