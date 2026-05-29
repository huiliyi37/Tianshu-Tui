import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceContractStatus,
  contractStatusFromPhaseClass,
  extractTaskContract,
  renderContractProjection,
  isActionableTurn,
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
