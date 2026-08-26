/**
 * activity-store — 活动源归一投影模型 + 单一渲染出口。
 *
 * 把 fleet / team / todo / council 四个活动数据源投影到统一形状
 * `ActivityItem`，经 `ActivityStore` 合并后交给 `formatActivityBand` 渲染。
 * 各 panel-model（fleet-registry / team-panel-model / council-panel-model /
 * todo-store）只新增只读出口，不改内部结构。
 * 第五源 jobs（JobRegistry）可并进 chrome 活动带（与子代理同一套计数头 /
 * 行 / 入口），`formatJobsBar` 仍作宽屏侧栏时的单行条逃生门。
 *
 * 关键设计：council 席位同时来自 FleetRegistry（workOrderId 形如
 * `council:seat-<authority>`，round 2 加 `-r2`，复议加 `-retry/-reconvene`
 * 后缀）与 council 帧（CouncilPanelModel.seats，只带 authority）。投影时
 * 用规范化键 `councilSeatKey` 去重合并——漏了会看到两份席位。
 */

import type { FleetWorkerView } from './fleet-registry.js'
import type { TeamPanelModel } from './team-panel-model.js'
import type { CouncilPanelModel } from './council-panel-model.js'
import type { TodoItem } from '../tools/todo-store.js'
import type { JobRow } from './job-registry.js'
import { formatWorkerIdentity, authorityStarName } from './format/profile-labels.js'
import { formatElapsed } from './worker-panel-model.js'
import { color } from './engine/ansi.js'
import type { RivetTheme } from './theme.js'
import { displayWidth, truncateToDisplayWidth } from './width.js'
import { brailleSpinnerFrame } from './braille-spinner.js'
import { formatTokenCount, isReducedMotion } from './format/spinner-status.js'

export type ActivityKind = 'agent' | 'council-seat' | 'team-task' | 'todo' | 'background-job'
export type ActivityStatus = 'pending' | 'running' | 'done' | 'failed'
export type ActivityGroupId = 'council' | 'team' | 'fleet' | 'todo' | 'jobs'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  label: string
  status: ActivityStatus
  groupId?: ActivityGroupId
  authority?: string
  toolUseCount?: number
  tokenCount?: number
  elapsedMs?: number
  subLabel?: string
  /** team wave 序号（0-based，与 TeamPanelModel.currentWave 一致）。 */
  phaseIndex?: number
  /** council round（1 | 2，从 -r2 后缀解析）。 */
  round?: number
  /** council 席位实际派发模型（council 帧补 fleet 拿不到的字段）。 */
  modelUsed?: string
  /** 最新活动行（子代理 ⎿ 子行；缺失则无投影源）。 */
  activity?: string
}

// ── council seat key 规范化（去重合并键）─────────────────────────────

export const COUNCIL_SEAT_PREFIX = 'council:seat-'

/**
 * 'council:seat-<authority>' 及其带后缀变体（-r2 / -retry / -reconvene /
 * -retry-reconvene）→ 规范化去重键 'council:seat-<authority>'。
 * 与 council-convene.ts 的 authority 剥离正则同口径。
 */
export function councilSeatKey(workOrderId: string): string {
  return workOrderId.replace(/(-(?:r2|retry|reconvene))+$/, '')
}

/** 从 workOrderId 解析 round：末尾 `-r2`（可叠 -retry/-reconvene）→ 2，否则 1。 */
export function councilRoundOf(workOrderId: string): number {
  return /-(?:r2)(?:-(?:retry|reconvene))*$/.test(workOrderId) ? 2 : 1
}

// ── 状态映射 ─────────────────────────────────────────────────────────

function fleetStatusOf(status: FleetWorkerView['status']): ActivityStatus {
  switch (status) {
    case 'running': return 'running'
    case 'completed': return 'done'
    default: return 'failed'
  }
}

function councilStatusOf(status: string): ActivityStatus {
  switch (status) {
    case 'running': return 'running'
    case 'passed': return 'done'
    default: return 'failed'
  }
}

function teamStatusOf(status: string): ActivityStatus {
  switch (status) {
    case 'done': return 'done'
    case 'failed':
    case 'blocked': return 'failed'
    case 'running': return 'running'
    default: return 'pending'
  }
}

function todoStatusOf(status: TodoItem['status']): ActivityStatus {
  switch (status) {
    case 'completed': return 'done'
    case 'in_progress': return 'running'
    default: return 'pending'
  }
}

// ── 四个 projector（纯函数，各 panel-model 只读出口）────────────────

/**
 * FleetRegistry 投影：按 workOrderId 前缀分流 council 席位与普通 agent。
 * round 从 `-r2` 后缀解析。council 席位的 id 保留原始 workOrderId（含后缀），
 * 去重在 mergeActivityItems 用 councilSeatKey 规范化完成。
 */
export function projectFleet(workers: readonly FleetWorkerView[]): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const w of workers) {
    const identity = formatWorkerIdentity({ profile: w.profile, authority: w.authority })
    if (w.workerId.startsWith(COUNCIL_SEAT_PREFIX)) {
      items.push({
        id: w.workerId,
        kind: 'council-seat',
        label: w.contract?.objective ?? identity,
        status: fleetStatusOf(w.status),
        groupId: 'council',
        authority: w.authority,
        toolUseCount: w.toolUseCount,
        tokenCount: w.tokenCount,
        elapsedMs: w.elapsedMs,
        subLabel: identity,
        round: councilRoundOf(w.workerId),
        ...(w.activity ? { activity: w.activity } : {}),
      })
    } else {
      items.push({
        id: w.workerId,
        kind: 'agent',
        label: w.contract?.objective ?? w.shortLabel,
        status: fleetStatusOf(w.status),
        groupId: 'fleet',
        authority: w.authority,
        toolUseCount: w.toolUseCount,
        tokenCount: w.tokenCount,
        elapsedMs: w.elapsedMs,
        subLabel: identity,
        ...(w.activity ? { activity: w.activity } : {}),
      })
    }
  }
  return items
}

/**
 * CouncilPanelModel 投影：只补 fleet 拿不到的字段（每席 modelUsed、round）。
 * id 用规范化键 `council:seat-<authority>`，与 fleet 项在 merge 时去重合并，
 * 不重复产出席位。
 */
export function projectCouncil(model: CouncilPanelModel | null): ActivityItem[] {
  if (!model) return []
  return model.seats.map(seat => ({
    id: `${COUNCIL_SEAT_PREFIX}${seat.authority}`,
    kind: 'council-seat',
    label: authorityStarName(seat.authority) ?? seat.authority,
    status: councilStatusOf(seat.status),
    groupId: 'council',
    authority: seat.authority,
    round: seat.round,
    ...(seat.modelUsed ? { modelUsed: seat.modelUsed } : {}),
  }))
}

/**
 * TeamPanelModel 投影：任务 → team-task，phaseIndex 取 wave 序号（0-based）。
 * 完整 DAG（wave 进度条 / 依赖 / gate）仍走 /tasks 与终态 scrollback 卡。
 */
export function projectTeam(model: TeamPanelModel | null): ActivityItem[] {
  if (!model) return []
  const waveOf = new Map<string, number>()
  model.waves.forEach((w, i) => {
    for (const tid of w.taskIds) waveOf.set(tid, i)
  })
  return model.tasks.map(task => ({
    id: task.id,
    kind: 'team-task',
    label: task.title,
    status: teamStatusOf(task.status),
    groupId: 'team',
    authority: task.authority,
    elapsedMs: task.elapsedMs,
    subLabel: formatWorkerIdentity({ profile: task.profile, authority: task.authority }),
    phaseIndex: waveOf.get(task.id),
  }))
}

/** TodoStore 投影：label 优先进行中的现在时 activeForm，回退 content。 */
export function projectTodo(items: readonly TodoItem[]): ActivityItem[] {
  return items.map(t => ({
    id: t.id,
    kind: 'todo',
    label: t.activeForm ?? t.content,
    status: todoStatusOf(t.status),
    groupId: 'todo',
  }))
}

/**
 * JobRegistry 投影（第五源）：只取 running——终态已由 scrollback 完成行与
 * /jobs overlay 承载，实时条只回答「现在还有几个在跑」。label 用压平后的
 * 命令；与 fleet 预计算 elapsedMs 不同，job 行只存 startedAt，投影时按
 * 调用方 nowMs 现算（chrome 单行条消费，不进 project()/band 合并）。
 */
export function projectJobs(rows: readonly JobRow[], nowMs: number): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const r of rows) {
    if (r.terminal) continue
    items.push({
      id: r.id,
      kind: 'background-job',
      label: r.command.replace(/\s+/g, ' ').trim(),
      status: 'running',
      groupId: 'jobs',
      elapsedMs: Math.max(0, nowMs - r.startedAt),
    })
  }
  return items
}

// ── 去重合并 ─────────────────────────────────────────────────────────

/** 同 id（council 席位按规范化键）合并：保留先到者 label/subLabel/status，
 *  后到者（council 帧）只补 modelUsed，round 取更大值，id 用规范化键。 */
function mergeItem(a: ActivityItem, b: ActivityItem): ActivityItem {
  const merged = { ...a }
  // council 席位：id 规范化（去 -r2/-retry/-reconvene 后缀）
  if (a.kind === 'council-seat') merged.id = councilSeatKey(a.id)
  // council 帧补充字段（不覆盖 fleet 的 label/subLabel）
  if (b.modelUsed) merged.modelUsed = b.modelUsed
  if (b.round !== undefined && (a.round === undefined || b.round > a.round)) merged.round = b.round
  if (b.phaseIndex !== undefined && (a.phaseIndex === undefined || b.phaseIndex > a.phaseIndex)) {
    merged.phaseIndex = b.phaseIndex
  }
  // 后到者的非 pending 状态覆盖前者的 pending（防御：帧在 fleet 前到达）。
  if (a.status === 'pending' && b.status !== 'pending') merged.status = b.status
  return merged
}

/**
 * 把多组投影合并为单一列表，按 id 去重（council 席位用 councilSeatKey 规范化）。
 * 顺序：组内保持输入顺序，council 帧只补 fleet 项缺失字段，不产重复席位。
 */
export function mergeActivityItems(groups: readonly (readonly ActivityItem[])[]): ActivityItem[] {
  const byKey = new Map<string, ActivityItem>()
  const order: string[] = []
  for (const group of groups) {
    for (const item of group) {
      const key = item.kind === 'council-seat' ? councilSeatKey(item.id) : item.id
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, item)
        order.push(key)
      } else {
        byKey.set(key, mergeItem(existing, item))
      }
    }
  }
  return order.map(key => byKey.get(key)!)
}

// ── ActivityStore ─────────────────────────────────────────────────────

/**
 * 聚合四个活动源、投影并归一合并的只读容器。调用方在每次 live 重绘前
 * set* 最新快照，project() 返回去重后的 ActivityItem[]。
 * 第五源 jobs（setJobs）走独立出口 projectJobs()——调用方决定并进活动带
 * 还是走 formatJobsBar 单行条。不进 project() 合并，避免侧栏/测试把 jobs
 * 当成第四活动源。
 */
export class ActivityStore {
  private fleetWorkers: readonly FleetWorkerView[] = []
  private councilModel: CouncilPanelModel | null = null
  private teamModel: TeamPanelModel | null = null
  private todoItems: readonly TodoItem[] = []
  private jobRows: readonly JobRow[] = []
  private jobsNowMs = 0

  setFleet(workers: readonly FleetWorkerView[]): void { this.fleetWorkers = workers }
  setCouncil(model: CouncilPanelModel | null): void { this.councilModel = model }
  setTeam(model: TeamPanelModel | null): void { this.teamModel = model }
  setTodo(items: readonly TodoItem[]): void { this.todoItems = items }
  /** jobs 快照 + 现算时刻（elapsed 在投影时换算，随每帧 set 刷新）。 */
  setJobs(rows: readonly JobRow[], nowMs: number): void { this.jobRows = rows; this.jobsNowMs = nowMs }

  /** 归一投影：council 席位经规范化键与 fleet 去重合并。 */
  project(): ActivityItem[] {
    return mergeActivityItems([
      projectFleet(this.fleetWorkers),
      projectCouncil(this.councilModel),
      projectTeam(this.teamModel),
      projectTodo(this.todoItems),
    ])
  }

  /** 后台任务投影（running only）：chrome 单行实时条的数据源。 */
  projectJobs(): ActivityItem[] {
    return projectJobs(this.jobRows, this.jobsNowMs)
  }

  clear(): void {
    this.fleetWorkers = []
    this.councilModel = null
    this.teamModel = null
    this.todoItems = []
    this.jobRows = []
    this.jobsNowMs = 0
  }
}

// ── formatActivityBand（chrome 段单一渲染出口）──────────────────────
//
// 对标 dsh-tui activity-band：只放 running；>1 条时一条统一计数头；
// 每 item 恒 1 行（后缀从右丢）；仅最新子代理/席一条 `⎿`；常驻 /tasks 尾行。
// 完成项塌进 scrollback 沉淀卡与 /tasks，不占 chrome 高度。

const KIND_ORDER: readonly ActivityKind[] = [
  'agent',
  'team-task',
  'council-seat',
  'background-job',
  'todo',
]

const KIND_NAMES: Record<ActivityKind, string> = {
  agent: '子代理',
  'team-task': '编队',
  'council-seat': '席',
  'background-job': '后台任务',
  todo: '待办',
}

const ENTRY_PLAIN = '/tasks 管理'
const INITIALIZING = '启动中…'
const ASCII_SPIN = ['-', '\\', '|', '/'] as const

export interface ActivityBandOptions {
  /** item 行数上限（不含计数头 / ⎿ / 尾行），超出折叠为 `…(+N)`。默认 6。 */
  maxRows?: number
  /** 行宽预算（display-width 口径）。默认 80。 */
  width?: number
  /** spinner 帧计数（running 子代理/席字形随 tick 旋转）。 */
  tick?: number
  /** ascii 降级（spinner → `-`/`|` 轮转）。 */
  ascii?: boolean
}

const WIDE = { ambiguousAsWide: true }

/** 省略号自身的显示宽度：`…` 在 ambiguous-wide 口径下占 2 列，预留 1 列会溢出。 */
const ELLIPSIS_W = displayWidth('…', WIDE)

function truncateToLiveWidth(text: string, max: number): string {
  if (max <= 1) return '…'
  if (displayWidth(text, WIDE) <= max) return text
  return `${truncateToDisplayWidth(text, Math.max(1, max - ELLIPSIS_W), WIDE)}…`
}

function assembleSuffixes(base: string, suffixes: readonly string[], width: number): string {
  let out = base
  for (const suffix of suffixes) {
    const candidate = `${out} · ${suffix}`
    if (displayWidth(candidate, WIDE) > width - 1) break
    out = candidate
  }
  return truncateToLiveWidth(out, width)
}

function runningGlyph(opts: ActivityBandOptions): string {
  const ascii = opts.ascii === true
  if (isReducedMotion()) return ascii ? '-' : '◐'
  const tick = opts.tick ?? 0
  if (ascii) {
    const idx = ((tick % ASCII_SPIN.length) + ASCII_SPIN.length) % ASCII_SPIN.length
    return ASCII_SPIN[idx] ?? '-'
  }
  return brailleSpinnerFrame(tick)
}

function itemGlyph(item: ActivityItem, opts: ActivityBandOptions): string {
  if (item.kind === 'team-task') return opts.ascii === true ? '~' : '⏳'
  if (item.kind === 'background-job' || item.kind === 'todo') return '›'
  return runningGlyph(opts)
}

function isAgentLike(item: ActivityItem): boolean {
  return item.kind === 'agent' || item.kind === 'council-seat'
}

function itemSuffixes(item: ActivityItem): string[] {
  const parts: string[] = []
  if (item.toolUseCount !== undefined && item.toolUseCount > 0) {
    parts.push(`${item.toolUseCount} 工具`)
  }
  if (item.tokenCount !== undefined && item.tokenCount > 0) {
    parts.push(`${formatTokenCount(item.tokenCount)} tok`)
  }
  if (item.subLabel) parts.push(item.subLabel)
  if (item.kind === 'council-seat' && item.round !== undefined) parts.push(`r${item.round}`)
  if (item.kind === 'council-seat' && item.modelUsed) parts.push(item.modelUsed)
  if (item.kind === 'team-task' && item.phaseIndex !== undefined) parts.push(`波${item.phaseIndex + 1}`)
  if (item.elapsedMs !== undefined) {
    const elapsed = formatElapsed(item.elapsedMs)
    if (elapsed) parts.push(elapsed)
  }
  return parts
}

function formatHeader(items: readonly ActivityItem[]): string {
  const parts: string[] = []
  for (const kind of KIND_ORDER) {
    const count = items.filter(item => item.kind === kind).length
    if (count > 0) parts.push(`${count} ${KIND_NAMES[kind]}`)
  }
  return `◐ ${parts.join(' · ')}`
}

function projectItemRow(item: ActivityItem, opts: ActivityBandOptions, theme?: RivetTheme): string {
  const width = Math.max(20, opts.width ?? 80)
  const glyph = itemGlyph(item, opts)
  const label = item.label.replace(/\s+/g, ' ').trim()
  const base = theme === undefined
    ? ` ${glyph} ${label}`
    : ` ${color(glyph, theme.primary as string)} ${label}`
  const suffixes = itemSuffixes(item)
  const painted = theme === undefined
    ? suffixes
    : suffixes.map(suffix => color(suffix, theme.muted as string))
  return assembleSuffixes(base, painted, width)
}

function projectAgentSubline(item: ActivityItem, opts: ActivityBandOptions): string | null {
  const width = Math.max(20, opts.width ?? 80)
  if (item.activity) {
    const flat = item.activity.replace(/\s+/g, ' ').trim()
    return truncateToLiveWidth(` ⎿ ${flat}`, width)
  }
  if (item.toolUseCount === 0) return truncateToLiveWidth(` ⎿ ${INITIALIZING}`, width)
  return null
}

function recencyMs(item: ActivityItem): number {
  return item.elapsedMs ?? Number.POSITIVE_INFINITY
}

interface BandLine {
  text: string
  kind: 'header' | 'item' | 'subline' | 'footer'
}

function buildEntries(items: readonly ActivityItem[], opts: ActivityBandOptions, theme?: RivetTheme): BandLine[] {
  const active = items
    .filter(item => item.status === 'running')
    .slice()
    .sort((a, b) => recencyMs(a) - recencyMs(b))
  if (active.length === 0) return []

  const width = Math.max(20, opts.width ?? 80)
  const maxRows = Math.max(1, opts.maxRows ?? 6)
  const shown = active.slice(0, maxRows)
  const newestAgentIdx = active.findIndex(isAgentLike)
  const paint = (text: string, key: 'muted' | 'dim'): string =>
    theme === undefined ? text : color(text, theme[key] as string)

  const lines: BandLine[] = []
  if (active.length > 1) {
    lines.push({ text: paint(truncateToLiveWidth(formatHeader(active), width), 'muted'), kind: 'header' })
  }
  for (let i = 0; i < shown.length; i++) {
    const item = shown[i]!
    lines.push({ text: projectItemRow(item, opts, theme), kind: 'item' })
    if (i === newestAgentIdx) {
      const subline = projectAgentSubline(item, opts)
      if (subline !== null) lines.push({ text: paint(subline, 'dim'), kind: 'subline' })
    }
  }
  const overflow = active.length - shown.length
  const entry = overflow > 0 ? `└ …(+${overflow}) · ${ENTRY_PLAIN}` : ENTRY_PLAIN
  lines.push({ text: paint(truncateToLiveWidth(entry, width), 'dim'), kind: 'footer' })
  return lines
}

/** 纯文本 band 行（无颜色，便于测试与复用）。 */
export function buildActivityBandLines(items: readonly ActivityItem[], opts: ActivityBandOptions = {}): string[] {
  return buildEntries(items, opts).map(l => l.text)
}

/**
 * 带色 band 行（chrome 段）：计数头 muted，item 字形 primary / 后缀 muted，
 * ⎿ 与入口尾行 dim。
 */
export function formatActivityBand(items: readonly ActivityItem[], theme: RivetTheme, opts: ActivityBandOptions = {}): string[] {
  return buildEntries(items, opts, theme).map(l => l.text)
}

/**
 * 运行中后台任务实时条（CC 输入区下方任务条对标）：单行汇总
 * ` ⚙ N 后台任务 · <首个 running 命令截断> · <最长已跑>`。无 running 返回 null
 * （不渲染）。elapsed 取自投影时现算的 elapsedMs，随 live 帧重绘自然刷新。
 */
export function formatJobsBar(items: readonly ActivityItem[], theme: RivetTheme): string | null {
  const running = items.filter(i => i.kind === 'background-job' && i.status === 'running')
  if (running.length === 0) return null
  const maxElapsed = Math.max(...running.map(i => i.elapsedMs ?? 0))
  const elapsed = formatElapsed(maxElapsed)
  const cmd = truncateToLiveWidth(running[0]!.label.replace(/\s+/g, ' ').trim(), 36)
  const head = ` ⚙ ${running.length} 后台任务`
  const tail = elapsed ? ` · ${cmd} · ${elapsed}` : ` · ${cmd}`
  return color(head, theme.primary as string) + color(tail, theme.muted as string)
}
