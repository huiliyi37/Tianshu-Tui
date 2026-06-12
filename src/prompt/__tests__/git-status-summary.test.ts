import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeGitStatus, parseGitStatus } from '../git-status-summary.js'

/** Build a git status string that exceeds the 1200-char threshold. */
function makeLongStatus(files: { modified?: number; untracked?: number; staged?: number; branch?: string }): string {
  const branch = files.branch ?? 'main'
  const lines: string[] = [`On branch ${branch}`]
  if ((files.staged ?? 0) > 0) {
    lines.push('Changes to be committed:')
    for (let i = 0; i < (files.staged ?? 0); i++) {
      lines.push(`  new file:   src/staged/file-with-long-name-${i}.ts`)
    }
  }
  if ((files.modified ?? 0) > 0) {
    lines.push('Changes not staged for commit:')
    for (let i = 0; i < (files.modified ?? 0); i++) {
      lines.push(`  modified:   src/api/client-with-long-path-${i}.ts`)
    }
  }
  if ((files.untracked ?? 0) > 0) {
    lines.push('Untracked files:')
    for (let i = 0; i < (files.untracked ?? 0); i++) {
      lines.push(`  src/context/new-module-with-long-name-${i}.ts`)
    }
  }
  return lines.join('\n')
}

describe('summarizeGitStatus', () => {
  it('returns original status when under threshold and no attention noise is present', () => {
    const short = 'On branch main\nChanges: 1 file'
    assert.equal(summarizeGitStatus(short), short)
  })

  it('folds attention noise even when short-status input is under threshold', () => {
    const status = [
      'Current branch: main',
      'Status:',
      ' M src/prompt/volatile.ts',
      '?? .codex/hooks.json',
      '?? layout.log',
      '?? docs/teamtask.zip',
      '?? node_modules/pkg/index.js',
    ].join('\n')
    assert.ok(status.length <= 1200, `fixture should stay under threshold, got ${status.length}`)

    const result = summarizeGitStatus(status)

    assert.match(result, /\[main\]/)
    assert.match(result, /modified: src\/prompt\/volatile\.ts/)
    assert.match(result, /2 runtime fragments folded/)
    assert.match(result, /1 foreign tool footprint folded/)
    assert.match(result, /1 build outputs omitted/)
    assert.doesNotMatch(result, /\.codex\/hooks\.json/)
    assert.doesNotMatch(result, /layout\.log/)
    assert.doesNotMatch(result, /docs\/teamtask\.zip/)
  })

  it('returns empty string for empty input', () => {
    assert.equal(summarizeGitStatus(''), '')
  })

  it('summarizes when over threshold with modified/untracked files', () => {
    const long = makeLongStatus({ modified: 15, untracked: 10, branch: 'feat/tianshu-test' })
    assert.ok(long.length > 1200, `fixture should exceed threshold, got ${long.length}`)
    const result = summarizeGitStatus(long)
    assert.match(result, /\[feat\/tianshu-test\]/)
    assert.match(result, /15 modified/)
    assert.match(result, /10 untracked/)
    // File paths preserved
    assert.match(result, /src\/api\/client-with-long-path-0\.ts/)
    assert.match(result, /src\/context\/new-module-with-long-name-0\.ts/)
  })

  it('summarizes many modified files', () => {
    const long = makeLongStatus({ modified: 30 })
    assert.ok(long.length > 1200, `fixture should exceed threshold, got ${long.length}`)
    const result = summarizeGitStatus(long)
    assert.match(result, /30 modified/)
    assert.match(result, /src\/api\/client-with-long-path-0\.ts/)
    assert.match(result, /src\/api\/client-with-long-path-29\.ts/)
  })

  it('includes staged files in summary', () => {
    const long = makeLongStatus({ staged: 20, modified: 15 })
    assert.ok(long.length > 1200, `fixture should exceed threshold, got ${long.length}`)
    const result = summarizeGitStatus(long)
    assert.match(result, /20 staged/)
    assert.match(result, /15 modified/)
  })

  it('parses and summarizes long short-status input without losing paths', () => {
    const status = [
      'Current branch: main',
      'Status:',
      ' M src/prompt/volatile.ts',
      '?? docs/teamtask/T7-落地实施方案·注意力闸分阶段执行.md',
      ...Array.from({ length: 40 }, (_, i) => `?? src/context/generated-content-${i}.ts`),
    ].join('\n')
    assert.ok(status.length > 1200, `fixture should exceed threshold, got ${status.length}`)

    const result = summarizeGitStatus(status)

    assert.match(result, /\[main\]/)
    assert.match(result, /modified: src\/prompt\/volatile\.ts/)
    assert.match(result, /untracked: .*docs\/teamtask\/T7-/)
    assert.doesNotMatch(result, /\[unknown\]/)
  })

  it('annotates the summary as the complete worktree state (anti doom-loop)', () => {
    const long = makeLongStatus({ modified: 15, untracked: 10 })
    const result = summarizeGitStatus(long)

    assert.match(result, /共 25 个文件（完整列表）/)
    assert.match(result, /无需再跑 git status/)
  })

  it('explains folded items and points to the git tool when noise is folded', () => {
    const status = [
      'Current branch: main',
      'Status:',
      ' M src/prompt/volatile.ts',
      '?? layout.log',
      '?? node_modules/pkg/index.js',
    ].join('\n')
    const result = summarizeGitStatus(status)

    assert.match(result, /共 1 个任务相关文件（完整列表），另有 2 个无关项已折叠/)
    assert.match(result, /用 git 工具，不要用 bash 重跑 git status/)
  })

  it('folds attention noise in long short-status input while keeping content visible', () => {
    const status = [
      'Current branch: main',
      'Status:',
      ' M src/prompt/volatile.ts',
      '?? docs/teamtask/T7-落地实施方案·注意力闸分阶段执行.md',
      '?? layout.log',
      '?? .codex/hooks.json',
      '?? node_modules/pkg/index.js',
      ...Array.from({ length: 40 }, (_, i) => `?? .rivet/tasks/events/task_${i}.jsonl`),
    ].join('\n')
    assert.ok(status.length > 1200, `fixture should exceed threshold, got ${status.length}`)

    const result = summarizeGitStatus(status)

    assert.match(result, /modified: src\/prompt\/volatile\.ts/)
    assert.match(result, /untracked: docs\/teamtask\/T7-/)
    assert.match(result, /41 runtime fragments folded/)
    assert.match(result, /1 foreign tool footprint folded/)
    assert.doesNotMatch(result, /layout\.log/)
    assert.doesNotMatch(result, /\.codex\/hooks\.json/)
    assert.doesNotMatch(result, /node_modules/)
  })
})

describe('parseGitStatus', () => {
  it('extracts branch name', () => {
    const result = parseGitStatus('On branch feat/my-feature\n')
    assert.equal(result.branch, 'feat/my-feature')
  })

  it('defaults to unknown when no branch line', () => {
    const result = parseGitStatus('some random text')
    assert.equal(result.branch, 'unknown')
  })

  it('parses staged and modified sections', () => {
    const status = [
      'On branch main',
      'Changes to be committed:',
      '  new file:   src/new.ts',
      'Changes not staged for commit:',
      '  modified:   src/old.ts',
    ].join('\n')
    const result = parseGitStatus(status)
    assert.deepEqual(result.staged, ['src/new.ts'])
    assert.deepEqual(result.modified, ['src/old.ts'])
  })

  it('parses extensionless untracked paths in long status', () => {
    const status = [
      'On branch main',
      'Untracked files:',
      '  README',
      '  Makefile',
      '  LICENSE',
      '  src/new.ts',
    ].join('\n')
    const result = parseGitStatus(status)
    assert.deepEqual(result.untracked, ['README', 'Makefile', 'LICENSE', 'src/new.ts'])
  })

  it('does not treat unindented advisory text as untracked files', () => {
    const status = [
      'On branch main',
      'Untracked files:',
      '  README',
      '',
      'nothing added to commit but untracked files present (use "git add" to track)',
    ].join('\n')
    const result = parseGitStatus(status)
    assert.deepEqual(result.untracked, ['README'])
  })
})
