import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkPlanMode, canonicalizePathForCompare, PLAN_MODE_ALLOWED_TOOLS, createActivePlanDraftPath } from '../plan-mode.js'
import { profileIsWriteCapable, profileIsPlanModeSafe } from '../profile-registry.js'
import { createDefaultToolRegistry } from '../../tools/default-registry.js'
import { WEB_SEARCH_TOOL } from '../../tools/web-search.js'
import { createRepoGraphTool } from '../../tools/repo-graph.js'
import { createMemoryTool } from '../../tools/memory.js'
import { ASK_USER_QUESTION_TOOL } from '../../tools/ask-user-question.js'
import type { ContextClaimStore } from '../../context/claim-store.js'

describe('checkPlanMode', () => {
  it('off state allows all tools', () => {
    assert.deepEqual(checkPlanMode('off', 'write_file'), { allowed: true })
    assert.deepEqual(checkPlanMode('off', 'bash'), { allowed: true })
    assert.deepEqual(checkPlanMode('off', 'edit_file'), { allowed: true })
  })

  it('planning state allows read-only exploration and planning tools', () => {
    const allowedTools = ['read_file', 'read_section', 'grep', 'glob', 'repo_map',
      'inspect_project', 'related_tests', 'diff', 'todo', 'plan',
      'repo_graph', 'web_fetch', 'web_search', 'memory',
      'ask_user_question', 'delegate_task']
    for (const tool of allowedTools) {
      assert.deepEqual(checkPlanMode('planning', tool), { allowed: true }, `${tool} should be allowed`)
    }
  })

  it('planning state blocks write tools except active plan file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-mode-'))
    try {
      const planPath = '.rivet/plans/draft-test.md'
      const blocked = checkPlanMode('planning', 'write_file', { cwd: dir, targetFilePath: 'src/foo.ts', activePlanFilePath: planPath })
      assert.equal(blocked.allowed, false)

      const allowed = checkPlanMode('planning', 'write_file', { cwd: dir, targetFilePath: planPath, activePlanFilePath: planPath })
      assert.equal(allowed.allowed, true)

      const editAllowed = checkPlanMode('planning', 'edit_file', { cwd: dir, targetFilePath: planPath, activePlanFilePath: planPath })
      assert.equal(editAllowed.allowed, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 2026-07-06 Windows 兼容: 盘符大小写在真实环境不稳定（VSCode/Git Bash 给
  // c:\proj，process.cwd() 给 C:\proj），NTFS 本身大小写不敏感。逐字节比较会
  // 误拒活动计划文件写入 → 草稿永远为空，桌面「起草中」实时视图断流。
  it('canonicalizePathForCompare: backslashes + drive-letter case folding', () => {
    // Windows 形路径：分隔符归一 + 整体小写（NTFS 大小写不敏感）
    assert.equal(
      canonicalizePathForCompare('C:\\Proj\\.rivet\\plans\\draft-1.md'),
      canonicalizePathForCompare('c:/proj/.rivet/plans/draft-1.md'),
    )
    // POSIX 路径保持大小写敏感（ext4/APFS 默认区分大小写）
    assert.notEqual(
      canonicalizePathForCompare('/tmp/Plans/draft-1.md'),
      canonicalizePathForCompare('/tmp/plans/draft-1.md'),
    )
  })

  it('planning allows the active plan file addressed with backslash separators', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-plan-mode-'))
    try {
      const planPath = '.rivet/plans/draft-win.md'
      // 模型在 Windows 上常回显反斜杠相对路径 — 必须与活动计划文件匹配
      const allowed = checkPlanMode('planning', 'write_file', {
        cwd: dir,
        targetFilePath: '.rivet\\plans\\draft-win.md',
        activePlanFilePath: planPath,
      })
      assert.equal(allowed.allowed, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('planning state blocks other write tools', () => {
    const blockedTools = ['bash', 'git', 'apply_patch']
    for (const tool of blockedTools) {
      const result = checkPlanMode('planning', tool)
      assert.equal(result.allowed, false, `${tool} should be blocked`)
      assert.ok(result.reason, `${tool} should have a reason`)
      assert.ok(result.reason!.includes('Plan Mode'), `${tool} reason should mention Plan Mode`)
    }
  })

  it('planning state allows run_tests (瑶光反证 plan-time reproduction)', () => {
    assert.deepEqual(checkPlanMode('planning', 'run_tests'), { allowed: true })
  })

  it('planning state allows delegate_batch but blocks deliver_task', () => {
    // delegate_batch is allowed in plan mode (parallel read-only scouts for investigation)
    const batchResult = checkPlanMode('planning', 'delegate_batch')
    assert.equal(batchResult.allowed, true, 'delegate_batch should be allowed for parallel investigation')

    // deliver_task (execution/commit) is blocked — it's a write operation
    const deliverResult = checkPlanMode('planning', 'deliver_task')
    assert.equal(deliverResult.allowed, false, 'deliver_task should be blocked in plan mode')
    assert.ok(deliverResult.reason!.includes('Plan Mode'), 'deliver_task reason should mention Plan Mode')
  })

  it('planning state blocks delegation of write/execute-capable profiles', () => {
    for (const tool of ['delegate_task', 'delegate_batch']) {
      const denied = checkPlanMode('planning', tool, { delegatesWriteCapableProfile: true })
      assert.equal(denied.allowed, false, `${tool} with write profile should be blocked`)
      assert.ok(denied.reason!.includes('Plan Mode'), `${tool} reason should mention Plan Mode`)
      assert.ok(/patcher|read-only/i.test(denied.reason!), `${tool} reason should explain read-only-only`)
    }
  })

  it('planning state still allows delegation of read-only scout profiles', () => {
    for (const tool of ['delegate_task', 'delegate_batch']) {
      assert.deepEqual(
        checkPlanMode('planning', tool, { delegatesWriteCapableProfile: false }),
        { allowed: true },
        `${tool} with read-only scout should be allowed`,
      )
      // no ctx flag at all → default read-only delegation, allowed
      assert.deepEqual(checkPlanMode('planning', tool), { allowed: true })
    }
  })

  it('off state ignores the write-capable-profile flag', () => {
    assert.deepEqual(checkPlanMode('off', 'delegate_task', { delegatesWriteCapableProfile: true }), { allowed: true })
  })

  it('PLAN_MODE_ALLOWED_TOOLS includes clarification and delegation', () => {
    assert.ok(PLAN_MODE_ALLOWED_TOOLS.has('ask_user_question'))
    assert.ok(PLAN_MODE_ALLOWED_TOOLS.has('delegate_task'))
    assert.ok(PLAN_MODE_ALLOWED_TOOLS.has('delegate_batch'))
    assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has('write_file'))
    assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has('deliver_task'))
  })

  it('createActivePlanDraftPath returns draft path under .rivet/plans', () => {
    const path = createActivePlanDraftPath()
    assert.match(path, /^\.rivet\/plans\/draft-\d+\.md$/)
  })

  it('profileIsWriteCapable flags patcher/hands profiles, not read-only scouts', () => {
    assert.equal(profileIsWriteCapable('code_scout'), false)
    assert.equal(profileIsWriteCapable('doc_scout'), false)
    assert.equal(profileIsWriteCapable('patcher'), true)
    // unknown profile → false (delegate schema reports the real error)
    assert.equal(profileIsWriteCapable('no_such_profile_xyz'), false)
  })

  it('profileIsPlanModeSafe: scouts + test-only verifiers pass, real write/exec profiles fail', () => {
    // Read-only scouts — safe.
    assert.equal(profileIsPlanModeSafe('code_scout'), true)
    assert.equal(profileIsPlanModeSafe('doc_scout'), true)
    // readonly_plus_test — run_tests only beyond read-only → safe (瑶光反证 reproduction).
    assert.equal(profileIsPlanModeSafe('adversarial_verifier'), true)
    assert.equal(profileIsPlanModeSafe('goal_judge'), true)
    // Write/exec-capable — blocked until approval.
    assert.equal(profileIsPlanModeSafe('patcher'), false)
    assert.equal(profileIsPlanModeSafe('verifier'), false) // holds full WRITE_TOOLS incl. bash
    // Unknown profile → safe (delegate schema reports the real error)
    assert.equal(profileIsPlanModeSafe('no_such_profile_xyz'), true)
  })

  it('every PLAN_MODE_ALLOWED_TOOLS entry resolves to a registered tool', () => {
    const defaultNames = createDefaultToolRegistry([], { desktopTools: true, browserTool: true })
      .getDefinitions()
      .map(d => d.name)
    const interactiveNames = [
      WEB_SEARCH_TOOL.definition.name,
      createRepoGraphTool(() => null).definition.name,
      createMemoryTool({} as ContextClaimStore).definition.name,
      ASK_USER_QUESTION_TOOL.definition.name,
      'delegate_task',
      'delegate_batch',
    ]
    const available = new Set([...defaultNames, ...interactiveNames])
    for (const tool of PLAN_MODE_ALLOWED_TOOLS) {
      assert.ok(
        available.has(tool),
        `PLAN_MODE_ALLOWED_TOOLS references "${tool}" but no tool registers it (orphan/drift)`,
      )
    }
  })
})
