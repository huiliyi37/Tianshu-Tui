/**
 * MergeProtocol — 三级合并协议
 *
 * Worker 完成后，diff 需要合并回主分支。
 *
 * Level 1: Auto-cherry-pick   — 无冲突，直接 cherry-pick
 * Level 2: Smart-rebase       — 有冲突，尝试按 hunk 智能应用
 * Level 3: Escalate           — 无法自动合并，生成冲突报告
 *
 * 设计原则：
 * - 尽可能自动化
 * - 失败时优雅降级
 * - 决不丢数据
 * - 使用 spawn 异步执行，不用 execSync
 */

import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { track } from '../tools/process-tracker.js'

// ─── Types ────────────────────────────────────────────────

export type MergeStrategy = 'auto_cherry_pick' | 'smart_rebase' | 'escalate'

export interface MergeInput {
  /** Worker 的分支名 */
  workerBranch: string
  /** Worker 的 worktree 路径 */
  workerPath: string
  /** 主分支名 */
  baseBranch: string
  /** 主工作目录 */
  basePath: string
  /** Worker 修改的文件列表 */
  changedFiles: string[]
  /** 已合并的文件列表（之前 worker 已合并的） */
  previouslyMergedFiles: string[]
}

export interface MergeResult {
  /** 使用的策略 */
  strategy: MergeStrategy
  /** 是否成功 */
  success: boolean
  /** 成功应用的文件 */
  appliedFiles: string[]
  /** 冲突文件 */
  conflictedFiles: string[]
  /** 冲突报告（仅 escalate 时） */
  report?: string
  /** 详细日志 */
  log: string[]
}

export interface DiffHunk {
  /** 起始行号（原始文件） */
  oldStart: number
  /** 行数（原始文件） */
  oldCount: number
  /** 起始行号（新文件） */
  newStart: number
  /** 行数（新文件） */
  newCount: number
  /** hunk 内容 */
  content: string
  /** 来源文件 */
  file: string
}

// ─── Async Git Helper ─────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = track(spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }))
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk))
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(chunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
      })
    })
    child.on('error', (err) => {
      resolve({ ok: false, stdout: '', stderr: err.message })
    })
  })
}

// ─── Level 1: Auto Cherry-Pick ────────────────────────────

/**
 * Level 1: 自动 cherry-pick
 *
 * 条件：worker 修改的文件与已合并的文件无交集
 * 操作：git add → commit → cherry-pick
 */
export async function autoCherryPick(input: MergeInput): Promise<MergeResult> {
  const log: string[] = []
  log.push(`[Level 1] Auto-cherry-pick: ${input.workerBranch} → ${input.baseBranch}`)

  // 检查文件重叠
  const overlap = input.changedFiles.filter(f => input.previouslyMergedFiles.includes(f))
  if (overlap.length > 0) {
    log.push(`[Level 1] File overlap detected: ${overlap.join(', ')}`)
    log.push(`[Level 1] Falling back to Level 2`)
    return smartRebase(input)
  }

  try {
    // 在 worker worktree 上提交所有更改
    await git(input.workerPath, ['add', '-A'])
    const commitMsg = `chore(worker): merge from ${input.workerBranch}`
    await git(input.workerPath, ['commit', '-m', commitMsg, '--allow-empty'])

    // 获取 commit hash
    const revResult = await git(input.workerPath, ['rev-parse', 'HEAD'])
    if (!revResult.ok) {
      log.push(`[Level 1] Failed to get commit hash: ${revResult.stderr}`)
      return smartRebase(input)
    }
    const commitHash = revResult.stdout.trim()

    // 在主仓库 cherry-pick
    const pickResult = await git(input.basePath, ['cherry-pick', '--no-commit', commitHash])
    if (!pickResult.ok) {
      log.push(`[Level 1] Cherry-pick failed: ${pickResult.stderr}`)
      // 回滚
      await git(input.basePath, ['cherry-pick', '--abort']).catch(() => {})
      log.push(`[Level 1] Falling back to Level 2`)
      return smartRebase(input)
    }

    log.push(`[Level 1] Cherry-pick successful: ${commitHash.slice(0, 8)}`)

    return {
      strategy: 'auto_cherry_pick',
      success: true,
      appliedFiles: [...input.changedFiles],
      conflictedFiles: [],
      log,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`[Level 1] Unexpected error: ${msg}`)
    return smartRebase(input)
  }
}

// ─── Level 2: Smart Rebase ────────────────────────────────

/**
 * Level 2: 智能 rebase
 *
 * 使用 git apply --3way 尝试应用 patch。
 * 如果失败，逐文件尝试。
 */
export async function smartRebase(input: MergeInput): Promise<MergeResult> {
  const log: string[] = []
  log.push(`[Level 2] Smart-rebase: ${input.workerBranch} → ${input.baseBranch}`)

  const appliedFiles: string[] = []
  const conflictedFiles: string[] = []

  // 获取 worker diff
  const diffResult = await git(input.workerPath, [
    'diff', input.baseBranch, '--', ...input.changedFiles,
  ])

  if (!diffResult.ok || !diffResult.stdout.trim()) {
    log.push(`[Level 2] Empty diff or failed: ${diffResult.stderr}`)
    return escalate(input, log)
  }

  const diffOutput = diffResult.stdout

  // 尝试整体 apply --3way
  const tmpPath = `${input.basePath}/.merge-diff.patch`
  try {
    writeFileSync(tmpPath, diffOutput)
    const applyResult = await git(input.basePath, ['apply', '--3way', tmpPath])
    unlinkSync(tmpPath)

    if (applyResult.ok) {
      log.push(`[Level 2] Applied with 3-way merge`)
      return {
        strategy: 'smart_rebase',
        success: true,
        appliedFiles: [...input.changedFiles],
        conflictedFiles: [],
        log,
      }
    }

    log.push(`[Level 2] Full apply failed: ${applyResult.stderr}`)
    try { unlinkSync(tmpPath) } catch { /* may already be deleted */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`[Level 2] Patch write failed: ${msg}`)
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }

  // 逐文件尝试
  const fileDiffs = splitDiffByFile(diffOutput)
  for (const [file, patch] of fileDiffs) {
    const fileTmpPath = `${input.basePath}/.merge-single.patch`
    try {
      writeFileSync(fileTmpPath, patch)
      const result = await git(input.basePath, ['apply', '--3way', fileTmpPath])
      unlinkSync(fileTmpPath)

      if (result.ok) {
        appliedFiles.push(file)
        log.push(`[Level 2] Applied: ${file}`)
      } else {
        conflictedFiles.push(file)
        log.push(`[Level 2] Conflict: ${file} — ${result.stderr.slice(0, 100)}`)
      }
    } catch {
      conflictedFiles.push(file)
      log.push(`[Level 2] Failed: ${file}`)
      try { unlinkSync(fileTmpPath) } catch { /* ignore */ }
    }
  }

  if (conflictedFiles.length > 0) {
    log.push(`[Level 2] ${conflictedFiles.length} files conflicted, escalating`)
    return escalate(input, log, appliedFiles, conflictedFiles)
  }

  return {
    strategy: 'smart_rebase',
    success: true,
    appliedFiles,
    conflictedFiles: [],
    log,
  }
}

// ─── Level 3: Escalate ────────────────────────────────────

/**
 * Level 3: 上报
 *
 * 无法自动合并时，生成详细的冲突报告返回给 coordinator。
 */
export function escalate(
  input: MergeInput,
  inheritedLog: string[] = [],
  appliedFiles: string[] = [],
  conflictedFiles: string[] = [],
): MergeResult {
  const log = [...inheritedLog]
  log.push(`[Level 3] Escalating to coordinator`)

  const report = [
    `# Merge Conflict Report`,
    ``,
    `## Worker`,
    `- Branch: ${input.workerBranch}`,
    `- Path: ${input.workerPath}`,
    `- Changed files: ${input.changedFiles.join(', ')}`,
    ``,
    `## Base`,
    `- Branch: ${input.baseBranch}`,
    `- Path: ${input.basePath}`,
    ``,
    `## Status`,
    `- Applied: ${appliedFiles.join(', ') || 'none'}`,
    `- Conflicted: ${conflictedFiles.join(', ') || 'unknown'}`,
    `- Previously merged: ${input.previouslyMergedFiles.join(', ') || 'none'}`,
    ``,
    `## Resolution Required`,
    conflictedFiles.length > 0
      ? `The following files need manual resolution: ${conflictedFiles.join(', ')}`
      : `Automatic merge failed entirely. Manual review needed.`,
    ``,
    `## Logs`,
    ...log.map(l => `  ${l}`),
  ].join('\n')

  return {
    strategy: 'escalate',
    success: false,
    appliedFiles,
    conflictedFiles,
    report,
    log,
  }
}

// ─── Parser ───────────────────────────────────────────────

/**
 * 解析 unified diff 为 hunks
 */
export function parseDiffHunks(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  const lines = diffOutput.split('\n')
  let currentFile = ''
  let currentHunk: Partial<DiffHunk> | null = null
  let hunkContent: string[] = []

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentHunk && currentHunk.file && currentHunk.content) {
        hunks.push(currentHunk as DiffHunk)
      }
      currentHunk = null
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/)
      if (match) {
        currentFile = match[2]!
      }
      continue
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      if (currentHunk && currentHunk.file) {
        currentHunk.content = hunkContent.join('\n')
        hunks.push(currentHunk as DiffHunk)
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1]!, 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3]!, 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        file: currentFile,
      }
      hunkContent = [line]
      continue
    }

    if (currentHunk) {
      hunkContent.push(line)
    }
  }

  if (currentHunk && currentHunk.file) {
    currentHunk.content = hunkContent.join('\n')
    hunks.push(currentHunk as DiffHunk)
  }

  return hunks
}

/**
 * 将 diff 按 diff --git 分割为每个文件的独立 diff
 */
export function splitDiffByFile(diffOutput: string): Map<string, string> {
  const result = new Map<string, string>()
  const parts = diffOutput.split(/(?=diff --git)/)

  for (const part of parts) {
    if (!part.startsWith('diff --git')) continue
    const match = part.match(/diff --git a\/(.+?) b\/(.+)/)
    if (match) {
      result.set(match[2]!, part)
    }
  }

  return result
}

// ─── Top-level Entry ──────────────────────────────────────

/**
 * 执行合并协议（从 Level 1 开始，逐级降级）
 */
export async function executeMergeProtocol(input: MergeInput): Promise<MergeResult> {
  return autoCherryPick(input)
}
