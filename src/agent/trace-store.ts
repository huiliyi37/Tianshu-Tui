import { createHash } from 'node:crypto'

export type TraceEventKind = 'model' | 'tool' | 'verification' | 'checkpoint' | 'cache'
export type TraceEventStatus = 'running' | 'passed' | 'failed' | 'blocked'
export type DoomLoopLevel = 'none' | 'warn' | 'blocked'

export interface TraceEvent {
  id: string
  turn: number
  kind: TraceEventKind
  name: string
  status: TraceEventStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  summary?: string
  rawPath?: string
  predictedSuccess?: boolean
}

export type TraceEventStartInput = Pick<TraceEvent, 'id' | 'turn' | 'kind' | 'name' | 'startedAt' | 'summary' | 'predictedSuccess'>

export interface TraceStore {
  maxEvents: number
  events: TraceEvent[]
  toolFingerprints: string[]
  toolNameHistory?: string[]
  /** 独立于 doom 指纹的「轮询活动类」轨迹（P0-1 polling-storm guard）：
   *  只记录会被用于判定轮询的工具类（bash 命令类 + 观察型工具）。
   *  成功/失败都记录；绝不给 doom-loop 检测消费，避免污染失败循环语义。 */
  toolPollingClasses?: string[]
  /** 单调递增的总追加轮询记录数（不受 slice(-24) 裁剪）。「本轮是否有新增轮询
   *  记录」用该计数判定，而不是裁剪后数组长度：toolPollingClasses 长度到 24
   *  上限后恒定不变，用长度代理会让 hasNewPolling 恒为 false，守卫在长会话里
   *  静默失效（streak 只衰减、abort 分支不可达）。 */
  toolPollingCount?: number
  /** bash 命令类指纹（归一化后的命令类，如 "git:status·success"）。
   *  精确指纹对 sed/head/python/tee 变体免疫——每个变体都是新 hash，
   *  doom-loop 检测器全程不拦（会话 43443098：28 次 git status 变体零拦截）。
   *  类指纹把同一命令类的变体归并，配合 getClassDoomLoopLevel 的保守阈值拦截。 */
  bashClassFingerprints?: string[]
}

export function createTraceStore(maxEvents = 50): TraceStore {
  return { maxEvents, events: [], toolFingerprints: [] }
}

function capEvents(store: TraceStore, events: TraceEvent[]): TraceEvent[] {
  return events.slice(-store.maxEvents)
}

export function recordTraceEvent(store: TraceStore, event: TraceEvent): TraceStore {
  return { ...store, events: capEvents(store, [...store.events, event]) }
}

export function startTraceEvent(
  store: TraceStore,
  input: TraceEventStartInput,
): TraceStore {
  return recordTraceEvent(store, { ...input, status: 'running' })
}

export function finishTraceEvent(
  store: TraceStore,
  id: string,
  update: { status: TraceEventStatus; endedAt: number; summary?: string; rawPath?: string },
): TraceStore {
  const events = store.events.map(event => {
    if (event.id !== id) return event
    return {
      ...event,
      ...update,
      durationMs: Math.max(0, update.endedAt - event.startedAt),
    }
  })
  return { ...store, events }
}

function sortedStringify(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key]
    sorted[key] = val && typeof val === 'object' && !Array.isArray(val)
      ? JSON.parse(sortedStringify(val as Record<string, unknown>))
      : val
  }
  return JSON.stringify(sorted)
}

export function fingerprintToolCall(
  name: string,
  input: Record<string, unknown>,
  outputClass: string,
): string {
  const payload = sortedStringify({ name, input, outputClass })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** Binaries whose first non-flag argument is a subcommand worth distinguishing
 *  (npm test ≠ npm install). Keeps class granularity coarse enough to merge
 *  variants but fine enough to avoid flagging normal multi-step workflows. */
const SUBCOMMAND_BINARIES = new Set(['git', 'npm', 'pnpm', 'yarn', 'cargo', 'docker', 'kubectl', 'go', 'npx'])

/**
 * Normalize a bash command string into a command class.
 *
 * Doom-loop 变体归并：`git status --porcelain | sed -n 1,50p`、
 * `git status --porcelain | head -100`、`git status --porcelain | tee /tmp/s`
 * 全部归并为 "git:status"。git 出现在管道/子串中也能匹配（python -c 内嵌同理）。
 */
export function bashCommandClass(command: string): string {
  // git anywhere in the command dominates — pipes/tee/embedding included.
  const gitMatch = command.match(/\bgit\s+(?:-[^\s]+\s+)*([a-z][a-z-]*)/)
  if (gitMatch) {
    const sub = gitMatch[1]!
    // 内容查询型子命令按目标参数桶化（2026-09-05 用户报告：逐提交 git show
    // 审查被误判轮询风暴）：不同目标 = 不同查询，不合并；同目标反复 = 真重复
    // 仍可检测。状态型（status/log 无参）保持平类，等待状态的真轮询不受影响。
    if (GIT_CONTENT_CMDS.has(sub)) {
      const after = command.slice(gitMatch[0].length + gitMatch.index!)
      // flag 前置形式（git show --stat <hash>、git show -p <hash>、
      // git log --oneline <hash>）：跳过标志 token 再取目标，避免回落平类
      // git:show 把多提交的合法审查合并成同一轮询类。
      const target = after.trim().split(/\s+/)
        .find(t => t && !t.startsWith('-'))
        ?.replace(/^['"]|['"]$/g, '') ?? ''
      if (target) {
        return `git:${sub}:${target.slice(0, 12)}`
      }
    }
    return `git:${sub}`
  }

  const tokens = command.trim().split(/\s+/)
  let i = 0
  // Skip leading env assignments (FOO=bar cmd ...)
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  const bin = (tokens[i] ?? '').replace(/^.*\//, '')
  if (!bin) return 'empty'
  const next = tokens[i + 1]
  if (SUBCOMMAND_BINARIES.has(bin) && next && !next.startsWith('-')) {
    return `${bin}:${next}`
  }
  return bin
}

/**
 * Class fingerprint for a tool call. Only bash gets one — bash is the
 * text-parsing escape hatch where the model mutates flags/pipes to "retry";
 * structured tools (read_file/grep/...) legitimately repeat with new inputs.
 *
 * Only failing bash commands produce a class fingerprint. Successful
 * exploration commands (grep, find, cat, npx tsc, etc.) are legitimate
 * repetition, not a doom loop — 20 unique successful grep patterns must NOT
 * be mistaken for the same tool failing repeatedly.
 * Returns null for non-bash tools or successful bash commands.
 */
export function fingerprintToolClass(
  name: string,
  input: Record<string, unknown>,
  outputClass: string,
): string | null {
  if (name !== 'bash') return null
  // Successful bash commands are normal exploration — don't class-track them.
  if (outputClass === 'success') return null
  const command = typeof input.command === 'string' ? input.command : ''
  return `${bashCommandClass(command)}·${outputClass}`
}

export function recordToolFingerprint(store: TraceStore, fingerprint: string, classFingerprint?: string | null): TraceStore {
  return {
    ...store,
    toolFingerprints: [...store.toolFingerprints, fingerprint].slice(-20),
    ...(classFingerprint
      ? { bashClassFingerprints: [...(store.bashClassFingerprints ?? []), classFingerprint].slice(-20) }
      : {}),
  }
}

export function recordToolNamedFingerprint(
  store: TraceStore,
  fingerprint: string,
  toolName: string,
): TraceStore {
  return {
    ...store,
    toolFingerprints: [...store.toolFingerprints, fingerprint].slice(-20),
    toolNameHistory: [...(store.toolNameHistory ?? []), toolName].slice(-20),
  }
}

/**
 * P0-1 polling-storm guard 的候选工具集合。只放「观察/等待型」工具——
 * 这些工具连续重复调用时，模型几乎一定是在轮询而不是在推进任务。
 * 刻意排除 read/grep/web_fetch 等合法长调研工具，避免误熔断。
 */
const POLLING_CLASS_TOOLS = new Set(['job', 'monitor', 'browser_debug', 'browser', 'computer_use', 'ask_image'])

/**
 * 计算轮询活动类：
 * - bash → `bash:<命令类>`（同一命令类的变体归并，sed/head/python 变体不会各算一类）
 * - 观察型工具 → 工具名本身（同工具不同 action 的轮询也归并）
 * - 其余工具 → null（不进入 polling-storm 判定）
 */
export function pollingClassOf(name: string, input: Record<string, unknown>): string | null {
  const tool = name.toLowerCase()
  if (tool === 'bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) return null
    return `bash:${bashCommandClass(command)}`
  }
  if (POLLING_CLASS_TOOLS.has(tool)) return tool
  return null
}

export function recordToolPollingClass(
  store: TraceStore,
  name: string,
  input: Record<string, unknown>,
): TraceStore {
  const cls = pollingClassOf(name, input)
  if (!cls) return store
  return {
    ...store,
    toolPollingClasses: [...(store.toolPollingClasses ?? []), cls].slice(-24),
    toolPollingCount: (store.toolPollingCount ?? 0) + 1,
  }
}

const GIT_CONTENT_CMDS = new Set(['show', 'diff', 'cat-file', 'blame', 'grep', 'log'])

/** 独立于 doom 语义的轮询风暴等级。输入必须是 pollingClassOf 产出的类序列。 */
export function getPollingStormLevel(classes: string[]): ToolStormLevel {
  return stormLevelFromSeries(classes)
}

export const POLLING_STORM_WARN_TURNS = 3
export const POLLING_STORM_ABORT_TURNS = 6

/** P0-1 polling-storm guard 的跨轮可变状态。 */
export interface PollingStormState {
  streak: number
  warned: boolean
  lastFilesModifiedCount: number
  /** 上次评估时的轮询记录总追加数（store.toolPollingCount 的单调计数）——
   *  「本轮是否有新增轮询记录」判据。不用 toolPollingClasses 数组长度：
   *  系列被 slice(-24) 裁剪后长度恒定，长度代理会在长会话里恒判「无新增」。 */
  lastPollingCount: number
}

export interface PollingStormVerdict {
  action: 'none' | 'warn' | 'abort'
  className: string
  streak: number
  reminder: string
}

/**
 * 每轮工具执行后推进一次 polling-storm 状态机。文件修改数增长视为推进并
 * 清零 streak；pollingClass 连续 8 次同类后开始累计，streak≥3 发警告、
 * streak≥6 返回 abort（调用方负责 completeTurn 并释放 running）。
 * store 参数持有裁剪后的轮询窗口（供风暴等级判定）与单调追加计数
 * （toolPollingCount，供「本轮是否有新增」判定）。
 */
export function evaluatePollingStorm(
  state: PollingStormState,
  store: TraceStore,
  filesModifiedCount: number,
): PollingStormVerdict {
  const pollingClasses = store.toolPollingClasses ?? []
  const pollingTotal = store.toolPollingCount ?? 0
  const modifiedThisTurn = filesModifiedCount > state.lastFilesModifiedCount
  state.lastFilesModifiedCount = filesModifiedCount
  // 迟到误杀修复（2026-09-05，用户报告）：只读轮（read/grep 等，pollingClassOf
  // 返回 null 不追加系列）与无工具轮不产生新 polling 记录——本轮无新增且无文件
  // 修改时模型在做事或收束，streak 向 0 收敛而不是在冻结的 storm 帧里继续 +1
  // 直至 abort。优先级：文件修改（最强推进，任何轮清零）> 无新增衰减 > 有新增
  // storm 递增。真轮询每轮都有新记录且无修改 → 8 连 + 6 轮照常熔断。
  // 环形缓冲溢出修复（2026-09-05，对抗审查）：hasNewPolling 用 toolPollingCount
  // 的单调计数而非裁剪后数组长度——长度到 24 上限后不再增长，长度代理会让累计
  // 满 24 条后的长会话恒判「无新增」，streak 只衰减、abort 分支永久不可达。
  const hasNewPolling = pollingTotal > state.lastPollingCount
  state.lastPollingCount = pollingTotal
  if (modifiedThisTurn) {
    state.streak = 0
    state.warned = false
  } else if (hasNewPolling && getPollingStormLevel(pollingClasses) === 'storm') {
    state.streak = state.streak + 1
  } else if (!hasNewPolling) {
    state.streak = Math.max(0, state.streak - 1)
  } else {
    state.streak = 0
    state.warned = false
  }
  const className = pollingClasses.slice(-8).at(-1) ?? 'unknown'
  const reminder =
    `<system-reminder>[polling-storm] 已连续多轮轮询同一类操作（${className}）且没有文件修改。`
    + `如果是在等外部状态变化，请改用 monitor 订阅或 job(await) 一次性等待；否则立即停止轮询，基于已有结果收束，或换一种验证方式。</system-reminder>`
  if (state.streak >= POLLING_STORM_ABORT_TURNS) return { action: 'abort', className, streak: state.streak, reminder }
  if (!state.warned && state.streak >= POLLING_STORM_WARN_TURNS) {
    state.warned = true
    return { action: 'warn', className, streak: state.streak, reminder }
  }
  return { action: 'none', className, streak: state.streak, reminder }
}

export type ToolStormLevel = 'none' | 'warn' | 'storm'

/**
 * 连续序列的通用风暴检测（供工具名风暴与轮询类风暴共用）。
 * - 4+ 连续同值 → warn
 * - 8+ 连续同值 → storm
 */
function stormLevelFromSeries(values: string[]): ToolStormLevel {
  if (values.length < 4) return 'none'

  const recent = values.slice(-12)
  let maxConsecutive = 0
  let currentConsecutive = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i - 1]) {
      currentConsecutive++
    } else {
      currentConsecutive = 0
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
  }

  if (maxConsecutive >= 7) return 'storm'
  if (maxConsecutive >= 3) return 'warn'
  return 'none'
}

/**
 * Detects "tool storms" — consecutive calls to the same tool TYPE
 * regardless of input parameters (different grep queries still count).
 *
 * Thresholds:
 * - 4+ consecutive same tool type → warn
 * - 8+ consecutive same tool type → storm
 */
export function getToolStormLevel(toolNames: string[]): ToolStormLevel {
  return stormLevelFromSeries(toolNames)
}

/** Threshold presets for doom-loop detection, selectable by goal mode. */
export interface DoomLoopThresholds {
  exact: { window: number; blockConsec: number; blockFreq: number; warnConsec: number; warnFreq: number }
  class: { window: number; blockConsec: number; blockFreq: number; warnConsec: number }
}

/** Normal mode: relaxed from original to avoid blocking normal workflows.
 *  Exact: 5 consecutive / 7-of-8 freq → block (was 4/7)
 *  Class: 9 consecutive / 10-of-12 freq → block (was 7/9 in window 10)
 *  Bash class fingerprints aggregate many different commands into one bin
 *  (e.g. all grep/rg/find patterns share `grep·error`), so the class
 *  thresholds must be higher to avoid making sequential debugging unusable. */
export const NORMAL_DOOM_THRESHOLDS: DoomLoopThresholds = {
  exact: { window: 8, blockConsec: 5, blockFreq: 7, warnConsec: 3, warnFreq: 5 },
  class: { window: 12, blockConsec: 9, blockFreq: 10, warnConsec: 6 },
}

/** Goal mode: significantly relaxed for long autonomous tasks.
 *  Already using larger windows, scaled proportionally from normal thresholds. */
export const GOAL_DOOM_THRESHOLDS: DoomLoopThresholds = {
  exact: { window: 10, blockConsec: 6, blockFreq: 8, warnConsec: 3, warnFreq: 6 },
  class: { window: 14, blockConsec: 10, blockFreq: 12, warnConsec: 7 },
}

export function getDoomLoopThresholds(goalActive: boolean): DoomLoopThresholds {
  return goalActive ? GOAL_DOOM_THRESHOLDS : NORMAL_DOOM_THRESHOLDS
}

/**
 * Detects doom loops using a dual-strategy approach:
 * 1. Consecutive repeats: tight-loop pattern where the same tool is called back-to-back.
 * 2. Sliding-window frequency: oscillation pattern (A→B→A→B→A) where a tool
 *    dominates the recent window even if not consecutive.
 *
 * Thresholds are parameterized via DoomLoopThresholds to allow goal-mode relaxation.
 */
export function getDoomLoopLevel(
  fingerprints: string[],
  t: DoomLoopThresholds['exact'] = NORMAL_DOOM_THRESHOLDS.exact,
): DoomLoopLevel {
  const recent = fingerprints.slice(-t.window)

  // Strategy 1: consecutive repeats
  let maxConsecutive = 0
  let currentConsecutive = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i! - 1]) {
      currentConsecutive++
    } else {
      currentConsecutive = 0
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
  }

  // Strategy 2: sliding-window frequency
  const counts = new Map<string, number>()
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  const maxCount = Math.max(0, ...counts.values())

  if (maxConsecutive >= t.blockConsec || maxCount >= t.blockFreq) return 'blocked'
  if (maxConsecutive >= t.warnConsec || maxCount >= t.warnFreq) return 'warn'
  return 'none'
}

/**
 * Class-level doom-loop detection over bash command-class fingerprints.
 *
 * 比精确指纹阈值保守（类粒度更粗，避免把"连续几次不同的 rg 搜索"误判为循环）：
 * - 4+ 连续同类（第 5 次同类调用）→ warn
 * - 6+ 连续同类 OR 8+/10 窗口占比 → blocked
 *
 * 会话 43443098 的 28 次 git status 变体在第 5 次就会进入 warn、第 7 次 blocked。
 */
export function getClassDoomLoopLevel(
  classFingerprints: string[],
  t: DoomLoopThresholds['class'] = NORMAL_DOOM_THRESHOLDS.class,
): DoomLoopLevel {
  const recent = classFingerprints.slice(-t.window)

  let maxConsecutive = 0
  let currentConsecutive = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i - 1]) {
      currentConsecutive++
    } else {
      currentConsecutive = 0
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
  }

  const counts = new Map<string, number>()
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  const maxCount = Math.max(0, ...counts.values())

  if (maxConsecutive >= t.blockConsec || maxCount >= t.blockFreq) return 'blocked'
  if (maxConsecutive >= t.warnConsec) return 'warn'
  return 'none'
}

/**
 * Identify the specific fingerprints that pushed a window to `blocked` — i.e.
 * the actual offenders in the loop, not every fingerprint in the window.
 *
 * Used by the doom-loop gate to block *only* repeats of the looping call while
 * letting different tools/inputs through. Without this, hitting `blocked` once
 * blocks every subsequent tool unconditionally; since blocked calls never get
 * recorded, the window never refreshes and the turn deadlocks until the next
 * user input. Returns the set of offending fingerprints (empty if not blocked).
 *
 * Mirrors getDoomLoopLevel's thresholds: a fingerprint is an offender if it
 * appears 3+ times consecutively OR 6+ times within the last WINDOW entries.
 */
export function offendingFingerprints(fingerprints: string[], window = 8, freqThreshold = 6, consecThreshold = 3): Set<string> {
  const recent = fingerprints.slice(-window)
  const offenders = new Set<string>()

  // Frequency offenders.
  const counts = new Map<string, number>()
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  for (const [fp, n] of counts) {
    if (n >= freqThreshold) offenders.add(fp)
  }

  // Consecutive-run offenders.
  let run = 1
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i - 1]) {
      run++
      // consecThreshold consecutive *repeats* = consecThreshold+1 identical calls.
      if (run >= consecThreshold + 1) offenders.add(recent[i]!)
    } else {
      run = 1
    }
  }
  return offenders
}

const DOOM_LEVEL_ORDER: Record<DoomLoopLevel, number> = { none: 0, warn: 1, blocked: 2 }

/** Combine exact-fingerprint and class-fingerprint detection — strictest wins. */
export function combineDoomLoopLevels(a: DoomLoopLevel, b: DoomLoopLevel): DoomLoopLevel {
  return DOOM_LEVEL_ORDER[a] >= DOOM_LEVEL_ORDER[b] ? a : b
}
