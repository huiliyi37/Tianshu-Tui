/**
 * activity-store — 活动源归一投影模型 + 单一渲染出口。
 *
 * 把 fleet / team / todo / council 四个活动数据源投影到统一形状
 * `ActivityItem`，经 `ActivityStore` 合并后交给 `formatActivityBand` 渲染。
 * 各 panel-model（fleet-registry / team-panel-model / council-panel-model /
 * todo-store）只新增只读出口，不改内部结构。
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
import { formatWorkerIdentity, authorityStarName } from './format/profile-labels.js'
import { formatElapsed } from './worker-panel-model.js'
import { color } from './engine/ansi.js'
import type { RivetTheme } from './theme.js'
import { displayWidth, truncateToDisplayWidth } from './width.js'

export type ActivityKind = 'agent' | 'council-seat' | 'team-task' | 'todo'
export type ActivityStatus = 'pending' | 'running' | 'done' | 'failed'
export type ActivityGroupId = 'council' | 'team' | 'fleet' | 'todo'

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
    case 'passed':
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
 */
export class ActivityStore {
  private fleetWorkers: readonly FleetWorkerView[] = []
  private councilModel: CouncilPanelModel | null = null
  private teamModel: TeamPanelModel | null = null
  private todoItems: readonly TodoItem[] = []

  setFleet(workers: readonly FleetWorkerView[]): void { this.fleetWorkers = workers }
  setCouncil(model: CouncilPanelModel | null): void { this.councilModel = model }
  setTeam(model: TeamPanelModel | null): void { this.teamModel = model }
  setTodo(items: readonly TodoItem[]): void { this.todoItems = items }

  /** 归一投影：council 席位经规范化键与 fleet 去重合并。 */
  project(): ActivityItem[] {
    return mergeActivityItems([
      projectFleet(this.fleetWorkers),
      projectCouncil(this.councilModel),
      projectTeam(this.teamModel),
      projectTodo(this.todoItems),
    ])
  }

  clear(): void {
    this.fleetWorkers = []
    this.councilModel = null
    this.teamModel = null
    this.todoItems = []
  }
}

// ── formatActivityBand（chrome 段单一渲染出口）──────────────────────

const GROUP_ORDER: ActivityGroupId[] = ['council', 'team', 'fleet', 'todo']

export interface ActivityBandOptions {
  /** item 行数上限（不含分组头与折叠行），超出折叠为 `…(+N)`。默认 6。 */
  maxRows?: number
  /** 行宽预算（display-width 口径）。默认 80。 */
  width?: number
}

const WIDE = { ambiguousAsWide: true }

/** 省略号自身的显示宽度：`…` 在 ambiguous-wide 口径下占 2 列，预留 1 列会溢出。 */
const ELLIPSIS_W = displayWidth('…', WIDE)

function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  const flat = text.replace(/\s+/g, ' ').trimEnd()
  if (displayWidth(flat, WIDE) <= max) return flat
  return `${truncateToDisplayWidth(flat, Math.max(1, max - ELLIPSIS_W), WIDE)}…`
}

function statusGlyph(status: ActivityStatus): string {
  switch (status) {
    case 'running': return '◐'
    case 'done': return '✓'
    case 'failed': return '✗'
    default: return '○'
  }
}

function groupHeader(gid: ActivityGroupId, group: readonly ActivityItem[]): string {
  const done = group.filter(i => i.status === 'done').length
  const running = group.filter(i => i.status === 'running').length
  const total = group.length
  switch (gid) {
    case 'council': return ` ◐ 议事会 · ${done}/${total} 席`
    case 'team': return ` ◐ 编队 · ${running} 执行中`
    case 'fleet': return ` ◐ ${running} 子代理执行中`
    case 'todo': return ` ◐ 待办 · ${done}/${total}`
  }
}

function itemTail(item: ActivityItem): string {
  const parts: string[] = []
  if (item.subLabel) parts.push(item.subLabel)
  if (item.kind === 'council-seat' && item.round !== undefined) parts.push(`r${item.round}`)
  if (item.kind === 'council-seat' && item.modelUsed) parts.push(item.modelUsed)
  if (item.kind === 'team-task' && item.phaseIndex !== undefined) parts.push(`波${item.phaseIndex + 1}`)
  if (item.elapsedMs !== undefined) {
    const elapsed = formatElapsed(item.elapsedMs)
    if (elapsed) parts.push(elapsed)
  }
  return parts.length > 0 ? `  ${parts.join(' · ')}` : ''
}

interface BandLine {
  text: string
  kind: 'header' | 'item' | 'overflow'
  status?: ActivityStatus
}

function buildEntries(items: readonly ActivityItem[], opts: ActivityBandOptions): BandLine[] {
  const maxRows = Math.max(1, opts.maxRows ?? 6)
  const width = Math.max(20, opts.width ?? 80)
  const rule = Math.min(Math.max(40, width), 80)

  const byGroup = new Map<ActivityGroupId, ActivityItem[]>()
  for (const item of items) {
    const gid = (item.groupId ?? 'fleet') as ActivityGroupId
    if (!byGroup.has(gid)) byGroup.set(gid, [])
    byGroup.get(gid)!.push(item)
  }

  const lines: BandLine[] = []
  let shown = 0
  let hidden = 0
  for (const gid of GROUP_ORDER) {
    const group = byGroup.get(gid)
    if (!group || group.length === 0) continue
    // 预算已耗尽：整组计入折叠计数，**不渲染组头**——只剩一个「3 子代理执行中」
    // 而底下一行内容都没有，是纯噪音，还白占一行。
    if (shown >= maxRows) {
      hidden += group.length
      continue
    }
    lines.push({ text: groupHeader(gid, group), kind: 'header' })
    for (const item of group) {
      if (shown >= maxRows) {
        hidden++
        continue
      }
      const head = ` ├─ ${statusGlyph(item.status)} ${item.label}`
      lines.push({ text: truncate(`${head}${itemTail(item)}`, rule), kind: 'item', status: item.status })
      shown++
    }
  }
  if (hidden > 0) lines.push({ text: ` └─ …(+${hidden})`, kind: 'overflow' })
  return lines
}

/** 纯文本 band 行（无颜色，便于测试与复用）。 */
export function buildActivityBandLines(items: readonly ActivityItem[], opts: ActivityBandOptions = {}): string[] {
  return buildEntries(items, opts).map(l => l.text)
}

/**
 * 带色 band 行（chrome 段）：头/折叠 muted，running → primary，done → success，
 * failed → error，pending → muted。
 */
export function formatActivityBand(items: readonly ActivityItem[], theme: RivetTheme, opts: ActivityBandOptions = {}): string[] {
  return buildEntries(items, opts).map(l => {
    if (l.kind === 'item') {
      if (l.status === 'running') return color(l.text, theme.primary as string)
      if (l.status === 'done') return color(l.text, theme.success as string)
      if (l.status === 'failed') return color(l.text, theme.error as string)
      return color(l.text, theme.muted as string)
    }
    return color(l.text, theme.muted as string)
  })
}
