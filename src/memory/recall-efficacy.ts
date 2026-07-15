/**
 * Recall Efficacy Ledger — 召回健康账本（Wave 3，知识重构）。
 *
 * 记录维度：召回次数 / 空召回率 / 召回后被引用率。
 * postSession 聚合落盘到 `~/.rivet/memory/<hash>/recall-efficacy.jsonl`，
 * 一行一会话。监控目标：空召回率 > 50% 连续 3 个会话 → 账本行携带
 * `alert: true`（链路静默失效检测——召回通道坏了没人报错，只有账本能看出来）。
 *
 * "被引用"的判定是代理指标：召回条目的特征片段（前 60 字符）出现在
 * 召回之后的 assistant 输出中，视为被引用。粗糙但可落地，方向性足够。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryDir } from '../config/paths.js'

export interface RecallEvent {
  ts: number
  query: string
  resultCount: number
  /** 召回条目的特征片段（引用率检测用）。 */
  snippets: string[]
  /** Wave 5（反馈闭环）：召回条目的 id（gate-ledger join 用）。 */
  entryIds: string[]
  /** Wave 5（反馈闭环）：gate 准入条目的 id+片段（引用检测用）。 */
  gateEntries: Array<{ id: string; snippet: string }>
}

export interface SessionEfficacyRecord {
  sessionId: string
  ts: number
  recalls: number
  emptyRecalls: number
  emptyRate: number
  citedRecalls: number
  citeRate: number
  /** Wave 5: 被召回条目的 id 列表（截断上限，gate-ledger join 用）。 */
  recalledEntryIds: string[]
  /** Wave 5: gate 准入条目中被实际引用（片段出现在召回后的 assistant 输出）的去重条目数。 */
  gateAdmittedCited: number
  /** 空召回率 > 0.5 连续 ≥3 会话（含本会话）。 */
  alert: boolean
}

const EMPTY_RATE_THRESHOLD = 0.5
const ALERT_CONSECUTIVE_SESSIONS = 3
const SNIPPET_LENGTH = 60

function efficacyPath(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(memoryDir(hash), 'recall-efficacy.jsonl')
}

/** 会话级召回事件收集器。tool 侧 record，postSession 侧 finalize 落盘。 */
export class RecallEfficacyTracker {
  private events: RecallEvent[] = []

  constructor(private readonly sessionId: string) {}

  record(query: string, results: Array<{ text: string; id?: string; gateAdmitted?: boolean }>): void {
    this.events.push({
      ts: Date.now(),
      query: query.slice(0, 120),
      resultCount: results.length,
      snippets: results.slice(0, 8).map(r => r.text.slice(0, SNIPPET_LENGTH)),
      entryIds: results.filter(r => r.id).map(r => r.id!).slice(0, 20),
      gateEntries: results
        .filter(r => r.gateAdmitted && r.id)
        .slice(0, 8)
        .map(r => ({ id: r.id!, snippet: r.text.slice(0, SNIPPET_LENGTH) })),
    })
    // 会话内上限，防异常膨胀
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200)
  }

  get recallCount(): number {
    return this.events.length
  }

  /**
   * 聚合本会话账本行并落盘。
   * @param assistantTextAfterRecalls 召回发生后的 assistant 输出全文（引用率代理检测）。
   */
  finalize(cwd: string, assistantTextAfterRecalls: string): SessionEfficacyRecord | null {
    if (this.events.length === 0) return null

    const recalls = this.events.length
    const emptyRecalls = this.events.filter(e => e.resultCount === 0).length
    const emptyRate = emptyRecalls / recalls

    let citedRecalls = 0
    if (assistantTextAfterRecalls) {
      for (const event of this.events) {
        if (event.snippets.some(s => s.length >= 20 && assistantTextAfterRecalls.includes(s))) {
          citedRecalls++
        }
      }
    }
    const nonEmpty = recalls - emptyRecalls
    const citeRate = nonEmpty > 0 ? citedRecalls / nonEmpty : 0

    const alert = emptyRate > EMPTY_RATE_THRESHOLD
      && consecutiveHighEmptySessions(cwd) >= ALERT_CONSECUTIVE_SESSIONS - 1

    const record: SessionEfficacyRecord = {
      sessionId: this.sessionId,
      ts: Date.now(),
      recalls,
      emptyRecalls,
      emptyRate: round2(emptyRate),
      citedRecalls,
      citeRate: round2(citeRate),
      recalledEntryIds: [...new Set(this.events.flatMap(e => e.entryIds))].slice(0, 50),
      // gate 准入条目的引用检测：与 citedRecalls 同一代理指标（片段回现），
      // 但按条目去重——回答"闸门放进来的知识有没有被真的用上"。
      gateAdmittedCited: countCitedGateEntries(this.events, assistantTextAfterRecalls),
      alert,
    }

    try {
      const path = efficacyPath(cwd)
      mkdirSync(join(path, '..'), { recursive: true })
      appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8')
    } catch { /* ledger write is best-effort */ }

    return record
  }
}

/** gate 准入条目中片段回现于 assistant 输出的去重条目数。 */
function countCitedGateEntries(events: RecallEvent[], assistantText: string): number {
  if (!assistantText) return 0
  const cited = new Set<string>()
  for (const event of events) {
    for (const ge of event.gateEntries) {
      if (ge.snippet.length >= 20 && assistantText.includes(ge.snippet)) {
        cited.add(ge.id)
      }
    }
  }
  return cited.size
}

/** 最近账本行中，从末尾起连续 emptyRate > 阈值的会话数。 */
function consecutiveHighEmptySessions(cwd: string): number {
  const path = efficacyPath(cwd)
  if (!existsSync(path)) return 0
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
  } catch {
    return 0
  }
  let count = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]!) as SessionEfficacyRecord
      if (rec.emptyRate > EMPTY_RATE_THRESHOLD) count++
      else break
    } catch { break }
  }
  return count
}

/** 读取账本（诊断用）。 */
export function readEfficacyLedger(cwd: string, limit = 20): SessionEfficacyRecord[] {
  const path = efficacyPath(cwd)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map(line => JSON.parse(line) as SessionEfficacyRecord)
  } catch {
    return []
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Per-session registry ───────────────────────────────────────────────────
// memory 工具（bootstrap 期创建）与 postSession hook（loop-factory 期创建）
// 都要摸到同一个 tracker——用 sessionId 键的模块级注册表桥接，避免构造顺序耦合。

const trackers = new Map<string, RecallEfficacyTracker>()

export function getRecallTracker(sessionId: string): RecallEfficacyTracker {
  let tracker = trackers.get(sessionId)
  if (!tracker) {
    tracker = new RecallEfficacyTracker(sessionId)
    trackers.set(sessionId, tracker)
  }
  return tracker
}

/** postSession 落账后释放，防长驻进程（desktop sidecar）泄漏。 */
export function releaseRecallTracker(sessionId: string): void {
  trackers.delete(sessionId)
}
