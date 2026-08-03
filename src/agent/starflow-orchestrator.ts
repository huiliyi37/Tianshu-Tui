/**
 * starflow 星流编排器 —— council → team → galaxy 三段代码级状态机。
 *
 * 此前的 /starflow 是纯 prompt 注入：五阶段协议写进 user message 靠模型自觉遵守，
 * 阶段守卫只有文字没有代码兜底。本模块把中间三段做成硬门禁状态机——模型负责想
 * （需求澄清 + 交付叙述），机器负责管阶段流转：
 *   council 评审（产出密封契约 planJson）→ team 波次（契约执行）→ galaxy 攻坚（维度并行）
 * 任一阶段门禁不过即 phase=blocked 停止并给出人话解释；每阶段完成后状态落盘
 * `.rivet/starflow/<sha1(objective)前12位>.json`，resume:true 时已过阶段不重复执行。
 *
 * 三个子工具（council_convene / team_orchestrate / galaxy）只消费不修改——
 * 门禁判据双通道：优先读 ToolResult.orchestration 结构化 outcome（D4），
 * 缺席（假工具/未迁移产出）回退各 formatter 的稳定文本行判据。
 *
 * 交付门禁（阶段 4）不在此实现——deliver_task 已有自己的硬门禁（证据义务 +
 * DP 冗余），星流只在最终报告里输出交付检查清单并提示调用。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'

// ── 类型 ─────────────────────────────────────────────────────────────────

/** 状态机阶段。phase 记录「下一个要执行的阶段」；done 是唯一终态——
 *  受阻时 phase 停留在受阻阶段（配合 blockedReason，resume 从该阶段重跑）。 */
export type StarflowPhase = 'council' | 'team' | 'galaxy' | 'deliver' | 'done'

export interface StarflowPhaseRecord {
  status: 'passed' | 'blocked' | 'skipped'
  /** 阶段摘要（工具输出的首行/关键行截断）。 */
  summary: string
  at: number
}

export interface StarflowState {
  objective: string
  /** 下一个要执行的阶段；blocked 时停留在受阻阶段（resume 从该阶段重跑）。 */
  phase: StarflowPhase
  phases: Partial<Record<'council' | 'team' | 'galaxy' | 'deliver', StarflowPhaseRecord>>
  /** council 产出的密封契约——resume 续跑 team 阶段的必需品（会话 plan-store
   *  桥在跨 session resume 时不可靠，契约必须随状态落盘）。 */
  planJson?: string
  /** team 阶段已消耗的复议次数（回 council 复议上限 1 次，跨 resume 记账）。 */
  teamRetries: number
  blockedReason?: string
  updatedAt: number
}

/** 与 galaxy 工具 dimensionSchema 对齐的宽松结构——值原样透传，由 galaxy 复验。 */
export interface StarflowGalaxyDimension {
  name: string
  objective: string
  authority?: string
  authorities?: string[]
  parallelism?: 'expert' | 'data'
  replicas?: number
  profile?: string
  tierFloor?: 'cheap' | 'balanced' | 'strong'
  files?: string[]
  symbols?: string[]
  maxTurns?: number
  timeoutMs?: number
  modelOverride?: { provider: string; model: string }
}

export interface StarflowDraftItem {
  id: string
  title: string
  detail: string
  files?: string[]
  /** 修订记账（调用方自管）：修订重提时 bump；未变条目保持原值。 */
  revision?: number
  /** 增量评审标记：上一轮评审已通过且本轮未变。starflow 据此在 councilInput
   *  渲染中标注「沿用前轮通过结论」，council 无需改 schema——渲染文案即契约。 */
  previousVerdict?: 'passed'
}

/** 与 council-convene 的 seatSchema 同构——席位覆盖透传，由 council 复验。 */
export interface StarflowSeat {
  authority: string
  charter?: string
  tierHint?: 'cheap' | 'balanced' | 'strong'
  noDowngrade?: boolean
  provider?: string
  model?: string
}

export interface StarflowInput {
  objective: string
  /** 阶段 0 澄清产出的计划草稿——喂给 council 评审，也是 galaxyDims 缺省时
   *  维度派生的来源。 */
  draftItems?: StarflowDraftItem[]
  /** 显式 galaxy 维度（2-5 个）。缺省时从 draftItems 派生，派生不出则跳过
   *  galaxy 阶段。 */
  galaxyDims?: StarflowGalaxyDimension[]
  /** council 辩论轮数（1-2，默认 1）。 */
  rounds?: 1 | 2
  /** 席位覆盖（与 council_convene 的 seats 同构）——透传到首轮与复议轮。
   *  修订轮推荐只召回「上轮否决的席位 + 与修订点相关的域席」，而非默认全量。 */
  seats?: StarflowSeat[]
  /** 从 `.rivet/starflow/` 状态文件续跑——已过门禁的阶段不重复执行。 */
  resume?: boolean
}

export interface StarflowDeps {
  councilTool: Tool
  teamTool: Tool
  galaxyTool: Tool
  cwd: string
  /** 子工具调用参数的载体——sessionId / onOutput / onWorkerActivity /
   *  abortSignal 等原样透传，toolUseId 按阶段加后缀保持活动树归属。 */
  params: ToolCallParams
}

export interface StarflowRun {
  state: StarflowState
  /** 阶段报告（每阶段：状态/摘要/门禁判定；blocked 时给出停在哪、为什么、下一步）。 */
  report: string
}

// ── 常量与文本判据 ────────────────────────────────────────────────────────

const GLYPH = '🌠'
/** team 波次上限护栏——防假工具/异常输出让续波循环失控（真实计划波次 << 10）。 */
const MAX_TEAM_WAVES = 10
/** 摘要截断长度。 */
const SUMMARY_CAP = 160

/** council 否决标志（council-convene.ts 编译门文案）：blocking challenge 未化解。 */
const COUNCIL_VETO_RE = /^## ⛔ 议事会否决/m
/** council 产出密封契约的嵌入块（council-convene.ts parts.push 格式）。 */
const COUNCIL_PLAN_JSON_RE = /```council-plan-json\n([\s\S]*?)\n```/
/** team 续波提示（team-orchestrate.ts formatTeamSummary 文案）。 */
const TEAM_NEXT_WAVE_RE = /再次调用 team_orchestrate 并传 fromWave: (\d+)/
/** team 整波失败提示（formatTeamSummary 文案）。 */
const TEAM_ALL_FAILED_RE = /全部 \d+ 个 worker 失败/
/** team 波间硬门禁失败提示（plan-executor.ts waveGateNote 文案）。 */
const TEAM_WAVE_GATE_RE = /下一波派发将被硬拦/
/** team review gate 驳回（plan-executor.ts reviewNote 文案）。 */
const TEAM_REVIEW_REJECTED_RE = /Review gate \[[^\]]*\]: rejected/
/** team 派发计数行（formatTeamSummary 首行）。 */
const TEAM_DISPATCHED_RE = /^team \w+：派发 (\d+)/m
/** galaxy 聚合结论（galaxy.ts formatGalaxyResult 文案）。 */
const GALAXY_ALL_PASSED = '聚合结论: 所有维度通过'
const GALAXY_FAILED_RE = /聚合结论: (\d+)\/(\d+) 个维度未通过/
/** galaxy 单维度报告行：`  <label>: <glyph> …`，glyph 非 ✓ 即未通过。 */
const GALAXY_DIM_LINE_RE = /^ {2}([^\n:]+): ([✗⊗↑])/gm

function firstLine(text: string, cap = SUMMARY_CAP): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return line.length > cap ? `${line.slice(0, cap)}…` : line
}

// ── 状态持久化 ────────────────────────────────────────────────────────────

function starflowDir(cwd: string): string {
  return join(cwd, '.rivet', 'starflow')
}

export function starflowStatePath(cwd: string, objective: string): string {
  const hash = createHash('sha1').update(objective).digest('hex').slice(0, 12)
  return join(starflowDir(cwd), `${hash}.json`)
}

function freshState(objective: string, now: number): StarflowState {
  return { objective, phase: 'council', phases: {}, teamRetries: 0, updatedAt: now }
}

function loadState(cwd: string, objective: string): StarflowState | undefined {
  try {
    const path = starflowStatePath(cwd, objective)
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StarflowState
    if (parsed.objective !== objective || typeof parsed.phase !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 状态落盘是 resume 便利，写盘失败绝不影响编排（同 checkpoint 先例）。 */
function saveState(cwd: string, state: StarflowState): void {
  try {
    mkdirSync(starflowDir(cwd), { recursive: true })
    writeFileSync(starflowStatePath(cwd, state.objective), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // best-effort
  }
}

// ── galaxy 维度派生 ───────────────────────────────────────────────────────

/** draftItem → authority 映射：审查/验证类 → 瑶光，文档/调研类 → 天璇，其余 → 天梁。 */
function authorityForDraftItem(item: StarflowDraftItem): string {
  const probe = `${item.id} ${item.title}`.toLowerCase()
  if (/(review|verify)/.test(probe)) return 'yaoguang'
  if (/(docs|research)/.test(probe)) return 'tianxuan'
  return 'tianliang'
}

/** galaxyDims 缺省时的派生：按 draftItem 的 id/title 分类定 authority（kind 映射），
 *  files 作维度 scope，detail 作维度 objective。galaxy schema 要求 2-5 个维度——
 *  超出 5 个截断（报告注明），不足 2 个由调用方跳过 galaxy 阶段。 */
export function deriveGalaxyDims(items: StarflowDraftItem[] | undefined): StarflowGalaxyDimension[] {
  const seen = new Set<string>()
  const dims: StarflowGalaxyDimension[] = []
  for (const item of items ?? []) {
    const name = item.id.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    dims.push({
      name,
      objective: item.detail,
      authority: authorityForDraftItem(item),
      ...(item.files && item.files.length > 0 ? { files: item.files } : {}),
    })
  }
  return dims.slice(0, 5)
}

// ── council 输入增强（复盘 A-D：基线预检 C + 增量评审 B） ─────────────────

/** C: 基线预检块——git status 命中 draftItems 目标文件的行 + 目标文件最近 5 条
 *  提交 + 一句必答要求。注入 councilInput.objective 尾部，把第 2-3 轮才会暴露的
 *  「已在工作树/已合入」类否决提前到第 1 轮。非 git 目录/超时返回 ''（降级为空块，
 *  不阻塞点火）；块截断 ~2KB（路径多时防撑爆上下文）。 */
function baselinePrecheckBlock(cwd: string, files: string[]): string {
  if (files.length === 0) return ''
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    } catch {
      return null // 非 git 目录 / 超时
    }
  }
  const status = run(['-c', 'core.quotePath=false', 'status', '--short']) // quotePath=false：中文/非 ASCII 路径不转八进制，否则目标文件匹配漏报
  if (status === null) return '' // 非 git 目录：降级空块，不阻塞点火
  const statusLines = status.length > 0 ? status.split('\n').filter(l => l.trim().length > 0) : []
  const hits = statusLines.filter(l => {
    // 剥状态码前缀（` M ` / `?? ` 等）与引号（路径含空格时 git 加引号）。
    const p = l.slice(3).trim().replace(/^"|"$/g, '')
    return files.some(f => p === f || p.startsWith(`${f}/`))
  })
  const log = run(['log', '--oneline', '-5', '--', ...files])
  const logLines = (log ?? '').split('\n').filter(l => l.trim().length > 0).slice(0, 5)
  const lines: string[] = ['', '── 基线预检（工作树/提交现状，评审前必核）──']
  if (hits.length > 0) {
    lines.push('工作树命中草稿目标文件：')
    for (const h of hits.slice(0, 20)) lines.push(`  ${h}`)
  } else {
    lines.push('工作树无草稿目标文件的改动。')
  }
  if (logLines.length > 0) {
    lines.push('目标文件最近提交：')
    for (const l of logLines) lines.push(`  ${l}`)
  }
  lines.push('第一轮评审必须先核对草稿断言与上述工作树/提交现状的差异。')
  const block = lines.join('\n')
  return block.length > 2048 ? `${block.slice(0, 2048)}\n…（预检块截断）` : block
}

/** B: 增量评审说明——previousVerdict=passed 且 revision 未 bump 的条目（修订
 *  重提时未变）渲染「沿用前轮通过结论」。渲染层标注（追加进 objective 尾部，
 *  席位可见），不删条目——席位仍看到全图但知道评审焦点；council 侧无需改
 *  schema，渲染文案即契约。
 *  守卫（2026-08-03 审查，fail-dangerous 修正）：revision 与 previousVerdict
 *  同现的条目视为已修订——不沿用、重新评审。无状态实现无法区分「bump 后
 *  忘清 previousVerdict」与「未变」，存在即按修订处理（宁可重审不放过）。 */
function incrementalReviewNote(items: StarflowDraftItem[]): string {
  const carried = items.filter(i => i.previousVerdict === 'passed' && i.revision === undefined)
  if (carried.length === 0) return ''
  return [
    '',
    '── 增量评审说明 ──',
    `以下条目已在前轮评审通过且本轮未变（previousVerdict=passed）：${carried.map(i => i.id).join('、')}。`,
    '沿用前轮通过结论，除非与其他条目冲突否则不重审；其余条目为重点评审对象。',
  ].join('\n')
}

/** councilInput.objective 增强：原始 objective + 基线预检（C，仅首轮）+
 *  增量评审说明（B）。目标文件为空或不适用时对应块自动省略。 */
function augmentCouncilObjective(
  objective: string,
  items: StarflowDraftItem[],
  cwd: string,
  opts?: { precheck?: boolean },
): string {
  const parts: string[] = [objective]
  if (opts?.precheck !== false) {
    const precheck = baselinePrecheckBlock(cwd, items.flatMap(i => i.files ?? []))
    if (precheck) parts.push(precheck)
  }
  const note = incrementalReviewNote(items)
  if (note) parts.push(note)
  return parts.join('\n\n')
}

// ── 门禁判定 ─────────────────────────────────────────────────────────────

type GateResult = { ok: true } | { ok: false; reason: string }

/** council 门禁：未执行（禁用/流会）与否决（blocking 冲突未化解）都是硬拦。
 *  优先读结构化 outcome（disabled 布尔）；缺席（假工具/未迁移产出）回退
 *  content.includes 散文匹配。否决走 COUNCIL_VETO_RE（稳定结构，非散文）。 */
function councilGate(result: ToolResult): GateResult {
  if (result.isError) return { ok: false, reason: `评审执行失败：${firstLine(result.content)}` }
  const outcome = result.orchestration?.kind === 'council' ? result.orchestration : undefined
  if (outcome?.disabled) {
    return { ok: false, reason: '评审未执行（council 已禁用或未派发任何席位，COUNCIL=0？）' }
  }
  if (!outcome && (result.content.includes('已禁用') || result.content.includes('未派发任何席位'))) {
    return { ok: false, reason: '评审未执行（council 已禁用或未派发任何席位，COUNCIL=0？）' }
  }
  const veto = COUNCIL_VETO_RE.exec(result.content)
  if (veto) {
    // 否决理由行（`- <description>: <left>`）抽出来附在 blockedReason 里。
    const reasons = result.content.slice(veto.index).split('\n')
      .filter(l => l.startsWith('- ')).slice(0, 5).map(l => l.slice(2))
    return { ok: false, reason: `议事会否决（blocking challenge 未化解）${reasons.length > 0 ? `：${reasons.join('；')}` : ''}` }
  }
  return { ok: true }
}

/** team 门禁：优先读结构化 outcome；缺席（假工具/未迁移产出）回退文案正则。
 *  文案改动不应让门禁静默失效——见 2026-08-01 TEAM_DISPATCHED_RE 事故。 */
function teamGate(result: ToolResult): GateResult {
  if (result.isError) return { ok: false, reason: `执行失败：${firstLine(result.content)}` }
  const outcome = result.orchestration?.kind === 'team' ? result.orchestration : undefined
  if (outcome) {
    if (outcome.workers.total > 0 && outcome.workers.passed === 0) {
      return { ok: false, reason: '波次 worker 全部失败' }
    }
    if (outcome.waveGate && !outcome.waveGate.passed) {
      const detail = outcome.waveGate.failures.slice(0, 2).join('；')
      return { ok: false, reason: `波间硬门禁未通过（${detail || 'typecheck/验证命令失败'}）` }
    }
    if (outcome.reviewVerdict === 'rejected') return { ok: false, reason: 'review gate 驳回了本波改动' }
    if (outcome.dispatched === 0) return { ok: false, reason: '未派发任何 worker（计划无可执行波次）' }
    return { ok: true }
  }
  if (TEAM_ALL_FAILED_RE.test(result.content)) return { ok: false, reason: '波次 worker 全部失败' }
  if (TEAM_WAVE_GATE_RE.test(result.content)) return { ok: false, reason: '波间硬门禁未通过（typecheck/验证命令失败）' }
  if (TEAM_REVIEW_REJECTED_RE.test(result.content)) return { ok: false, reason: 'review gate 驳回了本波改动' }
  const dispatched = TEAM_DISPATCHED_RE.exec(result.content)
  if (dispatched && Number(dispatched[1]) === 0) return { ok: false, reason: '未派发任何 worker（计划无可执行波次）' }
  return { ok: true }
}

/** 下一波序号：优先读结构化 outcome，缺席回退续波提示正则。返回 undefined = 已是末波。
 *
 *  整波失败也返回 undefined：被替代的正则路径里，formatTeamSummary（team-orchestrate.ts:114）
 *  在整波失败时**用停止警告替换掉续波提示**，所以正则匹配不到、不推波。结构化路径必须
 *  自带这个条件才等价——不能指望调用点先跑 teamGate 拦下（那是外部顺序，改一次调用序
 *  就会踩着失败的波次往前推，而散文路径不会）。 */
export function nextWaveOf(result: ToolResult): number | undefined {
  const outcome = result.orchestration?.kind === 'team' ? result.orchestration : undefined
  if (outcome) {
    if (outcome.workers.total > 0 && outcome.workers.passed === 0) return undefined
    return outcome.wave + 1 < outcome.totalWaves ? outcome.wave + 1 : undefined
  }
  const m = TEAM_NEXT_WAVE_RE.exec(result.content)
  return m ? Number(m[1]) : undefined
}

/** galaxy 门禁：isError（含 DP quorum 未达成）或维度未通过即硬拦，附失败维度。
 *  优先读结构化 outcome（dimensions total/passed/failed）；缺席（假工具/未迁移
 *  产出）回退 GALAXY_FAILED_RE + GALAXY_DIM_LINE_RE 逐行解析。 */
function galaxyGate(result: ToolResult): GateResult {
  if (result.isError) return { ok: false, reason: `攻坚执行失败：${firstLine(result.content)}` }
  const outcome = result.orchestration?.kind === 'galaxy' ? result.orchestration : undefined
  if (outcome) {
    const { total, passed, failed } = outcome.dimensions
    // 两个判据数据源不同：passed/total 数 run.results，failed 数 targets（派发请求
    // 无对应结果时也计入）。正常一一对应，分叉时取大者——否则会输出「0/3 个维度未
    // 通过（frontend 文曲）」这种自相矛盾的 reason。
    const failedCount = Math.max(total - passed, failed.length)
    if (failedCount > 0) {
      return {
        ok: false,
        reason: `${failedCount}/${total} 个维度未通过${failed.length > 0 ? `（${failed.slice(0, 5).join('、')}）` : ''}`,
      }
    }
    return { ok: true }
  }
  const failed = GALAXY_FAILED_RE.exec(result.content)
  if (failed) {
    const failedDims: string[] = []
    for (const m of result.content.matchAll(GALAXY_DIM_LINE_RE)) failedDims.push(m[1]!.trim())
    return {
      ok: false,
      reason: `${failed[1]}/${failed[2]} 个维度未通过${failedDims.length > 0 ? `（${failedDims.slice(0, 5).join('、')}）` : ''}`,
    }
  }
  return { ok: true }
}

/** council 产出里抽取密封契约 planJson；无契约（零任务计划）返回 undefined。 */
function extractPlanJson(content: string): string | undefined {
  return COUNCIL_PLAN_JSON_RE.exec(content)?.[1]?.trim() || undefined
}

// ── 报告 ─────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<'council' | 'team' | 'galaxy' | 'deliver', string> = {
  council: '阶段 1 council 评审',
  team: '阶段 2 team 波次',
  galaxy: '阶段 3 galaxy 攻坚',
  deliver: '阶段 4 交付门禁',
}

function phaseStatusLine(key: 'council' | 'team' | 'galaxy' | 'deliver', record: StarflowPhaseRecord | undefined, note?: string): string {
  const label = PHASE_LABELS[key]
  if (!record) return `${label}：… 未执行`
  const icon = record.status === 'passed' ? '✅' : record.status === 'skipped' ? '⏭ 跳过' : '⛔ 受阻'
  return `${label}：${icon}${note ?? ''} — ${record.summary}`
}

/** 按受阻阶段给出人话的下一步建议。 */
function nextStepHint(state: StarflowState): string {
  const reason = state.blockedReason ?? ''
  switch (state.phase) {
    case 'council':
      if (reason.includes('已禁用') || reason.includes('未派发任何席位')) {
        return '议事会被禁用（COUNCIL=0）。开启 COUNCIL 后重试，或放弃星流改用 team_orchestrate 直接执行。'
      }
      if (reason.includes('否决')) {
        return '按否决理由修订计划草稿（draftItems）后重新调用 starflow；或传 rounds:2 让席位复议收敛。'
      }
      return '查看上方失败原因修复后重试。'
    case 'team':
      return '修复失败项后用 starflow({ objective, resume: true }) 续跑——council 已过门禁不会重跑。'
    case 'galaxy':
      return '检查失败维度修复后用 starflow({ objective, resume: true }) 续跑；或在 galaxyDims 里调整维度划分。'
    default:
      return '查看上方原因修复后重试。'
  }
}

function buildReport(state: StarflowState, teamRetried: boolean): string {
  const lines: string[] = [
    `${GLYPH} 星流执行报告 · ${firstLine(state.objective, 80)}`,
    '',
    phaseStatusLine('council', state.phases.council),
    phaseStatusLine('team', state.phases.team, teamRetried && state.phases.team?.status === 'passed' ? '（复议 1 次后通过）' : undefined),
    phaseStatusLine('galaxy', state.phases.galaxy),
    phaseStatusLine('deliver', state.phases.deliver),
  ]
  if (state.phase === 'done') {
    lines.push('', '交付检查清单（deliver_task 硬门禁前置自查）：',
      '  - typecheck / 测试已运行并通过（未运行 = 未验证）',
      '  - 消费方路径核对（改动语义通达）',
      '  - RED-GREEN 证据齐备（先写失败测试再实现）',
      '', '下一步：调用 deliver_task 完成交付门禁。')
  } else {
    lines.push('', `⛔ 星流停止于 ${state.phase} 阶段：${state.blockedReason ?? '未知原因'}`,
      '', `下一步建议：${nextStepHint(state)}`)
  }
  return lines.join('\n')
}

// ── 状态机主体 ────────────────────────────────────────────────────────────

/** 子工具调用参数：透传会话载体，toolUseId 按阶段加后缀（worker 活动树归属），
 *  cwd 以 deps.cwd 为准（状态落盘与子工具执行同一项目根）。 */
function subParams(deps: StarflowDeps, tag: string): ToolCallParams {
  return { ...deps.params, input: {}, toolUseId: `${deps.params.toolUseId}-starflow-${tag}`, cwd: deps.cwd }
}

export async function runStarflow(deps: StarflowDeps, input: StarflowInput): Promise<StarflowRun> {
  const now = () => Date.now()
  const state = (input.resume ? loadState(deps.cwd, input.objective) : undefined)
    ?? freshState(input.objective, now())
  // 非 resume 的显式重跑：丢弃旧状态从头来（freshState 已覆盖）。
  let teamRetried = false

  const block = (phase: 'council' | 'team' | 'galaxy', reason: string, summary: string): StarflowRun => {
    state.phase = phase
    state.phases[phase] = { status: 'blocked', summary, at: now() }
    state.blockedReason = reason
    state.updatedAt = now()
    saveState(deps.cwd, state)
    return { state, report: buildReport(state, teamRetried) }
  }
  const pass = (phase: 'council' | 'team' | 'galaxy' | 'deliver', next: StarflowPhase, summary: string, status: 'passed' | 'skipped' = 'passed'): void => {
    state.phases[phase] = { status, summary, at: now() }
    state.phase = next
    state.blockedReason = undefined
    state.updatedAt = now()
    saveState(deps.cwd, state)
  }

  // ── 阶段 1：council 评审 ─────────────────────────────────────────────
  if (state.phase === 'council') {
    deps.params.onOutput?.(`${GLYPH} 星流 · 阶段 1/4 council 评审\n`)
    const councilInput: Record<string, unknown> = { objective: input.objective, confirm: true }
    if (input.draftItems && input.draftItems.length > 0) {
      councilInput.draftItems = input.draftItems
      // C: 基线预检（首轮）——工作树/提交现状注入 objective 尾部。
      // B: 增量评审——previousVerdict=passed 的未变条目渲染「沿用前轮通过结论」。
      councilInput.objective = augmentCouncilObjective(input.objective, input.draftItems, deps.cwd)
    }
    if (input.rounds) councilInput.rounds = input.rounds
    if (input.seats && input.seats.length > 0) councilInput.seats = input.seats
    const result = await deps.councilTool.execute({ ...subParams(deps, 'council'), input: councilInput })
    const gate = councilGate(result)
    if (!gate.ok) return block('council', gate.reason, firstLine(result.content))
    const planJson = extractPlanJson(result.content)
    if (planJson) state.planJson = planJson
    pass('council', 'team', firstLine(result.content))
  }

  // ── 阶段 2：team 波次（失败可回 council 复议一次） ─────────────────────
  if (state.phase === 'team') {
    deps.params.onOutput?.(`${GLYPH} 星流 · 阶段 2/4 team 波次\n`)
    for (;;) {
      // 多波计划：team_orchestrate 每次只派一个就绪波次，按续波提示逐波推进。
      let fromWave = 0
      let lastResult: ToolResult | undefined
      const waveTag = state.teamRetries > 0 ? `team-r${state.teamRetries}` : 'team'
      for (let wave = 0; wave < MAX_TEAM_WAVES; wave++) {
        const teamInput: Record<string, unknown> = { objective: input.objective, confirm: true, fromWave }
        if (state.planJson) teamInput.planJson = state.planJson
        lastResult = await deps.teamTool.execute({ ...subParams(deps, `${waveTag}-w${fromWave}`), input: teamInput })
        const gate = teamGate(lastResult)
        if (!gate.ok) {
          // 复议上限 1 次：回 council（rounds:2 复议轮）重审契约后再跑 team。
          if (state.teamRetries >= 1) return block('team', gate.reason, firstLine(lastResult.content))
          state.teamRetries++
          teamRetried = true
          state.updatedAt = now()
          saveState(deps.cwd, state)
          deps.params.onOutput?.(`${GLYPH} 星流 · team 门禁未过（${gate.reason}）→ 回 council 复议（上限 1 次）\n`)
          const reInput: Record<string, unknown> = { objective: input.objective, confirm: true, rounds: 2 }
          if (input.draftItems && input.draftItems.length > 0) {
            reInput.draftItems = input.draftItems
            // 复议轮带增量评审说明（B），不带基线预检（C 仅首轮——复议聚焦修订点）。
            reInput.objective = augmentCouncilObjective(input.objective, input.draftItems, deps.cwd, { precheck: false })
          }
          if (input.seats && input.seats.length > 0) reInput.seats = input.seats
          const reResult = await deps.councilTool.execute({ ...subParams(deps, 'council-retry'), input: reInput })
          const reGate = councilGate(reResult)
          if (!reGate.ok) return block('team', `复议未过：${reGate.reason}`, firstLine(reResult.content))
          state.planJson = extractPlanJson(reResult.content) ?? state.planJson
          break // 跳出波次循环，外层 for(;;) 重跑 team
        }
        const next = nextWaveOf(lastResult)
        if (next === undefined) break // 无下一波 = 已跑到末波
        fromWave = next
        if (wave === MAX_TEAM_WAVES - 1) {
          return block('team', `波次推进超过上限（${MAX_TEAM_WAVES}）——异常续波循环`, firstLine(lastResult.content))
        }
      }
      if (lastResult && !teamGate(lastResult).ok) continue // 已决定复议：回外层循环
      pass('team', 'galaxy', firstLine(lastResult?.content ?? ''))
      break
    }
  }

  // ── 阶段 3：galaxy 攻坚 ──────────────────────────────────────────────
  if (state.phase === 'galaxy') {
    const derived = input.galaxyDims ?? deriveGalaxyDims(input.draftItems)
    if (derived.length < 2) {
      // 无显式维度也无可派生草稿——galaxy schema 要求 min 2，不足即跳过。
      const why = input.galaxyDims
        ? `显式 galaxyDims 仅 ${derived.length} 个（min 2），跳过攻坚`
        : '无 draftItems 可派生维度，跳过攻坚'
      pass('galaxy', 'deliver', why, 'skipped')
    } else {
      deps.params.onOutput?.(`${GLYPH} 星流 · 阶段 3/4 galaxy 攻坚（${derived.length} 维度）\n`)
      const dims = derived.slice(0, 5)
      const result = await deps.galaxyTool.execute({
        ...subParams(deps, 'galaxy'),
        input: { objective: input.objective, dimensions: dims, autoReview: true, confirm: true },
      })
      const gate = galaxyGate(result)
      if (!gate.ok) return block('galaxy', gate.reason, firstLine(result.content))
      const truncated = derived.length > 5 ? `（草稿 ${derived.length} 项截断为 5 维）` : ''
      pass('galaxy', 'deliver', `${firstLine(result.content)}${truncated}`)
    }
  }

  // ── 阶段 4：交付清单（硬门禁归 deliver_task，此处只输出清单） ────────────
  if (state.phase === 'deliver') {
    pass('deliver', 'done', '交付清单已输出，待调用 deliver_task')
  }

  return { state, report: buildReport(state, teamRetried) }
}
