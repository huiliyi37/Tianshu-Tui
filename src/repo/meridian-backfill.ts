/**
 * meridian-backfill.ts — Meridian 后台全量索引。
 *
 * 懒建（read_file 触发 indexFile）只覆盖 agent 读过的文件；本模块在启动后
 * 的闲时把可索引范围内的全项目文件逐步喂进同一 MeridianIndexer，让
 * repo_graph / related_tests / <codebase-index> 等 DB 派生消费端即刻受益。
 * 复用 indexFile()——hash 幂等（meridian-db needsParse）使与懒建重叠、
 * 重复调度都零成本；同一实例进程内天然串行（SQLite 单写者）。
 *
 * 调度纪律：串行批循环，批间 setTimeout(0) 让出事件循环；总量上限默认
 * 2000（RIVET_MERIDIAN_BACKFILL_MAX 可调）；RIVET_MERIDIAN_BACKFILL=0
 * 整体关闭。进程退出即自然终止——半成品文件 hash 已落库，下次接着建。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { MeridianIndexer } from './meridian-indexer.js'
import { isMeridianIndexablePath } from './meridian-indexer.js'
import { debugLog } from '../utils/debug.js'

/** 每批索引文件数——批间让出事件循环，TUI/sidecar 不被 tree-sitter 解析卡住。 */
const BACKFILL_BATCH_SIZE = 20
/** 默认全量索引上限（文件数）；RIVET_MERIDIAN_BACKFILL_MAX 覆盖。 */
export const DEFAULT_MERIDIAN_BACKFILL_MAX = 2000
/** git ls-files 枚举硬超时——启动闲时执行，比 file-completer 的 500ms 宽。 */
const GIT_LS_FILES_TIMEOUT_MS = 3000
/** 非 git 目录 readdir 回退的目录跳过集（与 indexer IGNORE_PATTERNS 对齐）。 */
const READDIR_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.rivet'])
/** readdir 回退的枚举总量上限——防止失控遍历巨型目录树。 */
const READDIR_ENUM_CAP = 10_000

export interface MeridianBackfillHandle {
  stop(): void
  /** 索引循环结束（含被 stop 提前终止）时 resolve——测试与调用方可等待。 */
  done: Promise<void>
}

/** `git ls-files --cached --others --exclude-standard`（gitignore 感知）。
 *  非 git 目录/命令失败/超时 → null，调用方回退 readdir。 */
function enumerateViaGit(cwd: string): string[] | null {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return output.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  } catch {
    return null
  }
}

/** 非 git 回退：有界递归 readdir，跳过依赖/构建/运行时目录。 */
function enumerateViaReaddir(cwd: string): string[] {
  const out: string[] = []
  const walk = (relDir: string): void => {
    if (out.length >= READDIR_ENUM_CAP) return
    let entries: Dirent[]
    try {
      entries = readdirSync(join(cwd, relDir || '.'), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= READDIR_ENUM_CAP) return
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!READDIR_SKIP_DIRS.has(entry.name)) walk(rel)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  walk('')
  return out
}

/** mtime 新→旧排序（最近改动的文件最可能被用到）；stat 失败的文件跳过。 */
function sortByMtimeDesc(cwd: string, rels: string[]): string[] {
  const withMtime: Array<{ rel: string; mtimeMs: number }> = []
  for (const rel of rels) {
    try {
      withMtime.push({ rel, mtimeMs: statSync(join(cwd, rel)).mtimeMs })
    } catch { /* 枚举后消失的文件跳过 */ }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withMtime.map(e => e.rel)
}

function backfillMaxFiles(): number {
  const raw = process.env.RIVET_MERIDIAN_BACKFILL_MAX
  if (!raw) return DEFAULT_MERIDIAN_BACKFILL_MAX
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MERIDIAN_BACKFILL_MAX
}

/**
 * 启动后台全量索引。调用方负责在闲时调度（两处入口均 setImmediate）。
 * 每个 indexer 实例只生效一次（实例上挂 flag），重复调用返回即刻完成的空句柄。
 */
export function scheduleMeridianBackfill(indexer: MeridianIndexer, cwd: string): MeridianBackfillHandle {
  let stopped = false
  const stop = (): void => { stopped = true }

  if (indexer.backfillScheduled) {
    return { stop, done: Promise.resolve() }
  }
  indexer.backfillScheduled = true

  if (process.env.RIVET_MERIDIAN_BACKFILL === '0') {
    debugLog('[meridian-backfill] disabled by RIVET_MERIDIAN_BACKFILL=0')
    return { stop, done: Promise.resolve() }
  }

  const maxFiles = backfillMaxFiles()
  const done = (async (): Promise<void> => {
    const enumerated = enumerateViaGit(cwd) ?? enumerateViaReaddir(cwd)
    // 与懒建完全同规则过滤（isMeridianIndexablePath 单一来源，防漂移）
    const candidates = sortByMtimeDesc(cwd, enumerated.filter(isMeridianIndexablePath)).slice(0, maxFiles)
    debugLog(`[meridian-backfill] start: ${candidates.length} candidates (cwd=${cwd})`)
    let indexed = 0
    for (let i = 0; i < candidates.length && !stopped; i += BACKFILL_BATCH_SIZE) {
      for (const rel of candidates.slice(i, i + BACKFILL_BATCH_SIZE)) {
        if (stopped) break
        try {
          await indexer.indexFile(rel)
          indexed++
        } catch { /* 单文件失败不阻塞整体 */ }
      }
      // 批间让出事件循环
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    debugLog(`[meridian-backfill] done: indexed=${indexed}/${candidates.length}${stopped ? ' (stopped)' : ''}`)
  })().catch(err => {
    debugLog(`[meridian-backfill] failed: ${String(err)}`)
  })

  return { stop, done }
}
