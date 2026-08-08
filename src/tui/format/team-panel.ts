/**
 * T9 格式化函数 — 子代理 TeamPanel（团队协作面板）。
 *
 * 覆盖 /team standard 与 /team max 两种编排模式的实时 DAG 展示，
 * 以及末波审查门（review gate）verdict 的语义化呈现。
 *
 * 与 /tasks overlay 同一套视觉语言：
 *  - 状态语义色：running=primary / done=success / failed=error / blocked=warning
 *  - 进度条语义色：全完成→success，有失败→warning，进行中→primary
 *  - 风险分级：high→error ⚠ / medium→warning / low→muted
 *  - 层级靠缩进 + ⎿ 续行表达（对齐 worker-fleet 树形风格）
 *
 * buildTeamPanelLines 输出纯文本（宽度计算/测试用），formatTeamPanel 输出
 * 分段上色的 ANSI 行——两者出自同一 entry 构建器，保证结构一致。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { TeamPanelModel, TeamPanelStatus, TeamPanelTask } from '../team-panel-model.js'

function statusGlyph(status: TeamPanelStatus): string {
  switch (status) {
    case 'done': return '✓'
    case 'running': return '◐'
    case 'blocked': return '⊗'
    case 'failed': return '✗'
    case 'waiting': return '◌'
  }
}

function statusColorKey(status: TeamPanelStatus): keyof RivetTheme {
  switch (status) {
    case 'done': return 'success'
    case 'running': return 'primary'
    case 'failed': return 'error'
    case 'blocked': return 'warning'
    case 'waiting': return 'dim'
  }
}

function riskMark(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'high') return 'high ⚠'
  return risk
}

function riskColorKey(risk: 'low' | 'medium' | 'high'): keyof RivetTheme {
  if (risk === 'high') return 'error'
  if (risk === 'medium') return 'warning'
  return 'muted'
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

function formatElapsed(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${ms}ms`
}

function bar(done: number, total: number, segments: number): string {
  const ratio = total > 0 ? Math.min(1, done / total) : 0
  const filled = Math.round(ratio * segments)
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, segments - filled))}`
}

/** 进度条语义色：全完成→success，有失败→warning，其余→primary（与 /tasks 组头一致）。 */
function barColorKey(done: number, total: number, hasFailed: boolean): keyof RivetTheme {
  if (total > 0 && done === total) return 'success'
  if (hasFailed) return 'warning'
  return 'primary'
}

/** 审查门 verdict 语义分类（footer 段与审查详情展示共用）。 */
function classifyVerdict(verdict: string | undefined): 'pending' | 'passed' | 'failed' | 'other' {
  if (!verdict) return 'pending'
  const normalized = verdict.trim().toLowerCase().replace(/[\s_-]+/g, '-')
  if (['pass', 'passed', 'verified', 'approve', 'approved', 'ok', 'clean', 'green', 'no-findings'].includes(normalized)) return 'passed'
  if (['fail', 'failed', 'rejected', 'reject', 'blocked', 'changes-requested', 'red'].includes(normalized)) return 'failed'
  return 'other'
}

/** 审查门 verdict → 展示段（glyph + 文案 + 语义色）。 */
function gateSegment(verdict: string | undefined): { text: string; colorKey: keyof RivetTheme } {
  switch (classifyVerdict(verdict)) {
    case 'pending': return { text: '审查门 ○ 待审', colorKey: 'muted' }
    case 'passed': return { text: `审查门 ✓ ${verdict}`, colorKey: 'success' }
    case 'failed': return { text: `审查门 ✗ ${verdict}`, colorKey: 'error' }
    case 'other': return { text: `审查门 · ${verdict}`, colorKey: 'warning' }
  }
}

/**
 * 单行 = 若干 (text, colorKey?) 分段。plain = 段落拼接；colored = 逐段上色。
 * colorKey 为空的段落用默认前景色。
 */
type Segment = { text: string; colorKey?: keyof RivetTheme; bold?: boolean }
type PanelLine = Segment[]

function seg(text: string, colorKey?: keyof RivetTheme, bold?: boolean): Segment {
  return bold ? { text, colorKey: colorKey ?? 'primary', bold } : (colorKey ? { text, colorKey } : { text })
}

/** live 区精简选项。scrollback 里的终态面板不传，保持完整详情。 */
export interface TeamPanelFormatOptions {
  /**
   * 精简模式：已完成的波折叠成波头一行、每任务至多一条续行、展开任务数封顶。
   * 面板高度随 DAG 规模无界增长时，会被定高视口的高水位固化成输入框上方的
   * 常驻空白——live 区只需看清当前在跑什么，历史波次的逐任务详情在 scrollback。
   */
  compact?: boolean
  /** 精简模式下展开的任务数上限，超出折叠成 `…(+N)`。 */
  maxTasks?: number
}

const COMPACT_MAX_TASKS = 6

function buildEntries(model: TeamPanelModel, width: number, opts?: TeamPanelFormatOptions): PanelLine[] {
  const rule = Math.min(Math.max(48, width), 76)
  const out: PanelLine[] = []
  const tasks = new Map(model.tasks.map(t => [t.id, t]))
  const compact = opts?.compact === true
  const maxTasks = Math.max(1, opts?.maxTasks ?? COMPACT_MAX_TASKS)
  let shownTasks = 0
  let hiddenTasks = 0

  // ── 标题行：◆ 团队编队 · 模式 · wave 进度 ──────────────────────
  // max 模式高亮（warning bold）——它意味着更强模型/更高预算，值得一眼看出。
  const waveLabel = model.totalWaves > 0 ? `wave ${Math.min(model.currentWave + 1, model.totalWaves)}/${model.totalWaves}` : ''
  const header: PanelLine = [
    seg('◆ ', 'primary'),
    seg('团队编队', 'secondary', true),
    seg(' /team ', 'muted'),
    model.mode === 'max' ? seg('max', 'warning', true) : seg(model.mode, 'muted'),
  ]
  if (waveLabel) header.push(seg(`  ${waveLabel}`, 'muted'))
  out.push(header)

  if (model.waves.length === 0) {
    out.push([seg('  （无可派发的波次）', 'muted')])
  }

  // ── 波次 + 任务 ───────────────────────────────────────────────
  // task id 列宽对齐（同面板内所有 id 等宽，状态列竖直对齐）
  const idWidth = Math.max(2, ...model.tasks.map(t => t.id.length))

  for (const [index, wave] of model.waves.entries()) {
    const waveTasks = wave.taskIds.map(id => tasks.get(id)).filter((t): t is TeamPanelTask => Boolean(t))
    const waveDone = waveTasks.filter(t => t.status === 'done').length
    const waveFailed = waveTasks.some(t => t.status === 'failed' || t.status === 'blocked')
    const complete = waveTasks.length > 0 && waveDone === waveTasks.length
    const active = index === model.currentWave && !complete
    const waveGlyph = complete ? '✓' : active ? '◐' : '◌'
    const waveGlyphColor: keyof RivetTheme = complete ? 'success' : active ? 'primary' : 'dim'

    // 波头：glyph + id + 进度条 + 计数 + 风险 + 原因（一行浓缩）
    const waveLine: PanelLine = [
      seg(` ${waveGlyph} `, waveGlyphColor),
      seg(wave.id, active ? 'secondary' : 'muted', active),
      seg('  '),
      seg(bar(waveDone, waveTasks.length, 8), barColorKey(waveDone, waveTasks.length, waveFailed)),
      seg(` ${waveDone}/${waveTasks.length}`, 'muted'),
      seg('  '),
      seg(riskMark(wave.risk), riskColorKey(wave.risk)),
    ]
    if (wave.reason) waveLine.push(seg(`  ${truncate(wave.reason, Math.max(8, rule - 30))}`, 'dim'))
    out.push(waveLine)

    // 精简模式：已完成的波只留波头（进度条已表达结果），不逐任务展开。
    if (compact && complete) continue

    for (const task of waveTasks) {
      if (compact) {
        if (shownTasks >= maxTasks) {
          hiddenTasks++
          continue
        }
        shownTasks++
      }
      const glyph = statusGlyph(task.status)
      const glyphColor = statusColorKey(task.status)
      // 任务行：缩进 + glyph + id(对齐列) + title；终态/待命降 muted 聚焦运行中
      const titleColor: keyof RivetTheme | undefined = task.status === 'running' ? undefined : 'muted'
      const idTag = task.identity ? `  ${task.identity.glyph} ${task.identity.name}` : ''
      const line: PanelLine = [
        seg('   '),
        seg(glyph, glyphColor),
        seg(' '),
        seg(task.id.padEnd(idWidth), task.status === 'running' ? 'secondary' : 'muted'),
        seg('  '),
        titleColor ? seg(truncate(task.title, Math.max(8, rule - idWidth - 10)), titleColor) : seg(truncate(task.title, Math.max(8, rule - idWidth - 10))),
      ]
      if (idTag) line.push(seg(idTag, 'dim'))
      out.push(line)

      // ⎿ 续行：依赖 / 实时活动 / 终态摘要（muted，一类一行）
      const cont = `     ${'⎿'} `
      const depLine = task.dependsOn.length > 0 && task.status === 'waiting'
        ? `依赖 ${task.dependsOn.join(', ')}`
        : null
      const liveMeta: string[] = []
      if (typeof task.elapsedMs === 'number' && task.status !== 'waiting') liveMeta.push(formatElapsed(task.elapsedMs))
      if (task.activity) liveMeta.push(task.activity)
      const metaLine = liveMeta.length > 0 ? liveMeta.join(' · ') : null
      const summaryLine = task.summary && task.status !== 'waiting' ? task.summary : null

      if (compact) {
        // 一任务至多一条续行：正在跑的看活动，跑完的看摘要，没起跑的看依赖。
        const only = metaLine ?? summaryLine ?? depLine
        if (only) out.push([seg(cont, 'dim'), seg(truncate(only, rule - 8), 'muted')])
      } else {
        if (depLine) out.push([seg(cont, 'dim'), seg(depLine, 'muted')])
        if (metaLine) out.push([seg(cont, 'dim'), seg(truncate(metaLine, rule - 8), 'muted')])
        if (summaryLine) out.push([seg(cont, 'dim'), seg(truncate(summaryLine, rule - 8), 'muted')])
      }
    }
  }

  if (hiddenTasks > 0) {
    out.push([seg('   '), seg(`…(+${hiddenTasks}) 个任务 · /tasks 查看`, 'dim')])
  }

  // ── 阻塞列表（有才显示，警告色） ─────────────────────────────────
  if (model.blocked.length > 0) {
    out.push([seg(' ⊗ ', 'warning'), seg(`阻塞 ${truncate(model.blocked.join('; '), rule - 8)}`, 'warning')])
  }

  // ── 波间硬门禁失败卡（W2b，与桌面 gateFailed 卡同源数据）─────────────
  // 只在失败时渲染——通过是常态，不占行。失败项逐条列出（封顶 4 条），
  // 尾行给出续跑指引（与 wave-gate.ts 的逃生阀一致）。
  if (model.gate && !model.gate.passed) {
    out.push([seg(' ⛔ ', 'error'), seg(`波间门禁未通过 (Wave ${model.gate.wave})`, 'error', true)])
    const MAX_GATE_FAILURES = 4
    for (const failure of model.gate.failures.slice(0, MAX_GATE_FAILURES)) {
      out.push([seg('    ⎿ ', 'dim'), seg(truncate(failure.replace(/\s+/g, ' ').trim(), rule - 8), 'warning')])
    }
    if (model.gate.failures.length > MAX_GATE_FAILURES) {
      out.push([seg('    ⎿ ', 'dim'), seg(`… 另 ${model.gate.failures.length - MAX_GATE_FAILURES} 项失败`, 'muted')])
    }
    out.push([seg('    ⎿ ', 'dim'), seg('修复失败项后可续跑（逃生阀 RIVET_WAVE_GATE=0）', 'muted')])
  }

  // ── footer：总进度 + 派发数 + 审查门 verdict ─────────────────────
  const doneCount = model.tasks.filter(t => t.status === 'done').length
  const anyFailed = model.tasks.some(t => t.status === 'failed' || t.status === 'blocked')
  const gate = gateSegment(model.reviewVerdict)
  const footer: PanelLine = []
  if (model.tasks.length > 0) {
    footer.push(
      seg(' '),
      seg(bar(doneCount, model.tasks.length, 12), barColorKey(doneCount, model.tasks.length, anyFailed)),
      seg(` ${doneCount}/${model.tasks.length} 完成`, 'muted'),
      seg(' · ', 'dim'),
    )
  } else {
    footer.push(seg(' '))
  }
  footer.push(seg(`${model.dispatched} 已派发`, 'muted'))
  if (model.blocked.length > 0) {
    footer.push(seg(' · ', 'dim'), seg(`${model.blocked.length} 阻塞`, 'warning'))
  }
  footer.push(seg(' · ', 'dim'), seg(gate.text, gate.colorKey))
  out.push(footer)

  // ── 审查详情（W2b reviewDetail）───────────────────────────────────
  // verdict 通过时全文是低价值噪音，不渲染；未过/待定时给审查原文（封顶 6 行），
  // 用户不用切桌面端就能看到"审查到底说了什么"。
  if (model.reviewDetail && classifyVerdict(model.reviewVerdict) !== 'passed') {
    const detailLines = model.reviewDetail
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    if (detailLines.length > 0) {
      out.push([seg(' ✦ ', 'warning'), seg('审查详情', 'warning')])
      const MAX_REVIEW_LINES = 6
      for (const line of detailLines.slice(0, MAX_REVIEW_LINES)) {
        out.push([seg('    ⎿ ', 'dim'), seg(truncate(line, rule - 8), 'muted')])
      }
      if (detailLines.length > MAX_REVIEW_LINES) {
        out.push([seg('    ⎿ ', 'dim'), seg(`… 审查全文共 ${detailLines.length} 行`, 'dim')])
      }
    }
  }

  return out
}

/**
 * 生成 TeamPanel 的纯文本行（无颜色，便于宽度计算/测试）。
 */
export function buildTeamPanelLines(model: TeamPanelModel, width = 80, opts?: TeamPanelFormatOptions): string[] {
  return buildEntries(model, width, opts).map(line => line.map(s => s.text).join(''))
}

/**
 * 渲染 TeamPanel 为分段上色的 ANSI 行（语义色与 /tasks overlay 一致）。
 */
export function formatTeamPanel(model: TeamPanelModel, theme: RivetTheme, width = 80, opts?: TeamPanelFormatOptions): string[] {
  return buildEntries(model, width, opts).map(line =>
    line.map(s => {
      if (!s.colorKey) return s.text
      const accent = theme[s.colorKey] as string
      return s.bold ? color(s.text, accent, { bold: true }) : color(s.text, accent)
    }).join(''),
  )
}
