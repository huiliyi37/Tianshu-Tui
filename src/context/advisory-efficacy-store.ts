/**
 * Advisory Efficacy Store — advisory 效能跨会话信息素（2026-07-04 因果账本演进 B）。
 *
 * 问题:AdvisoryReadback 的 per-key 统计随会话死亡——习惯化每会话冷启动、
 * 副驾闸门要求"决出样本 ≥10"意味着每个新会话前十几轮副驾必然沉睡、
 * holdout 资格(送达 ≥3)也从零攒起。
 *
 * 机制:per-key 效能计数落 `<cwd>/.rivet/knowledge/advisory-efficacy.jsonl`
 * (一行一 key),加载时按年龄 EWMA 衰减(半衰期 14 天)——陈旧数据自然让位
 * 于新证据。会话中每 20 轮 + postSession 以**增量**合并写回(多会话安全:
 * 原子写 + 锁,照 project-memory-writer 模式)。
 *
 * 已知局限(天枢标注):per-key 聚合抹平会话类型差异——同一 advisory 在
 * bugfix 会话可能有效、重构会话可能无效,EWMA 会把它们混在一起。session
 * 类型聚类会让复杂度暴涨,留待后续;消费方不应把先验当会话内实测用。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** EWMA 半衰期(毫秒)— 14 天 */
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
/** 衰减后各计数全低于此值的 key 从文件剔除(防无界增长) */
const PRUNE_THRESHOLD = 0.05
/** 文件最多保留的 key 数(按 delivered+shadowHeld 降序) */
const MAX_KEYS = 200
const LOCK_RETRY_MAX_MS = 500
const LOCK_RETRY_INTERVAL_MS = 20

/** per-key 效能先验(衰减后可为小数) */
export interface EfficacyPrior {
  key: string
  delivered: number
  adopted: number
  ignored: number
  shadowHeld: number
  shadowSatisfied: number
  updatedAt: number
}

/** 会话侧增量(整数计数,与 AdvisoryKeyStats 的持久化子集同构) */
export interface EfficacyDelta {
  delivered: number
  adopted: number
  ignored: number
  shadowHeld: number
  shadowSatisfied: number
}

const COUNTER_FIELDS = ['delivered', 'adopted', 'ignored', 'shadowHeld', 'shadowSatisfied'] as const

function decayFactor(ageMs: number): number {
  if (ageMs <= 0) return 1
  return Math.pow(0.5, ageMs / HALF_LIFE_MS)
}

/** 照 project-memory-writer 的 O_CREAT|O_EXCL 锁(多会话共享 cwd 必须) */
function acquireLock(lockPath: string): () => void {
  const start = Date.now()
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, String(process.pid), 'utf-8')
      closeSync(fd)
      return () => {
        try { unlinkSync(lockPath) } catch { /* lock already released */ }
      }
    } catch {
      if (Date.now() - start > LOCK_RETRY_MAX_MS) {
        return () => {}
      }
      const waitUntil = Date.now() + LOCK_RETRY_INTERVAL_MS
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

function atomicWrite(targetPath: string, dir: string, content: string): void {
  const tmpPath = join(dir, `.efficacy.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, targetPath)
}

function parseFile(path: string): Map<string, EfficacyPrior> {
  const out = new Map<string, EfficacyPrior>()
  if (!existsSync(path)) return out
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const p = JSON.parse(line) as Partial<EfficacyPrior>
      if (typeof p.key !== 'string' || typeof p.updatedAt !== 'number') continue
      out.set(p.key, {
        key: p.key,
        delivered: Number(p.delivered) || 0,
        adopted: Number(p.adopted) || 0,
        ignored: Number(p.ignored) || 0,
        shadowHeld: Number(p.shadowHeld) || 0,
        shadowSatisfied: Number(p.shadowSatisfied) || 0,
        updatedAt: p.updatedAt,
      })
    } catch { /* skip malformed lines */ }
  }
  return out
}

function decayed(prior: EfficacyPrior, now: number): EfficacyPrior {
  const f = decayFactor(now - prior.updatedAt)
  return {
    key: prior.key,
    delivered: prior.delivered * f,
    adopted: prior.adopted * f,
    ignored: prior.ignored * f,
    shadowHeld: prior.shadowHeld * f,
    shadowSatisfied: prior.shadowSatisfied * f,
    updatedAt: now,
  }
}

export class AdvisoryEfficacyStore {
  private readonly dir: string
  private readonly path: string
  private readonly lockPath: string

  constructor(cwd: string) {
    this.dir = join(cwd, '.rivet', 'knowledge')
    this.path = join(this.dir, 'advisory-efficacy.jsonl')
    this.lockPath = join(this.dir, 'advisory-efficacy.jsonl.lock')
  }

  /** 加载并按年龄衰减 — 会话启动时调用一次,结果喂 AdvisoryReadback.seedPriors */
  load(now = Date.now()): Map<string, EfficacyPrior> {
    const out = new Map<string, EfficacyPrior>()
    for (const [key, prior] of parseFile(this.path)) {
      const d = decayed(prior, now)
      if (COUNTER_FIELDS.every(f => d[f] < PRUNE_THRESHOLD)) continue
      out.set(key, d)
    }
    return out
  }

  /**
   * 增量合并写回 — 读最新文件(其他会话可能已写)、衰减到 now、叠加本会话
   * 增量、剔除衰减殆尽的 key、原子写。deltas 必须是**自上次 flush 以来的增量**
   * (调用方负责差分,重复提交同一累计值会翻倍计数)。
   */
  mergeAndSave(deltas: ReadonlyMap<string, EfficacyDelta>, now = Date.now()): void {
    let hasChange = false
    for (const d of deltas.values()) {
      if (COUNTER_FIELDS.some(f => d[f] > 0)) { hasChange = true; break }
    }
    if (!hasChange) return

    mkdirSync(this.dir, { recursive: true })
    const release = acquireLock(this.lockPath)
    try {
      const merged = new Map<string, EfficacyPrior>()
      for (const [key, prior] of parseFile(this.path)) {
        merged.set(key, decayed(prior, now))
      }
      for (const [key, delta] of deltas) {
        const base = merged.get(key) ?? { key, delivered: 0, adopted: 0, ignored: 0, shadowHeld: 0, shadowSatisfied: 0, updatedAt: now }
        for (const f of COUNTER_FIELDS) base[f] += delta[f]
        base.updatedAt = now
        merged.set(key, base)
      }
      const kept = [...merged.values()]
        .filter(p => COUNTER_FIELDS.some(f => p[f] >= PRUNE_THRESHOLD))
        .sort((a, b) => (b.delivered + b.shadowHeld) - (a.delivered + a.shadowHeld))
        .slice(0, MAX_KEYS)
      const lines = kept.map(p => JSON.stringify({
        key: p.key,
        delivered: round3(p.delivered),
        adopted: round3(p.adopted),
        ignored: round3(p.ignored),
        shadowHeld: round3(p.shadowHeld),
        shadowSatisfied: round3(p.shadowSatisfied),
        updatedAt: p.updatedAt,
      }))
      atomicWrite(this.path, this.dir, lines.join('\n') + (lines.length > 0 ? '\n' : ''))
    } finally {
      release()
    }
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
