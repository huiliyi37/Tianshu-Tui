/**
 * Change classification — identifies mechanical changes (docs-only, pure
 * rename, comment/whitespace-only) that can bypass verification and review.
 *
 * Four classes:
 *  - docs-only          → skipReview + skipVerification
 *  - rename-mechanical  → skipReview + skipVerification
 *  - heuristic-rename   → skipReview only (still needs verification)
 *  - normal             → full pipeline
 *
 * Safety: owned_failure RED is NEVER bypassed regardless of class.
 * The gate bypass only applies to unverified RED.
 */

import { spawnGitSync } from '../tools/spawn-git.js'

export type ChangeClass = 'docs-only' | 'rename-mechanical' | 'heuristic-rename' | 'normal'

export interface ChangeClassification {
  class: ChangeClass
  /** Skip post-commit review workers (nudge only). */
  skipReview: boolean
  /** Skip delivery-gate verification requirement for unverified RED. */
  skipVerification: boolean
  reason: string
  files: readonly string[]
}

/** Abstraction over git diff so tests can inject fixed diffs. */
export interface DiffProvider {
  /** `git diff -M --name-status HEAD` output for tracked files. */
  nameStatus(): string
  /** Full patch for a single tracked file. */
  filePatch(file: string): string
}

// ── Patterns ──────────────────────────────────────────────────────

/** Docs / config / changelog — review adds zero value. */
const DOCS_FILE_PATTERN = /(?:^|\/)README|CHANGELOG(?:\.[^/]*)?$|\.(?:md|mdx|rst|adoc|txt|json|yaml|yml|toml|ini|cfg)$/i
/** docs/ directory contents (any extension, including no extension). */
const DOCS_DIR_PATTERN = /(?:^|\/)docs\//i
/** Test files. */
const TEST_FILE_PATTERN = /(?:^|\/)__tests__\//i

function isDocsOrTestFile(file: string): boolean {
  return DOCS_FILE_PATTERN.test(file) || DOCS_DIR_PATTERN.test(file) || TEST_FILE_PATTERN.test(file)
}

// ── Patch analysis helpers ────────────────────────────────────────

interface PatchLines {
  added: string[]
  removed: string[]
}

function parsePatchLines(patch: string): PatchLines {
  const added: string[] = []
  const removed: string[] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
    else if (line.startsWith('-')) removed.push(line.slice(1))
  }
  return { added, removed }
}

/** Check if patch lines are only comments or whitespace.
 *  Note: import reordering is NOT included here — import lines are code,
 *  not noise. The comment below mentioning "import reordering" was inaccurate. */
function isWhitespaceOrCommentOnly(added: string[], removed: string[]): boolean {
  const isNoise = (l: string) =>
    l.trim() === '' || l.trim().startsWith('//') || l.trim().startsWith('/*') || l.trim().startsWith('*') || l.trim().startsWith('*/')
  return added.every(isNoise) && removed.every(isNoise)
}

/**
 * Detect a single consistent identifier replacement across all changed lines.
 * Returns the (oldWord, newWord) pair if found, or null.
 *
 * Security: replacement must be a valid identifier ([a-zA-Z_$][a-zA-Z0-9_$]*),
 * length >= 2, and appear in EVERY changed line. This excludes:
 *  - Operator swaps (`===` → `!==`) — not identifiers
 *  - Boolean flips (`true` → `false`) — too short / not identifiers
 *  - Partial replacements (only some lines changed)
 */
function detectSingleIdentifierReplacement(added: string[], removed: string[]): { old: string; new: string } | null {
  if (added.length === 0 || added.length !== removed.length) return null
  if (added.length > 200) return null // cap for safety

  const IDENT = /[a-zA-Z_$][a-zA-Z0-9_$]*/g

  // Collect all identifiers in added and removed lines
  const collect = (lines: string[]): string[] => {
    const ids: string[] = []
    for (const line of lines) {
      const matches = line.matchAll(IDENT)
      for (const m of matches) ids.push(m[0])
    }
    return ids
  }

  const addedIds = collect(added)
  const removedIds = collect(removed)

  if (addedIds.length === 0 || removedIds.length === 0) return null

  // Count identifier frequencies
  const countFreq = (ids: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1)
    return m
  }

  const addedFreq = countFreq(addedIds)
  const removedFreq = countFreq(removedIds)

  // Find identifiers that exist in removed but not added (old name)
  // and identifiers in added but not removed (new name)
  const oldCandidates: string[] = []
  const newCandidates: string[] = []

  for (const [id, count] of removedFreq) {
    const inAdded = addedFreq.get(id) ?? 0
    if (inAdded < count) oldCandidates.push(id)
  }
  for (const [id, count] of addedFreq) {
    const inRemoved = removedFreq.get(id) ?? 0
    if (inRemoved < count) newCandidates.push(id)
  }

  // Must be exactly one old and one new candidate (single rename)
  if (oldCandidates.length !== 1 || newCandidates.length !== 1) return null
  const oldName = oldCandidates[0]!
  const newName = newCandidates[0]!

  // Must be valid identifiers with length >= 2
  if (oldName.length < 2 || newName.length < 2) return null
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(oldName)) return null
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) return null

  // Exclude boolean literals and common keywords — they're not identifiers
  // that should trigger rename detection. true→false, null→undefined, etc.
  // are logic changes disguised as "single replacement".
  const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'void', 'this', 'super'])
  if (KEYWORDS.has(oldName) || KEYWORDS.has(newName)) return null

  // Verify: replacing oldName with newName in removed lines should yield added lines
  for (let i = 0; i < added.length; i++) {
    const expected = removed[i]!.split(oldName).join(newName)
    if (expected !== added[i]) return null
  }

  return { old: oldName, new: newName }
}

// ── Core classifier ───────────────────────────────────────────────

export function classifyChange(
  files: readonly string[],
  diff: DiffProvider,
): ChangeClassification {
  if (files.length === 0) {
    return { class: 'normal', skipReview: false, skipVerification: false, reason: 'no files', files }
  }

  // ── docs-only: all files match docs/test patterns ──
  if (files.every(isDocsOrTestFile)) {
    return {
      class: 'docs-only',
      skipReview: true,
      skipVerification: true,
      reason: `${files.length} doc/test file(s), no code logic`,
      files,
    }
  }

  // ── For non-docs files, analyze git diff ──
  // Collect pure-rename (R100 = byte-identical content) endpoints. The name-status
  // is scoped to the dirty set (not just owned files), so git can pair the renamed
  // old path (often pre-existing/external) with the new owned path.
  const nameStatus = diff.nameStatus()
  const renameEndpoints = new Set<string>()
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const status = parts[0] ?? ''
    if (status.startsWith('R100')) {
      // Format: "R100\told\tnew"
      if (parts[1]) renameEndpoints.add(parts[1])
      if (parts[2]) renameEndpoints.add(parts[2])
    }
  }

  // rename-mechanical: every owned file is either a doc/test or a pure-rename
  // endpoint. A renamed file's content is byte-identical (R100), so there is no
  // logic to verify or review — even when the old path is external.
  if (renameEndpoints.size > 0 && files.every(f => isDocsOrTestFile(f) || renameEndpoints.has(f))) {
    return {
      class: 'rename-mechanical',
      skipReview: true,
      skipVerification: true,
      reason: `pure rename(s) R100, zero content change: ${[...renameEndpoints].join(', ')}`,
      files,
    }
  }

  // ── Check each non-docs tracked file's patch ──
  let allWhitespaceOrComment = true
  let singleRename: { old: string; new: string } | null = null
  let hasCodeFile = false

  for (const file of files) {
    if (isDocsOrTestFile(file)) continue
    hasCodeFile = true

    const patch = diff.filePatch(file)
    if (!patch) {
      // New/untracked file or no diff available — can't be mechanical
      allWhitespaceOrComment = false
      break
    }

    const { added, removed } = parsePatchLines(patch)

    if (added.length === 0 && removed.length === 0) continue // binary or no change

    if (!isWhitespaceOrCommentOnly(added, removed)) {
      allWhitespaceOrComment = false
      // Try heuristic rename detection
      const replacement = detectSingleIdentifierReplacement(added, removed)
      if (replacement) {
        if (singleRename === null) {
          singleRename = replacement
        } else if (singleRename.old !== replacement.old || singleRename.new !== replacement.new) {
          // Different replacements across files — not a single rename
          singleRename = null
          break
        }
      } else {
        // Not whitespace/comment and not a single identifier replacement
        singleRename = null
        break
      }
    }
  }

  // rename-mechanical: all changes are whitespace/comment/import reorder
  if (hasCodeFile && allWhitespaceOrComment) {
    return {
      class: 'rename-mechanical',
      skipReview: true,
      skipVerification: true,
      reason: 'all changes are comments or whitespace only',
      files,
    }
  }

  // heuristic-rename: consistent single identifier replacement across files
  if (singleRename) {
    return {
      class: 'heuristic-rename',
      skipReview: true,
      skipVerification: false, // still needs verification!
      reason: `consistent identifier rename: ${singleRename.old} → ${singleRename.new}`,
      files,
    }
  }

  return {
    class: 'normal',
    skipReview: false,
    skipVerification: false,
    reason: 'contains logic changes',
    files,
  }
}

// ── Real git diff provider ────────────────────────────────────────

/**
 * Create a DiffProvider that uses `git diff` to inspect tracked files.
 * Untracked (new) files are not renames — classify by path only.
 *
 * The tracked/untracked partition is computed lazily on first `filePatch` access
 * and via a SINGLE `git ls-files` call. Docs-only classifications short-circuit
 * before touching any diff, so they incur zero git subprocess cost.
 *
 * `dirtyFiles` (optional) widens the rename-detection scope: name-status runs
 * over the whole dirty set so `git -M` can pair a renamed old path (often
 * pre-existing/external, hence absent from the owned `files`) with its new path.
 * Falls back to `files` when omitted.
 */
export function createGitDiffProvider(
  cwd: string,
  files: readonly string[],
  dirtyFiles?: readonly string[],
): DiffProvider {
  // Lazy, memoized tracked/untracked split for owned files — used only by
  // filePatch. One `git ls-files -- <files>` returns the tracked subset.
  let partition: { untracked: ReadonlySet<string> } | undefined
  const getPartition = () => {
    if (partition) return partition
    const untracked = new Set<string>()
    if (files.length > 0) {
      const result = spawnGitSync(['-c', 'core.quotePath=false', 'ls-files', '--', ...files], {
        cwd, encoding: 'utf-8', timeout: 5000,
      })
      const listed = result.status === 0
        ? new Set(result.stdout.split('\n').filter(Boolean))
        : new Set<string>()
      for (const f of files) {
        if (!listed.has(f)) untracked.add(f)
      }
    }
    partition = { untracked }
    return partition
  }

  // Name-status over the dirty set (or owned files) so `git -M` can pair renames.
  const renameScope = dirtyFiles && dirtyFiles.length > 0 ? dirtyFiles : files
  let cachedNameStatus: string | undefined
  const nameStatus = (): string => {
    if (cachedNameStatus !== undefined) return cachedNameStatus
    if (renameScope.length === 0) { cachedNameStatus = ''; return cachedNameStatus }

    const result = spawnGitSync(['-c', 'core.quotePath=false', 'diff', '-M', '--name-status', 'HEAD', '--', ...renameScope], {
      cwd, encoding: 'utf-8', timeout: 10_000,
    })
    cachedNameStatus = result.status === 0 ? result.stdout : ''
    return cachedNameStatus
  }

  const filePatch = (file: string): string => {
    // Untracked files have no diff against HEAD
    if (getPartition().untracked.has(file)) return ''
    const result = spawnGitSync(['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', file], {
      cwd, encoding: 'utf-8', timeout: 10_000,
    })
    return result.status === 0 ? result.stdout : ''
  }

  return { nameStatus, filePatch }
}

/** Quick check: is mechanical fast-path enabled in config?
 *  Accepts the review config block directly (e.g. ctx.reviewConfig). */
export function isMechanicalFastPathEnabled(reviewConfig?: { mechanicalFastPath?: boolean }): boolean {
  return reviewConfig?.mechanicalFastPath !== false
}
