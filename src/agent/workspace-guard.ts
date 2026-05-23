/**
 * WorkspaceGuard — Stash / Runtime Artifact Guard
 *
 * 防止以下事故：
 * - .rivet/artifacts 被提交到 git
 * - .rivet/sessions 被误删
 * - stash 内容旧版本覆盖新版本
 * - 评分/验证文件被 merge 覆盖
 * - agent 直接 apply stash 导致回退
 *
 * 关键规则：
 * 1. .rivet/artifacts/ 不应 tracked
 * 2. .rivet/sessions/ 不应 tracked，除非明确提升
 * 3. stash apply 前应逐文件比较 hash
 * 4. merge 前检查 untracked overwrite
 * 5. runtime artifacts 被 ignore 不是可删除许可
 *
 * HEARTH 兼容：safeToMerge 可作为 delivery gate 的一部分。
 * Songline 兼容：reasons 字符串列表可被 obligation engine 读取。
 *
 * @module workspace-guard
 * @task C
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// ── Types ───────────────────────────────────────────────────────────

export interface WorkspaceGuardReport {
  trackedRuntimeArtifacts: string[]
  ignoredButPresentRuntimeArtifacts: string[]
  stashConflicts: Array<{
    stashRef: string
    path: string
    status: 'same' | 'older' | 'newer' | 'conflict' | 'unknown'
  }>
  wouldOverwriteUntracked: string[]
  safeToMerge: boolean
  reasons: string[]
}

export interface RuntimeArtifactCheck {
  tracked: string[]
  ignoredButPresent: string[]
  blocked: boolean
  reasons: string[]
}

export interface StashSafetyCheck {
  conflicts: WorkspaceGuardReport['stashConflicts']
  blocked: boolean
  reasons: string[]
}

export interface MergeSafetyCheck {
  wouldOverwriteUntracked: string[]
  blocked: boolean
  reasons: string[]
}

export interface WorkspaceGuard {
  /** Check if runtime artifacts (.rivet/artifacts, .rivet/sessions) are tracked or ignorantly present. */
  checkRuntimeArtifacts(): Promise<RuntimeArtifactCheck>

  /** Check if applying a stash would overwrite newer working-tree content. */
  checkStashSafety(stashRef: string): Promise<StashSafetyCheck>

  /** Check if merging a branch would overwrite untracked files. */
  checkMergeSafety(targetBranch: string): Promise<MergeSafetyCheck>

  /** Full diagnostic report. */
  fullReport(stashRef?: string, targetBranch?: string): Promise<WorkspaceGuardReport>
}

// ── Constants ───────────────────────────────────────────────────────

const RUNTIME_DIRS = ['.rivet/artifacts', '.rivet/sessions']

/** Files within .rivet/ that are explicitly promoted to tracked — everything else must be untracked. */
const PROMOTED_RIVET_FILES = new Set(['.rivet/playbook.jsonl'])

// ── Git helpers ─────────────────────────────────────────────────────

async function gitLines(args: string[], cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
    return stdout.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function gitString(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
    return stdout
  } catch {
    return ''
  }
}

/** Returns true if the path exists and is a regular file in the working tree. */
function fileExists(absPath: string): boolean {
  try {
    return statSync(absPath).isFile()
  } catch {
    return false
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ── Implementation ──────────────────────────────────────────────────

export function createWorkspaceGuard(cwd: string): WorkspaceGuard {
  const absCwd = resolve(cwd)

  // ── checkRuntimeArtifacts ──────────────────────────────────────

  async function checkRuntimeArtifacts(): Promise<RuntimeArtifactCheck> {
    const reasons: string[] = []
    const tracked: string[] = []
    const ignoredButPresent: string[] = []

    // Get all tracked files from git
    const trackedLines = await gitLines(['ls-files', '--cached'], absCwd)

    // Check each runtime directory
    for (const dir of RUNTIME_DIRS) {
      // Check: is anything under this dir tracked?
      for (const line of trackedLines) {
        if (line.startsWith(dir + '/') || line === dir) {
          // Allow explicitly promoted files
          if (!PROMOTED_RIVET_FILES.has(line)) {
            tracked.push(line)
          }
        }
      }

      // Check: is the dir present on disk but gitignored?
      const dirAbs = resolve(absCwd, dir)
      if (existsSync(dirAbs)) {
        const ignoredFiles = await gitLines(
          ['ls-files', '--others', '--ignored', '--exclude-standard', dir],
          absCwd,
        )
        if (ignoredFiles.length > 0) {
          ignoredButPresent.push(...ignoredFiles)
        }
      }
    }

    if (tracked.length > 0) {
      reasons.push(
        `BLOCKED: ${tracked.length} runtime artifact(s) tracked in git: ${tracked.join(', ')}. ` +
        `These belong in .gitignore (${RUNTIME_DIRS.join(', ')}). Run: git rm --cached ${tracked.join(' ')}`,
      )
    }

    if (ignoredButPresent.length > 0) {
      reasons.push(
        `WARNING: ${ignoredButPresent.length} runtime artifact(s) are gitignored but present on disk. ` +
        `They are NOT safe to delete — they may contain un-promoted verification evidence, ` +
        `failure records, or session handoff data.`,
      )
    }

    return {
      tracked,
      ignoredButPresent,
      blocked: tracked.length > 0,
      reasons,
    }
  }

  // ── checkStashSafety ───────────────────────────────────────────

  async function checkStashSafety(stashRef: string): Promise<StashSafetyCheck> {
    const reasons: string[] = []
    const conflicts: WorkspaceGuardReport['stashConflicts'] = []

    // Get list of files in stash
    const stashFiles = await gitLines(
      ['stash', 'show', '--name-only', stashRef],
      absCwd,
    )

    if (stashFiles.length === 0) {
      return { conflicts: [], blocked: false, reasons: ['Stash has no files to compare.'] }
    }

    for (const file of stashFiles) {
      const absPath = resolve(absCwd, file)
      if (!fileExists(absPath)) {
        conflicts.push({ stashRef, path: file, status: 'unknown' })
        continue
      }

      // Get current working-tree hash
      const currentContent = readFileSync(absPath, 'utf-8')
      const currentHash = sha256(currentContent)

      // Get stash version hash
      const stashContent = await gitString(['show', `${stashRef}:${file}`], absCwd)
      if (!stashContent) {
        conflicts.push({ stashRef, path: file, status: 'unknown' })
        continue
      }
      const stashHash = sha256(stashContent)

      if (currentHash === stashHash) {
        conflicts.push({ stashRef, path: file, status: 'same' })
        continue
      }

      // Compare modification times to determine older/newer
      // We use git log to get stash timestamp
      const stashTime = await gitString(
        ['log', '-1', '--format=%ct', stashRef],
        absCwd,
      )
      const stashTimestamp = stashTime ? parseInt(stashTime.trim(), 10) * 1000 : 0
      const currentMtime = statSync(absPath).mtimeMs

      if (currentMtime > stashTimestamp) {
        conflicts.push({ stashRef, path: file, status: 'newer' })
      } else if (currentMtime < stashTimestamp) {
        conflicts.push({ stashRef, path: file, status: 'older' })
      } else {
        // Same mtime but different content — potential conflict
        conflicts.push({ stashRef, path: file, status: 'conflict' })
      }
    }

    const newerFiles = conflicts.filter(c => c.status === 'newer')
    const conflictFiles = conflicts.filter(c => c.status === 'conflict')

    if (newerFiles.length > 0) {
      reasons.push(
        `BLOCKED: ${newerFiles.length} file(s) in working tree are newer than stash ${stashRef}: ` +
        `${newerFiles.map(f => f.path).join(', ')}. ` +
        `Applying stash would overwrite newer content.`,
      )
    }

    if (conflictFiles.length > 0) {
      reasons.push(
        `WARNING: ${conflictFiles.length} file(s) have same timestamp but different content vs stash: ` +
        `${conflictFiles.map(f => f.path).join(', ')}.`,
      )
    }

    return {
      conflicts,
      blocked: newerFiles.length > 0 || conflictFiles.length > 0,
      reasons,
    }
  }

  // ── checkMergeSafety ───────────────────────────────────────────

  async function checkMergeSafety(targetBranch: string): Promise<MergeSafetyCheck> {
    const reasons: string[] = []
    const wouldOverwriteUntracked: string[] = []

    // Get files in target branch that aren't in current HEAD
    const targetFiles = await gitLines(
      ['ls-tree', '-r', '--name-only', targetBranch],
      absCwd,
    )

    // Get current untracked files
    const untracked = await gitLines(
      ['ls-files', '--others', '--exclude-standard'],
      absCwd,
    )
    const untrackedSet = new Set(untracked)

    // Check overlap
    for (const file of targetFiles) {
      if (untrackedSet.has(file)) {
        wouldOverwriteUntracked.push(file)
      }
    }

    // Also check: would any runtime artifacts be affected?
    const runtimeCheck = await checkRuntimeArtifacts()
    if (runtimeCheck.blocked) {
      reasons.push(...runtimeCheck.reasons)
    }

    if (wouldOverwriteUntracked.length > 0) {
      reasons.push(
        `BLOCKED: merge from ${targetBranch} would overwrite ${wouldOverwriteUntracked.length} untracked file(s): ` +
        `${wouldOverwriteUntracked.join(', ')}. ` +
        `Commit or stash these files first.`,
      )
    }

    return {
      wouldOverwriteUntracked,
      blocked: wouldOverwriteUntracked.length > 0 || runtimeCheck.blocked,
      reasons,
    }
  }

  // ── fullReport ─────────────────────────────────────────────────

  async function fullReport(
    stashRef?: string,
    targetBranch?: string,
  ): Promise<WorkspaceGuardReport> {
    const runtimeCheck = await checkRuntimeArtifacts()
    const reasons = [...runtimeCheck.reasons]

    let stashConflicts: WorkspaceGuardReport['stashConflicts'] = []
    let wouldOverwriteUntracked: string[] = []

    if (stashRef) {
      const stashCheck = await checkStashSafety(stashRef)
      stashConflicts = stashCheck.conflicts
      reasons.push(...stashCheck.reasons)
    }

    if (targetBranch) {
      const mergeCheck = await checkMergeSafety(targetBranch)
      wouldOverwriteUntracked = mergeCheck.wouldOverwriteUntracked
      reasons.push(...mergeCheck.reasons)
    }

    const safeToMerge = !reasons.some(r => r.startsWith('BLOCKED:'))

    return {
      trackedRuntimeArtifacts: runtimeCheck.tracked,
      ignoredButPresentRuntimeArtifacts: runtimeCheck.ignoredButPresent,
      stashConflicts,
      wouldOverwriteUntracked,
      safeToMerge,
      reasons,
    }
  }

  return {
    checkRuntimeArtifacts,
    checkStashSafety,
    checkMergeSafety,
    fullReport,
  }
}
