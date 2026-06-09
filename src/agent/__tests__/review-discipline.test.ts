import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OBJECTIVE_REVIEW_STANCE, PATH_BOUNDARY_REVIEW_STANCE, REVIEW_DISCIPLINES, classifyChangeScale, formatObjectiveReviewStance, formatPathBoundaryReviewStance, isCrossModule, isFixContext, shouldRouteReviewWorkflow } from '../review-discipline.js'

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
    assert.equal(OBJECTIVE_REVIEW_STANCE.length, 4)
    const text = formatObjectiveReviewStance()
    assert.match(text, /外部审查者/)
    assert.match(text, /亲自观察的证据/)
    assert.match(text, /主动构造反例/)
    assert.match(text, /定义.*真实边界/)
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

  it('routes large or cross-module changes to L3', () => {
    assert.equal(classifyChangeScale({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], crossModule: false, isFix: false }), 'L3')
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: true, isFix: false }), 'L3')
  })

  it('routes fix or code changes to L2', () => {
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: false, isFix: true }), 'L2')
    assert.equal(classifyChangeScale({ files: ['src/a.ts'], crossModule: false, isFix: false }), 'L2')
  })

  it('routes trivial non-fix documentation changes to L1', () => {
    assert.equal(classifyChangeScale({ files: ['README.md'], crossModule: false, isFix: false }), 'L1')
    assert.equal(classifyChangeScale({ files: ['docs/notes.txt', 'docs/example.json'], crossModule: false, isFix: false }), 'L1')
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
})
