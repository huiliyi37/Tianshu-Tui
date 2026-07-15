/**
 * Cross-session observation store — **write path disabled since Wave 2（知识重构）**.
 *
 * 历史职责：把正则提取的观察双写到 `~/.rivet/memory/<project-hash>/observations.jsonl`
 * 和 unified-memory。这是噪声链的落盘端——"任何提及"都会触发的 FACT_PATTERNS
 * 曾把互相矛盾的事实写成持久知识。
 *
 * 现状：
 * - `appendObservation` 不再持久化（返回构造好的记录，仅供内存缓冲/测试）
 * - 读路径保留：legacy observations.jsonl 只读兼容（历史数据召回）
 * - 观察类素材的准入由 postSession essence-gate 统一裁决（essence-gate.ts）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryDir } from '../config/paths.js'

export interface Observation {
  id: string
  text: string
  kind: 'fact' | 'decision' | 'preference' | 'constraint'
  confidence: number
  source: 'auto' | 'user' | 'agent'
  tags: string[]
  ts: number
  sessionId?: string
}

function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

function projectMemoryDir(cwd: string): string {
  return memoryDir(projectHash(cwd))
}

function observationsPath(cwd: string): string {
  return join(projectMemoryDir(cwd), 'observations.jsonl')
}

/**
 * @deprecated Wave 2 起不再落盘——构造并返回记录，但不写任何文件。
 * 观察素材应进入会话级缓冲，由 essence-gate 裁决后经 appendMemoryEntry 入库。
 */
export function appendObservation(_cwd: string, obs: Omit<Observation, 'id' | 'ts'> & { id?: string; ts?: number }): Observation {
  return {
    id: obs.id ?? `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text: obs.text.slice(0, 500),
    kind: obs.kind,
    confidence: obs.confidence,
    source: obs.source,
    tags: obs.tags,
    ts: obs.ts ?? Date.now(),
    sessionId: obs.sessionId,
  }
}

/** Read legacy observations (read-only compat — write path is dead). */
export function readObservations(cwd: string): Observation[] {
  const path = observationsPath(cwd)
  if (!existsSync(path)) return []

  const results: Observation[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
      try {
        results.push(JSON.parse(line) as Observation)
      } catch { /* skip malformed */ }
    }
  } catch {
    return []
  }
  return results
}

/** Keyword recall over legacy observations — score by term overlap with query. */
export function recallObservations(cwd: string, query: string, limit = 5): Observation[] {
  const terms = query.toLowerCase().split(/\W+/).filter(t => t.length >= 3)
  if (terms.length === 0) return []

  const scored = readObservations(cwd)
    .map(obs => {
      const text = obs.text.toLowerCase()
      const tagText = obs.tags.join(' ').toLowerCase()
      let score = 0
      for (const term of terms) {
        if (text.includes(term)) score += 2
        if (tagText.includes(term)) score += 1
      }
      score *= obs.confidence
      return { obs, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.obs.ts - a.obs.ts)

  return scored.slice(0, limit).map(s => s.obs)
}

/** Count how many times an observation text (normalized) has appeared. */
export function countSimilarObservations(cwd: string, text: string): number {
  const normalized = text.trim().toLowerCase().slice(0, 200)
  return readObservations(cwd).filter(o => o.text.trim().toLowerCase().slice(0, 200) === normalized).length
}
