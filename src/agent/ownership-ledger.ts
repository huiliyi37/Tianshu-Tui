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
  isOwned(filePath: string | null | undefined): boolean
  isExternal(filePath: string): boolean
  isCoOwned(filePath: string): boolean
  getOwnedFiles(): string[]
  getCoOwnedFiles(): string[]
  getExternalFiles(): string[]
  /** Filter a file list to only owned files */
  scopeToOwned(files: string[]): string[]
  getOwnershipReport(): OwnershipReport
}

export function createOwnershipLedger(opts: {
  baseline: WorktreeBaseline
  taskLedger: TaskLedger
}): OwnershipLedger {
  const { baseline, taskLedger } = opts
  const ownedSet = new Set<string>()
  const coOwnedSet = new Set<string>()

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
    for (const f of dirtyFiles) {
      // Already classified — skip
      if (ownedSet.has(f) || coOwnedSet.has(f)) continue
      // Pre-existing in baseline — not ours to auto-own
      if (baseline.isExternal(f)) continue
      // New file created this session → auto-own
      ownedSet.add(f)
    }
  }

  function isOwned(filePath: string | null | undefined): boolean {
    if (!filePath) return false
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
    return [...ownedSet].sort()
  }

  function getCoOwnedFiles(): string[] {
    return [...coOwnedSet].sort()
  }

  function getExternalFiles(): string[] {
    return baseline.getExternalFiles()
  }

  function scopeToOwned(files: string[]): string[] {
    return files.filter(f => isOwned(f)).sort()
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
    isOwned,
    isExternal,
    isCoOwned,
    getOwnedFiles,
    getCoOwnedFiles,
    getExternalFiles,
    scopeToOwned,
    getOwnershipReport,
  }
}
