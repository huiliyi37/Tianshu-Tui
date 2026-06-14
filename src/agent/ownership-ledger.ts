/**
 * OwnershipLedger — 文件归属登记 (B1-3)
 *
 * 结合 WorktreeBaseline 和 TaskLedger，回答：
 * - 这个文件属于当前任务吗？
 * - 哪些文件是我的，哪些是外部的？
 * - 给定一个文件列表，过滤出仅属于我的。
 *
 * 核心规则：文件 = 当前任务写入 AND 非 pre-existing。
 *
 * HEARTH 兼容：ownership 状态可在 cycle_close 时沉积为 durable claim。
 * Songline 兼容：owned files = agent 的义务范围（obligation scope）。
 *
 * @module ownership-ledger
 * @task B1-3
 */

import type { WorktreeBaseline } from './worktree-baseline.js'
import type { TaskLedger } from './task-ledger.js'

export interface OwnershipReport {
  taskId: string
  ownedFiles: string[]
  ownedFileCount: number
  coOwnedFiles: string[]
  coOwnedFileCount: number
  externalFiles: string[]
  externalFileCount: number
}

export interface OwnershipLedger {
  registerOwned(filePath: string): void
  /** Auto-populate owned files from TaskLedger write events */
  autoOwnFromLedger(): void
  /** Auto-classify unclassified dirty files by checking WorktreeBaseline.
   *  Files NOT in the baseline (pre-existing sets) are new → auto-owned.
   *  Call after autoOwnFromLedger to catch files from external writes. */
  autoOwnFromBaseline(dirtyFiles: string[]): void
  /** Adopt external files into owned set — for cross-session takeover scenarios.
   *  When another session crashes and the current session needs to commit its
   *  leftover changes, adoptFiles bypasses the normal ownership classification
   *  and forcefully adds files to the owned set.
   *  Returns the list of files that were actually adopted (were external before). */
  adoptFiles(files: string[]): string[]
  isOwned(filePath: string | null | undefined): boolean
  isExternal(filePath: string): boolean
  isCoOwned(filePath: string): boolean
  getOwnedFiles(): string[]
  getCoOwnedFiles(): string[]
  /** Get external files, optionally enriched with dynamic externals from current dirty files.
   *  When currentDirtyFiles is provided, files not classified as owned/co-owned/external
   *  are lazily classified as dynamic externals (created by other sessions after baseline). */
  getExternalFiles(currentDirtyFiles?: string[]): string[]
  /** Filter a file list to only owned files */
  scopeToOwned(files: string[]): string[]
  getOwnershipReport(): OwnershipReport
  /** VSW: real baseline commit SHA (BaselineSnapshot.head) — the commit-ish a
   *  snapshot worktree detaches onto. Distinct from baseline.getBaselineHash()
   *  which is a structural-identity hash for integrity checks. */
  getBaselineHead(): string
}

export function createOwnershipLedger(opts: {
  baseline: WorktreeBaseline
  taskLedger: TaskLedger
}): OwnershipLedger {
  const { baseline, taskLedger } = opts
  const ownedSet = new Set<string>()
  const coOwnedSet = new Set<string>()
  /** Adopted files — external files force-claimed via adoptFiles (cross-session takeover). */
  const adoptedSet = new Set<string>()

  function registerOwned(filePath: string): void {
    // External files can be co-owned (shared worktree scenario)
    if (baseline.isExternal(filePath)) {
      coOwnedSet.add(filePath)
      return
    }
    ownedSet.add(filePath)
  }

  function autoOwnFromLedger(): void {
    for (const event of taskLedger.getEvents()) {
      if ((event.type === 'file_write' || event.type === 'git_action') && event.path) {
        registerOwned(event.path)
      }
    }
  }

  function autoOwnFromBaseline(dirtyFiles: string[]): void {
    // Collect paths that have ledger traces for fast lookup
    const ledgerPaths = new Set<string>()
    for (const event of taskLedger.getEvents()) {
      if ((event.type === 'file_write' || event.type === 'git_action') && event.path) {
        ledgerPaths.add(event.path)
      }
    }
    for (const f of dirtyFiles) {
      // Already classified — skip
      if (ownedSet.has(f) || coOwnedSet.has(f)) continue
      // Pre-existing in baseline — not ours to auto-own
      if (baseline.isExternal(f)) continue
      // Must have a ledger trace (file_write/git_action) to auto-own.
      // Files modified by other sessions without our ledger record are not ours.
      if (!ledgerPaths.has(f)) continue
      ownedSet.add(f)
    }
  }

  function isOwned(filePath: string | null | undefined): boolean {
    if (!filePath) return false
    // Adopted files (cross-session takeover) are always considered owned
    if (adoptedSet.has(filePath)) return true
    if (baseline.isExternal(filePath)) return false
    return ownedSet.has(filePath)
  }

  function isExternal(filePath: string): boolean {
    return baseline.isExternal(filePath)
  }

  function isCoOwned(filePath: string): boolean {
    return coOwnedSet.has(filePath)
  }

  function getOwnedFiles(): string[] {
    return [...ownedSet, ...adoptedSet].sort()
  }

  function getCoOwnedFiles(): string[] {
    return [...coOwnedSet].sort()
  }

  function getExternalFiles(currentDirtyFiles?: string[]): string[] {
    const base = baseline.getExternalFiles()
    if (!currentDirtyFiles || currentDirtyFiles.length === 0) return base

    // Lazy reclassification: dirty files not owned, co-owned, adopted, or baseline-external
    // are dynamic externals — created by other sessions after baseline was taken.
    const dynamic: string[] = []
    for (const f of currentDirtyFiles) {
      if (!ownedSet.has(f) && !coOwnedSet.has(f) && !adoptedSet.has(f) && !baseline.isExternal(f)) {
        dynamic.push(f)
      }
    }
    if (dynamic.length === 0) return base
    return [...new Set([...base, ...dynamic])].sort()
  }

  function scopeToOwned(files: string[]): string[] {
    return files.filter(f => isOwned(f)).sort()
  }

  function adoptFiles(files: string[]): string[] {
    const adopted: string[] = []
    for (const f of files) {
      // 幂等：已 adopted 的文件跳过
      if (adoptedSet.has(f)) continue
      // 已 owned 的文件跳过（无需重复认领）
      if (ownedSet.has(f)) continue
      // co-owned → adopted：从共享所有权迁移为独占所有权
      if (coOwnedSet.has(f)) {
        coOwnedSet.delete(f)
      }
      adoptedSet.add(f)
      adopted.push(f)
    }
    return adopted.sort()
  }

  function getBaselineHead(): string {
    return baseline.getHead()
  }

  function getOwnershipReport(): OwnershipReport {
    const owned = getOwnedFiles()
    const coOwned = getCoOwnedFiles()
    const external = getExternalFiles()
    return {
      taskId: taskLedger.getTaskId(),
      ownedFiles: owned,
      ownedFileCount: owned.length,
      coOwnedFiles: coOwned,
      coOwnedFileCount: coOwned.length,
      externalFiles: external,
      externalFileCount: external.length,
    }
  }

  return {
    registerOwned,
    autoOwnFromLedger,
    autoOwnFromBaseline,
    adoptFiles,
    isOwned,
    isExternal,
    isCoOwned,
    getOwnedFiles,
    getCoOwnedFiles,
    getExternalFiles,
    scopeToOwned,
    getOwnershipReport,
    getBaselineHead,
  }
}
