import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OBJECTIVE_REVIEW_STANCE, PATH_BOUNDARY_REVIEW_STANCE, REVIEW_DISCIPLINES, METHODOLOGY_VERIFICATION_STANCE, GENERAL_DEV_DISCIPLINES, classifyChangeScale, formatObjectiveReviewStance, formatPathBoundaryReviewStance, formatMethodologyVerificationStance, formatGeneralDevDisciplines, isCrossModule, isFixContext, shouldRouteReviewWorkflow } from '../review-discipline.js'

describe('review disciplines', () => {
  it('contains all four review disciplines', () => {
    assert.equal(REVIEW_DISCIPLINES.length, 4)
    const joined = REVIEW_DISCIPLINES.join('\n')
    assert.match(joined, /自我审批/)
    assert.match(joined, /adversarial_verifier/)
    assert.match(joined, /既有测试/)
    assert.match(joined, /fail-closed/)
  })

  it('captures the objective external-review stance as reusable workflow text', () => {
    assert.equal(OBJECTIVE_REVIEW_STANCE.length, 5)
    const text = formatObjectiveReviewStance()
    assert.match(text, /外部审查者/)
    assert.match(text, /亲自观察的证据/)
    assert.match(text, /主动构造反例/)
    assert.match(text, /定义.*真实边界/)
    // 代理真值漂移（point ①）
    assert.match(text, /代理真值漂移/)
    assert.match(text, /弱代理为真.*强谓词为假/)
  })

  it('captures the general dev methodology (L1 nudge) — cumulative-channel value lifecycle', () => {
    assert.equal(GENERAL_DEV_DISCIPLINES.length, 1)
    const text = formatGeneralDevDisciplines()
    assert.match(text, /累积通道只接幂等的状态派生值/)
    assert.match(text, /未显式更新就沿用上一次值/)
    assert.match(text, /tombstone/)
    // 通用化：不绑定本项目实现（无 appendixDelta 等内部术语）
    assert.doesNotMatch(text, /appendixDelta|cognitiveProjection|瑶光/)
  })

  it('captures path-boundary review stance so T7/MeridianIndexer regressions do not depend on memory recall', () => {
    assert.equal(PATH_BOUNDARY_REVIEW_STANCE.length, 4)
    const text = formatPathBoundaryReviewStance()
    assert.match(text, /repo-relative.*absolute inside cwd.*absolute outside cwd.*\.\.\/ traversal/)
    assert.match(text, /producer.*normalizer.*classifier.*consumer.*DB key.*assertion/)
    assert.match(text, /显式目标.*默认发现/)
    assert.match(text, /fail-closed.*fail-toward-content/)
  })

  it('detects fix contexts from English and Chinese signals', () => {
    assert.equal(isFixContext('fix(server): H4 回归修复'), true)
    assert.equal(isFixContext('修复 dedup TOCTOU'), true)
    assert.equal(isFixContext('regression patch for scheduler'), true)
    assert.equal(isFixContext('feat: add new route'), false)
    assert.equal(isFixContext('docs: update handoff'), false)
  })

  it('routes large (≥5 files), cross-module, or security-boundary changes to L3', () => {
    assert.equal(classifyChangeScale({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false }), 'L3')
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: true, isFix: false }), 'L3')
    assert.equal(classifyChangeScale({ files: ['src/agent/approval-risk.ts'], crossModule: false, isFix: true }), 'L3')
  })

  it('routes single-file non-cross-module code changes to L1 (nudge only, default safe)', () => {
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: false, isFix: true }), 'L1')
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: false, isFix: false }), 'L1')
  })

  it('overrides to L2 or L3 when forceLevel is set (manual review trigger)', () => {
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: false, isFix: false, forceLevel: 'L2' }), 'L2')
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: false, isFix: false, forceLevel: 'L3' }), 'L3')
    // forceLevel takes precedence over structural classification
    assert.equal(classifyChangeScale({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'], crossModule: false, isFix: false, forceLevel: 'L2' }), 'L2')
  })

  it('routes trivial documentation or test-only files to L1 (isFix does NOT force L2)', () => {
    assert.equal(classifyChangeScale({ files: ['README.md'], crossModule: false, isFix: false }), 'L1')
    assert.equal(classifyChangeScale({ files: ['docs/notes.txt', 'docs/example.json'], crossModule: false, isFix: false }), 'L1')
    assert.equal(classifyChangeScale({ files: ['README.md'], crossModule: false, isFix: true }), 'L1')
    assert.equal(classifyChangeScale({ files: ['src/agent/__tests__/loop.test.ts'], crossModule: false, isFix: true }), 'L1')
  })

  it('routes any non-empty delivery through review workflow while leaving L1 advisory', () => {
    assert.equal(shouldRouteReviewWorkflow({ files: ['README.md'], crossModule: false, isFix: false }), true)
    assert.equal(shouldRouteReviewWorkflow({ files: [], crossModule: false, isFix: false }), false)
  })

  it('routes dependency and compiler config changes to L2 even when they are json or lock files', () => {
    assert.equal(classifyChangeScale({ files: ['package.json'], crossModule: false, isFix: false }), 'L2')
    assert.equal(classifyChangeScale({ files: ['package-lock.json'], crossModule: false, isFix: false }), 'L2')
    assert.equal(classifyChangeScale({ files: ['packages/app/tsconfig.build.json'], crossModule: false, isFix: false }), 'L2')
    assert.equal(classifyChangeScale({ files: ['yarn.lock'], crossModule: false, isFix: false }), 'L2')
  })

  it('detects cross-module changes by src top-level module span', () => {
    assert.equal(isCrossModule(['src/agent/a.ts', 'src/tools/b.ts']), true)
    assert.equal(isCrossModule(['src/agent/a.ts', 'src/agent/b.ts']), false)
    assert.equal(isCrossModule(['README.md', 'docs/notes.md']), false)
  })

  it('captures methodology verification stance from PlanDesignIntentRouter adversarial review lesson', () => {
    assert.equal(METHODOLOGY_VERIFICATION_STANCE.length, 3)
    const text = formatMethodologyVerificationStance()
    assert.match(text, /可执行指令.*grep.*regex.*shell.*命令/)
    assert.match(text, /在真实代码库中跑一遍/)
    assert.match(text, /caller.*callee.*并行执行点/)
    assert.match(text, /沿着操作往下数门/)
    assert.match(text, /递归.*验证.*自己/)
  })
})
