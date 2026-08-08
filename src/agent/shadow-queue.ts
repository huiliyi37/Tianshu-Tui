import { stat, statSync } from 'node:fs'
import { promisify } from 'node:util'
import type { ToolPrediction } from './tool-pattern-miner.js'

const statAsync = promisify(stat)

const READ_ONLY_SPECULATIVE_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir'])

export interface ShadowQueueDeps {
  execute: (tool: string, target: string) => Promise<string>
  minProbability?: number
  /**
   * Entries older than this are treated as a miss regardless of mtime/size,
   * mirroring PrewarmCache's TTL convention. Bounds the worst case for tool
   * types whose `target` isn't a reliable staleness signal (see mtimeMs
   * comment on CachedResult) — without a TTL, a stale-but-unstattable entry
   * could sit in the queue indefinitely.
   */
  ttlMs?: number
}

type PredictionSource = NonNullable<ToolPrediction['source']>

interface CachedResult {
  tool: string
  target: string
  result: string
  source: PredictionSource
  enqueuedAt: number
  /**
   * stat() taken right after execute() resolved (mirrors prewarm-file.ts
   * buildPrewarmValue). Reliable staleness signal for `read_file` (target is
   * a real file — any edit moves mtime/size). Weaker for `grep`/`list_dir`
   * (target is often a directory: adding/removing files moves its mtime, but
   * editing an existing file's content inside it does not) — TTL is the
   * backstop for that gap, not a full fix. Absent when stat() failed at
   * enqueue time (deleted mid-flight, or a target that isn't a real fs path
   * at all) — checkHit treats absence as "can't verify" and never serves it,
   * rather than assuming freshness.
   */
  mtimeMs?: number
  sizeBytes?: number
}

export type ShadowQueueSourceStats = Record<PredictionSource, { enqueued: number; hits: number }>

function emptySourceStats(): ShadowQueueSourceStats {
  return {
    'tool-pattern': { enqueued: 0, hits: 0 },
    'physarum-file': { enqueued: 0, hits: 0 },
    combined: { enqueued: 0, hits: 0 },
    llm: { enqueued: 0, hits: 0 },
  }
}

/**
 * 2026-07-06 事故：本类完全没有 staleness 校验——预读结果在目标文件历经多次
 * 编辑后仍被当作 read_file 的实时结果返回，模型据此推理出"文件被回退"之类
 * 的幻觉结论。P3-P4（本次修复）补两层防线：①enqueue 时 stat 一次留痕，
 * checkHit 时重新 stat 比对 mtime/size，任一漂移或缺失即判 miss；②TTL 兜底
 * （见 mtimeMs 注释——目录级 target 的 mtime 信号本身不完整）。写/编辑工具
 * 执行后应调 {@link ShadowQueue.clear} 整队失效（镜像 PrewarmCache.invalidate
 * 的调用点模式，但本队列不是按文件路径索引的单一 key-value 存储，粗粒度整队
 * 清空是这个数据结构下唯一安全的等价物——best-effort 投机缓存，清空代价是
 * 一次浪费的预读，不是正确性问题）。
 */
export class ShadowQueue {
  private cache: CachedResult[] = []
  private inflight = 0
  private readonly minProbability: number
  private readonly ttlMs: number
  private sourceStats: ShadowQueueSourceStats = emptySourceStats()

  constructor(private deps: ShadowQueueDeps) {
    this.minProbability = deps.minProbability ?? 0.4
    this.ttlMs = deps.ttlMs ?? 60_000
  }

  enqueue(prediction: ToolPrediction): void {
    if (prediction.probability < this.minProbability) return
    if (!READ_ONLY_SPECULATIVE_TOOLS.has(prediction.tool)) return
    if (!prediction.likelyTarget) return
    this.inflight++
    const target = prediction.likelyTarget
    const source: PredictionSource = prediction.source ?? 'tool-pattern'
    this.sourceStats[source].enqueued++
    // stat 与 execute **并行**，不是读完之后再 stat。两个理由：
    // ① 正确性——读完才 stat 的话，「读到一半文件被改」会把改后的 mtime 记成
    //    基线，checkHit 比对时反而判定新鲜并返回那份读了一半旧内容的结果，
    //    正是本校验要防的 stale read。并行取的是读取起点的状态，期间任何改动
    //    都会让 checkHit 比对失配而判 miss（fail-closed）。
    // ② 时延——串行会把入队完成推迟一整次文件 IO，投机预读本就是在跟真实读
    //    抢时间，慢盘/高负载下这段延迟直接吃掉命中窗口。
    void Promise.all([
      this.deps.execute(prediction.tool, target),
      statAsync(target).catch(() => null),
    ]).then(([result, fileStat]) => {
      this.cache.push({
        tool: prediction.tool,
        target,
        result,
        source,
        enqueuedAt: Date.now(),
        ...(fileStat ? { mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size } : {}),
      })
    }).catch(() => {
      // Speculative execution failed — silently absorb.
      // Shadow queue is best-effort; failures should not cause
      // unhandledRejection or disrupt the main agent loop.
    }).finally(() => { this.inflight-- })
  }

  checkHit(tool: string, target: string): string | undefined {
    const idx = this.cache.findIndex(c => c.tool === tool && c.target === target)
    if (idx === -1) return undefined
    const [hit] = this.cache.splice(idx, 1) as [CachedResult]
    if (Date.now() - hit.enqueuedAt > this.ttlMs) return undefined
    // No usable stat from enqueue time (deleted mid-flight, or target isn't a
    // real fs path) — never assume freshness for something we couldn't verify.
    if (hit.mtimeMs === undefined || hit.sizeBytes === undefined) return undefined
    let live: ReturnType<typeof statSync>
    try {
      live = statSync(target)
    } catch {
      return undefined // deleted since enqueue
    }
    if (live.mtimeMs !== hit.mtimeMs || live.size !== hit.sizeBytes) return undefined
    this.sourceStats[hit.source].hits++
    return hit.result
  }

  /** Per-source enqueue/hit counters — which prediction source is earning its keep. */
  statsBySource(): ShadowQueueSourceStats {
    return {
      'tool-pattern': { ...this.sourceStats['tool-pattern'] },
      'physarum-file': { ...this.sourceStats['physarum-file'] },
      combined: { ...this.sourceStats.combined },
      llm: { ...this.sourceStats.llm },
    }
  }

  pending(): number { return this.inflight }
  clear(): void { this.cache = [] }

  /**
   * 已落队的结果数。
   *
   * `enqueue` 是异步落队（execute + stat 并行后才 push），测试若用固定 sleep
   * 等它，高负载下两头都出错：期望命中的用例假失败，而期望 miss 的用例会因为
   * 「还没入队」而 miss——看着绿，实际一行校验逻辑都没走到。用它做确定性等待。
   */
  get cachedCount(): number { return this.cache.length }
}
