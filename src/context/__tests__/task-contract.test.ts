import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceContractStatus,
  contractStatusFromPhaseClass,
  extractTaskContract,
  renderContractProjection,
  renderTaskAnchor,
  isActionableTurn,
  classifyTaskDepth,
  classifyPlanMethodology,
  type TaskDepthLayer,
  type PlanMethodology,
} from '../task-contract.js'

// StarSpine Phase 1: TaskContract is the smallest mission anchor.
describe('extractTaskContract', () => {
  it('extracts objective from simple user message', () => {
    const contract = extractTaskContract('fix the auth bug in login.ts')
    assert.equal(contract.objective, 'fix the auth bug in login.ts')
    assert.equal(contract.status, 'exploring')
    assert.equal(contract.isActionable, true)
  })

  it('extracts file scope from message mentioning files', () => {
    const contract = extractTaskContract('refactor src/auth/middleware.ts and src/auth/types.ts to use zod validation')
    assert.ok(contract.scope.mentionedFiles.includes('src/auth/middleware.ts'))
    assert.ok(contract.scope.mentionedFiles.includes('src/auth/types.ts'))
  })

  it('extracts constraints from messages with English and Chinese constraint markers', () => {
    const contract = extractTaskContract('add rate limiting to the API. Don\'t modify the database schema. Must be backwards compatible. 不要改接口签名')
    assert.ok(contract.constraints.length >= 3)
    assert.ok(contract.constraints.some(c => c.includes('database schema')))
    assert.ok(contract.constraints.some(c => c.includes('backwards compatible')))
    assert.ok(contract.constraints.some(c => c.includes('接口签名')))
  })

  it('handles Chinese user messages', () => {
    const contract = extractTaskContract('修复 src/api/client.ts 的重试逻辑，不要改接口签名')
    assert.equal(contract.status, 'exploring')
    assert.ok(contract.scope.mentionedFiles.includes('src/api/client.ts'))
    assert.ok(contract.constraints.some(c => c.includes('接口签名')))
  })

  it('truncates long objectives to 200 chars', () => {
    const contract = extractTaskContract('x'.repeat(300))
    assert.ok(contract.objective.length <= 200)
  })

  it('marks short greetings as non-actionable', () => {
    const contract = extractTaskContract('你好')
    assert.equal(contract.isActionable, false)
    assert.equal(renderContractProjection(contract), '')
  })
})

describe('TaskContract projection', () => {
  it('renders actionable exploring contracts instead of omitting them', () => {
    const contract = extractTaskContract('fix src/api/client.ts retry bug')
    const projection = renderContractProjection(contract)
    assert.match(projection, /<task-contract/)
    assert.match(projection, /status="exploring"/)
    assert.match(projection, /fix src\/api\/client.ts retry bug/)
  })

  it('escapes XML in objective, scope, and constraints', () => {
    const contract = extractTaskContract('fix <Button> & preserve "API" in src/ui/button.ts. Don\'t break <legacy> & old API')
    const projection = renderContractProjection(contract)
    assert.ok(projection.includes('&lt;Button&gt;'))
    assert.ok(projection.includes('&amp;'))
    assert.ok(projection.includes('&quot;API&quot;'))
    assert.ok(projection.includes('&lt;legacy&gt;'))
    assert.ok(!projection.includes('<Button>'))
  })

  it('keeps projection compact', () => {
    const contract = extractTaskContract('refactor src/auth/middleware.ts and src/auth/types.ts to use zod validation. Don\'t modify the database schema. Must be backwards compatible.')
    const projection = renderContractProjection(advanceContractStatus(contract, 'executing', 2))
    assert.ok(projection.length < 600, `Projection too long: ${projection.length}`)
  })
})

describe('advanceContractStatus', () => {
  it('advances status monotonically', () => {
    const contract = extractTaskContract('implement src/foo.ts feature')
    const executing = advanceContractStatus(contract, 'executing', 2)
    const planning = advanceContractStatus(executing, 'planning', 3)
    assert.equal(planning.status, 'executing')
    assert.equal(planning.updatedAtTurn, 2)
  })

  it('allows forward progress and blocked recovery', () => {
    const contract = extractTaskContract('implement src/foo.ts feature')
    const blocked = advanceContractStatus(contract, 'blocked', 2)
    assert.equal(blocked.status, 'blocked')
    const recovered = advanceContractStatus(blocked, 'executing', 3)
    assert.equal(recovered.status, 'executing')
    assert.equal(recovered.updatedAtTurn, 3)
  })

  it('renders an authoritative task anchor fusing contract + progress (C4)', () => {
    const contract = advanceContractStatus(
      extractTaskContract('refactor src/auth/middleware.ts. Don\'t break the API. Must be backwards compatible.', 1),
      'executing',
      3,
    )
    const anchor = renderTaskAnchor(contract, {
      completed: ['wired the guard'],
      remaining: ['add regression test'],
    })
    assert.match(anchor, /<task-anchor authoritative="true" status="executing">/)
    assert.match(anchor, /AUTHORITATIVE/)
    assert.match(anchor, /middleware\.ts/)
    assert.match(anchor, /<constraint>/)
    assert.match(anchor, /<completed>wired the guard<\/completed>/)
    assert.match(anchor, /<remaining>add regression test<\/remaining>/)
    assert.match(anchor, /<\/task-anchor>/)
  })

  it('returns empty anchor for a non-actionable contract (C4)', () => {
    assert.equal(renderTaskAnchor(extractTaskContract('你好', 1)), '')
  })

  it('maps phase classes to contract lifecycle statuses', () => {
    assert.equal(contractStatusFromPhaseClass('explore'), 'exploring')
    assert.equal(contractStatusFromPhaseClass('plan'), 'planning')
    assert.equal(contractStatusFromPhaseClass('execute'), 'executing')
    assert.equal(contractStatusFromPhaseClass('verify'), 'verifying')
    assert.equal(contractStatusFromPhaseClass('deliver'), 'ready_to_deliver')
    assert.equal(contractStatusFromPhaseClass('unknown'), undefined)
  })

  // ── isActionable fixes: CJK weight + greeting prefix ──

  it('classifies short Chinese task as actionable via CJK weight', () => {
    // "优化性能" = 4 CJK chars = weight 8 ≥ 6 → actionable
    const c = extractTaskContract('优化性能', 1)
    assert.equal(c.isActionable, true, '"优化性能" (CJK weight 8) should be actionable')
  })

  it('classifies ambiguous 2-char Chinese as non-actionable (insufficient weight)', () => {
    // "修复" alone = 2 CJK chars = weight 4 < 6 → non-actionable
    const c = extractTaskContract('修复', 1)
    assert.equal(c.isActionable, false, '"修复" alone (weight 4) is too ambiguous')
  })

  it('classifies "修复bug" (CJK+Latin mix, weight 7) as actionable', () => {
    const c = extractTaskContract('修复bug', 1)
    assert.equal(c.isActionable, true, '"修复bug" (weight 7 ≥ 6) should be actionable')
  })

  it('classifies "下一步" (weight 6) as actionable', () => {
    const c = extractTaskContract('下一步', 1)
    assert.equal(c.isActionable, true, '"下一步" (weight 6) should be actionable')
  })

  it('classifies "辛苦了" (weight 6) as non-actionable via pattern gate', () => {
    const c = extractTaskContract('辛苦了', 1)
    assert.equal(c.isActionable, false, '"辛苦了" passes weight gate but matches greeting pattern')
  })

  it('classifies "谢谢你" as non-actionable via expanded pattern', () => {
    const c = extractTaskContract('谢谢你', 1)
    assert.equal(c.isActionable, false, '"谢谢你" should match expanded greeting pattern')
  })

  it('classifies short Chinese with file as actionable', () => {
    const c = extractTaskContract('重构 src/api/client.ts', 1)
    assert.equal(c.isActionable, true, 'file mention should trigger actionable')
  })

  it('strips greeting prefix and extracts real objective from line 2', () => {
    const c = extractTaskContract('你好\n请修复 src/api/client.ts 的重试逻辑', 1)
    assert.equal(c.isActionable, true, 'greeting prefix should be stripped')
    assert.ok(c.objective.includes('修复'), `expected objective to contain 修复, got: ${c.objective}`)
  })

  it('still catches pure greeting as non-actionable', () => {
    const c = extractTaskContract('你好', 1)
    assert.equal(c.isActionable, false, 'pure greeting should be non-actionable')
  })

  it('still catches thanks as non-actionable', () => {
    const c = extractTaskContract('谢谢', 1)
    assert.equal(c.isActionable, false)
  })

  it('isActionableTurn returns true for actionable messages', () => {
    assert.equal(isActionableTurn('修复 src/api/client.ts'), true)
  })

  it('isActionableTurn returns false for pure greetings', () => {
    assert.equal(isActionableTurn('谢谢'), false)
  })
})

// ── PlanMethodology Router Tests ────────────────────────────────────

function makeContract(
  objective: string,
  files: string[] = [],
  constraints: string[] = [],
): ReturnType<typeof extractTaskContract> {
  return extractTaskContract(
    [objective, ...files.map(f => `见 ${f}`), ...constraints].join('\n'),
    1,
  )
}

describe('classifyPlanMethodology', () => {
  // ── Rule 1: SYSTEM depth → always 'full' ──
  it('routes system-depth task to full even with zero enforcement files', () => {
    const contract = makeContract('端到端重构整个请求管线')
    const depth = classifyTaskDepth(contract)
    assert.equal(depth, 'system')
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'full', 'system depth must always route to full')
  })

  it('routes system-depth task to full regardless of file content', () => {
    const contract = makeContract('全链路性能优化', ['src/tui/app.tsx', 'docs/readme.md'])
    const depth = classifyTaskDepth(contract)
    assert.equal(depth, 'system')
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'full')
  })

  // ── Rule 2a: Multi-gate verb pattern → 'full' ──
  it('routes multi-gate verb pattern to full', () => {
    const contract = makeContract('接通 sandbox-profile 和 path-validate 的双门授权检查')
    const depth = classifyTaskDepth(contract)
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'full', '双门/接通 verb must route to full')
  })

  // ── Rule 2b: 2+ enforcement files → 'full' ──
  it('routes 2 enforcement files to full (counterexample: file-count-only fails here)', () => {
    const contract = makeContract(
      '同步 path-validate 和 sandbox-profile 的授权逻辑',
      ['src/tools/path-validate.ts', 'src/tools/sandbox-profile.ts', 'src/tools/bash.ts'],
    )
    const depth = classifyTaskDepth(contract)
    // 3 files → wiring depth
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'full',
      '2+ enforcement files across subsystems must route to full — file-count-only impl would miss this')
  })

  // ── Rule 2c: Safety constraint → 'full' ──
  it('routes safety-constrained task to full', () => {
    const contract = makeContract(
      '修复 bash 沙箱的超时处理',
      ['src/tools/bash.ts'],
      ['不要破坏 security sandbox'],
    )
    const depth = classifyTaskDepth(contract)
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'full', 'safety constraint keyword must route to full')
  })

  // ── Rule 4: WIRING + single enforcement + safety keyword → 'full' ──
  it('routes wiring + single enforcement file + safety keyword to full', () => {
    // Use two files across different dirs to get wiring depth, one is enforcement
    const contract = makeContract(
      '增强 path-validate.ts 的安全校验逻辑并接入 TUI 面板',
      ['src/tools/path-validate.ts', 'src/tui/app.tsx'],
    )
    // "安全" keyword in objective + wiring depth + 1 enforcement file triggers Rule 4
    const depth = classifyTaskDepth(contract)
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'full',
      'wiring + single enforcement file + safety keyword → full')
  })

  // ── Rule 5: UNIT depth → 'lightweight' ──
  it('routes unit-depth enforcement-fix to lightweight', () => {
    const contract = makeContract(
      'fix canonicalize typo in path-grants.ts',
      ['src/tools/path-grants.ts'],
    )
    const depth = classifyTaskDepth(contract)
    assert.equal(depth, 'unit')
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'lightweight',
      'unit-depth fix even on enforcement file → lightweight')
  })

  it('routes unit-depth task without enforcement files to lightweight', () => {
    const contract = makeContract('fix typo in ui/app.tsx', ['src/tui/app.tsx'])
    const depth = classifyTaskDepth(contract)
    assert.equal(depth, 'unit')
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'lightweight')
  })

  // ── Wiring + no enforcement → 'lightweight' ──
  it('routes wiring multi-file pure refactor to lightweight', () => {
    const contract = makeContract(
      '重构 tool-group 为 collapsed-read-search，抽纯函数',
      ['src/tools/tool-group.ts', 'src/tui/search-panel.tsx'],
    )
    const depth = classifyTaskDepth(contract)
    assert.equal(depth, 'wiring')
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'lightweight',
      'wiring + 0 enforcement files → lightweight (pure refactor)')
  })

  // ── Default: no signal → 'lightweight' ──
  it('defaults to lightweight when no strong signal', () => {
    const contract = makeContract('优化代码')
    const depth = classifyTaskDepth(contract)
    assert.equal(depth, 'unit')
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'lightweight', 'no signal → default lightweight')
  })

  // ── Override mechanism ──
  it('respects override=full even for unit-depth task', () => {
    const contract = makeContract('fix typo in readme', ['docs/readme.md'])
    const depth = classifyTaskDepth(contract)
    assert.equal(depth, 'unit')
    const methodology = classifyPlanMethodology(contract, depth, undefined, 'full')
    assert.equal(methodology, 'full', 'override=full must skip all rules')
  })

  it('respects override=lightweight even with 2 enforcement files', () => {
    const contract = makeContract(
      '同步双门',
      ['src/tools/path-validate.ts', 'src/tools/sandbox-profile.ts'],
    )
    const depth = classifyTaskDepth(contract)
    const methodology = classifyPlanMethodology(contract, depth, undefined, 'lightweight')
    assert.equal(methodology, 'lightweight', 'override=lightweight must skip all rules')
  })

  it('override being same as natural result is no-op', () => {
    const contract = makeContract('fix typo', ['src/tui/app.tsx'])
    const depth = classifyTaskDepth(contract)
    const natural = classifyPlanMethodology(contract, depth)
    const overridden = classifyPlanMethodology(contract, depth, undefined, natural)
    assert.equal(overridden, natural, 'same-value override should return same result')
  })

  // ── Pure function: idempotent ──
  it('is a pure function — same inputs, same output', () => {
    const contract = makeContract(
      '接通双门授权检查',
      ['src/tools/path-validate.ts', 'src/tools/sandbox-profile.ts'],
    )
    const depth = classifyTaskDepth(contract)
    const r1 = classifyPlanMethodology(contract, depth)
    const r2 = classifyPlanMethodology(contract, depth)
    const r3 = classifyPlanMethodology(contract, depth)
    assert.equal(r1, r2)
    assert.equal(r2, r3)
    assert.equal(r1, 'full')
  })

  // ── Edge: wiring + single enforcement file WITHOUT safety keyword → lightweight ──
  it('routes wiring + single enforcement file without safety keyword to lightweight', () => {
    const contract = makeContract(
      '重构 path-validate.ts 的日志输出格式',
      ['src/tools/path-validate.ts'],
    )
    const depth = classifyTaskDepth(contract)
    // "重构" + 1 file → wiring (detected as refactor kind)
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'lightweight',
      'wiring + single enforcement file + no safety keyword → lightweight')
  })

  // ── Edge: wiring + non-enforcement multi-file → lightweight ──
  it('routes wiring + multi non-enforcement files to lightweight', () => {
    const contract = makeContract(
      '重构 TUI 面板布局',
      ['src/tui/app.tsx', 'src/tui/input.tsx', 'src/tui/search-panel.tsx'],
    )
    const depth = classifyTaskDepth(contract)
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'lightweight',
      'multi-file non-enforcement refactor → lightweight')
  })

  // ── Edge: Chinese "双门" in objective triggers Rule 2a ──
  it('routes Chinese 双门 keyword to full', () => {
    const contract = makeContract('实现双门同步')
    const depth = classifyTaskDepth(contract)
    // "实现" without files → unit depth, but Rule 2a verb pattern triggers first
    const methodology = classifyPlanMethodology(contract, depth)
    assert.equal(methodology, 'full', '双门 keyword must trigger full via Rule 2a')
  })
})
