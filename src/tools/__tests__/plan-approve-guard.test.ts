import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validatePlanContentForApproval } from '../plan.js'
import { approvePlanAndKickoff, buildPlanKickoff } from '../../tui/slash-commands.js'
import { writePlan, readPlan } from '../../plan/plan-store.js'

/**
 * Empty/invalid-plan hard-fail at the approval boundary (kimi-code borrow).
 * `/plan-approve` and the plan-picker call this before writing the APPROVED
 * marker / kicking off execution, so a stale draft or gutted file cannot be
 * approved as if it were a finished plan.
 */
describe('validatePlanContentForApproval', () => {
  const CONCRETE_PLAN = [
    '# Real Plan',
    '',
    '## 根因分析',
    '循环边界未重置导致计数错误。',
    '',
    '## 实现方案',
    '```mermaid',
    'flowchart TD',
    '    A[输入] --> B{边界?}',
    '```',
    '',
    '修改 `src/agent/loop.ts:120`。',
    '',
    '## 验证',
    '运行 `npm test`。',
  ].join('\n')

  it('accepts a concrete, fully-written plan', () => {
    assert.deepEqual(validatePlanContentForApproval(CONCRETE_PLAN), { ok: true })
  })

  it('rejects an empty plan', () => {
    const r = validatePlanContentForApproval('   \n  \n')
    assert.equal(r.ok, false)
    assert.match(r.reason!, /空/)
  })

  it('rejects a plan that is only status markers (no body)', () => {
    const r = validatePlanContentForApproval('> **Status: APPROVED** — 2026-07-04T00:00:00.000Z\n\n')
    assert.equal(r.ok, false)
    assert.match(r.reason!, /空/)
  })

  it('rejects a plan riddled with placeholders', () => {
    const plan = [
      '# Draft',
      '## 根因分析',
      'TODO figure this out',
      '## 实现方案',
      'FIXME add design',
      '## 验证',
      'TBD write tests',
    ].join('\n')
    const r = validatePlanContentForApproval(plan)
    assert.equal(r.ok, false)
    assert.match(r.reason!, /占位符/)
  })

  it('rejects a plan with only-title empty sections', () => {
    const plan = [
      '# Draft',
      '',
      '## 根因分析',
      '',
      '## 实现方案',
      '',
    ].join('\n')
    const r = validatePlanContentForApproval(plan)
    assert.equal(r.ok, false)
  })

  it('accepts a parent heading whose body is structured into subsections', () => {
    // `## 实现` → `### 任务 1` is normal markdown structure, not an empty
    // section. The old regex rejected this and wedged plan submit.
    const plan = [
      '# Draft',
      '',
      '## 实现',
      '',
      '### 任务 1：引擎闸门',
      '在 loop.ts 增加 checkActionIntentGap 纯函数并接线。',
      '',
      '## 验证',
      '',
      '### 单元测试',
      '覆盖三种意图-调用错配场景。',
    ].join('\n')
    const r = validatePlanContentForApproval(plan)
    assert.equal(r.ok, true)
  })

  it('rejects an empty subsection followed by a same-level heading', () => {
    const plan = [
      '# Draft',
      '',
      '## 实现',
      '',
      '### 任务 1',
      '',
      '### 任务 2',
      '具体内容。',
    ].join('\n')
    const r = validatePlanContentForApproval(plan)
    assert.equal(r.ok, false)
  })
})

describe('buildPlanKickoff anchor drift injection', () => {
  it('appends the drift note with reality-first execution instructions', () => {
    const msg = buildPlanKickoff('my-plan', 'My Plan', undefined, '- 计划引用 `engine/gone.ts`，但该文件在当前项目中不存在')
    assert.match(msg, /锚点漂移提示/)
    assert.match(msg, /engine\/gone\.ts/)
    assert.match(msg, /以当前源码为准/)
  })

  it('omits the drift section when no note is given', () => {
    const msg = buildPlanKickoff('my-plan', 'My Plan')
    assert.doesNotMatch(msg, /锚点漂移/)
  })
})

/**
 * Approval-time anchor drift recheck: the plan was written against an earlier
 * tree state. Drift never blocks approval (aged plans are normal) — it is
 * surfaced in the approval notice and injected into the kickoff prompt so the
 * executor treats reality as ground truth.
 */
describe('approvePlanAndKickoff anchor drift recheck', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-approve-drift-'))
    mkdirSync(join(dir, 'engine'), { recursive: true })
    writeFileSync(join(dir, 'engine/alpha.ts'), 'export const a = 1\n', 'utf-8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeDeps() {
    const notices: string[] = []
    const kickoffs: string[] = []
    return {
      deps: {
        cwd: dir,
        agent: { setActivePlan: () => {} },
        submitToAgent: (prompt: string) => { kickoffs.push(prompt) },
        notify: (content: string) => { notices.push(content) },
      },
      notices,
      kickoffs,
    }
  }

  const planBody = (extraLine: string) => [
    '# Drift Plan',
    '',
    '## 根因分析',
    '边界未重置。',
    '',
    '## 实现方案',
    '```mermaid',
    'flowchart TD',
    '    A --> B',
    '```',
    '',
    extraLine,
  ].join('\n')

  it('approves despite drifted anchors and injects the drift list into the kickoff', async () => {
    await writePlan(dir, 'drift-plan', planBody('修改 `engine/vanished.ts` 的导出。'))
    const { deps, notices, kickoffs } = makeDeps()

    const ok = await approvePlanAndKickoff(deps, 'drift-plan')
    assert.equal(ok, true, 'drift must not block approval')

    const approved = await readPlan(dir, 'drift-plan')
    assert.equal(approved?.status, 'approved')

    assert.equal(kickoffs.length, 1)
    assert.match(kickoffs[0]!, /锚点漂移提示/)
    assert.match(kickoffs[0]!, /engine\/vanished\.ts/)
    assert.ok(notices.some(n => n.includes('锚点漂移复查')), 'drift surfaced in the approval notice')
  })

  it('keeps the kickoff clean when anchors match reality', async () => {
    await writePlan(dir, 'clean-plan', planBody('修改 `engine/alpha.ts` 的导出。'))
    const { deps, notices, kickoffs } = makeDeps()

    const ok = await approvePlanAndKickoff(deps, 'clean-plan')
    assert.equal(ok, true)
    assert.equal(kickoffs.length, 1)
    assert.doesNotMatch(kickoffs[0]!, /锚点漂移/)
    assert.ok(!notices.some(n => n.includes('锚点漂移')), 'no drift noise on clean plans')
  })
})
