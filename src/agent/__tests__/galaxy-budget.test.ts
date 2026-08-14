import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyGalaxyDimension,
  mapGalaxyDimensionToProfile,
  mapGalaxyDimensionToKind,
  mapGalaxyDimensionToTaskShape,
  isReviewGalaxyDimension,
  buildGalaxyBudgetInputs,
} from '../galaxy-budget.js'

/** 写能力判定与 galaxy.ts 的 profileIsWriteCapable 同源语义：只有 patcher 家族可写。 */
const WRITE_PROFILES = new Set(['patcher'])
const WRITE_KINDS = new Set(['patch_proposal'])

describe('classifyGalaxyDimension', () => {
  it('英文精确名保持既有分类（回归）', () => {
    assert.equal(classifyGalaxyDimension('review'), 'review')
    assert.equal(classifyGalaxyDimension('verify'), 'verify')
    assert.equal(classifyGalaxyDimension('test'), 'verify')
    assert.equal(classifyGalaxyDimension('plan'), 'plan')
    assert.equal(classifyGalaxyDimension('design'), 'plan')
    assert.equal(classifyGalaxyDimension('docs'), 'docs')
    assert.equal(classifyGalaxyDimension('research'), 'docs')
    assert.equal(classifyGalaxyDimension('search'), 'search')
    assert.equal(classifyGalaxyDimension('scout'), 'search')
    assert.equal(classifyGalaxyDimension('frontend'), 'impl')
    assert.equal(classifyGalaxyDimension('backend'), 'impl')
    assert.equal(classifyGalaxyDimension('impl'), 'impl')
    assert.equal(classifyGalaxyDimension('patch'), 'impl')
    assert.equal(classifyGalaxyDimension('fix'), 'impl')
  })

  it('大小写与空白/连字符归一（回归）', () => {
    assert.equal(classifyGalaxyDimension('Review'), 'review')
    assert.equal(classifyGalaxyDimension('  review  '), 'review')
    assert.equal(classifyGalaxyDimension('code-search'), 'search')
    assert.equal(classifyGalaxyDimension('doc_research'), 'docs')
  })

  it('英文复合名按词根命中，不再落兜底', () => {
    // 旧实现做精确匹配：'Frontend UI' → 'frontendui' → 查表失败 → 兜底。
    assert.equal(classifyGalaxyDimension('Frontend UI'), 'impl')
    assert.equal(classifyGalaxyDimension('Code Review'), 'review')
    assert.equal(classifyGalaxyDimension('backend refactor'), 'impl')
    assert.equal(classifyGalaxyDimension('regression test'), 'verify')
  })

  it('中文维度名命中对应语义（本仓维度名以中文为主）', () => {
    assert.equal(classifyGalaxyDimension('实现·登录流程'), 'impl')
    assert.equal(classifyGalaxyDimension('前端 UI'), 'impl')
    assert.equal(classifyGalaxyDimension('后端改造'), 'impl')
    assert.equal(classifyGalaxyDimension('修复空指针'), 'impl')
    assert.equal(classifyGalaxyDimension('验证与回归'), 'verify')
    assert.equal(classifyGalaxyDimension('回归测试'), 'verify')
    assert.equal(classifyGalaxyDimension('审查改动'), 'review')
    assert.equal(classifyGalaxyDimension('方案设计'), 'plan')
    assert.equal(classifyGalaxyDimension('文档整理'), 'docs')
    assert.equal(classifyGalaxyDimension('调研可选方案'), 'docs')
    assert.equal(classifyGalaxyDimension('检索相关代码'), 'search')
  })

  it('只读语义优先于写语义——误判方向收缩权限而非扩大', () => {
    assert.equal(classifyGalaxyDimension('审查实现质量'), 'review')
    assert.equal(classifyGalaxyDimension('验证前端修复'), 'verify')
  })

  it('research 不被 search 抢先命中', () => {
    assert.equal(classifyGalaxyDimension('research'), 'docs')
    assert.equal(classifyGalaxyDimension('调研'), 'docs')
  })

  it('完全无法归类时兜底为 impl（与 profile 的 patcher 兜底同向）', () => {
    assert.equal(classifyGalaxyDimension('perspectives'), 'impl')
    assert.equal(classifyGalaxyDimension('阶段一'), 'impl')
    assert.equal(classifyGalaxyDimension(''), 'impl')
  })
})

describe('维度语义单一事实源', () => {
  const SAMPLES = [
    'review', 'verify', 'test', 'plan', 'design', 'docs', 'research', 'search', 'scout',
    'frontend', 'backend', 'impl', 'patch', 'fix', 'Frontend UI', 'Code Review',
    '实现·登录流程', '前端 UI', '验证与回归', '审查改动', '方案设计', '文档整理', '检索相关代码',
    'perspectives', '阶段一', '',
  ]

  it('profile 的写能力与 kind 的写类别恒等——这是塌缩 bug 的回归闸', () => {
    for (const name of SAMPLES) {
      const profileWritable = WRITE_PROFILES.has(mapGalaxyDimensionToProfile(name))
      const kindWritable = WRITE_KINDS.has(mapGalaxyDimensionToKind(name))
      assert.equal(
        profileWritable,
        kindWritable,
        `维度「${name}」的 profile(${mapGalaxyDimensionToProfile(name)}) 与 kind(${mapGalaxyDimensionToKind(name)}) 写能力不一致`,
      )
    }
  })

  it('profile / kind / taskShape 三者全部由 classify 派生，无独立映射表', () => {
    for (const name of SAMPLES) {
      const semantic = classifyGalaxyDimension(name)
      const expectedProfile = {
        review: 'reviewer', verify: 'verify_scout', plan: 'planner',
        docs: 'doc_scout', search: 'code_scout', impl: 'patcher',
      }[semantic]
      const expectedKind = {
        review: 'review', verify: 'verify', plan: 'plan',
        docs: 'doc_research', search: 'code_search', impl: 'patch_proposal',
      }[semantic]
      const expectedShape = {
        review: 'review', verify: 'review', plan: 'plan',
        docs: 'docs', search: 'explore', impl: 'impl',
      }[semantic]
      assert.equal(mapGalaxyDimensionToProfile(name), expectedProfile, `profile mismatch: ${name}`)
      assert.equal(mapGalaxyDimensionToKind(name), expectedKind, `kind mismatch: ${name}`)
      assert.equal(mapGalaxyDimensionToTaskShape(name), expectedShape, `taskShape mismatch: ${name}`)
    }
  })

  it('taskShape 仍是既有 5 值枚举（账本向后兼容）', () => {
    const shapes = new Set(SAMPLES.map(mapGalaxyDimensionToTaskShape))
    for (const shape of shapes) {
      assert.ok(['impl', 'review', 'explore', 'plan', 'docs'].includes(shape), `未知 taskShape: ${shape}`)
    }
  })

  it('实现类维度不再塌进 explore 桶', () => {
    assert.equal(mapGalaxyDimensionToTaskShape('实现·登录流程'), 'impl')
    assert.equal(mapGalaxyDimensionToTaskShape('前端 UI'), 'impl')
    assert.notEqual(mapGalaxyDimensionToTaskShape('验证与回归'), 'explore')
  })
})

describe('isReviewGalaxyDimension', () => {
  it('英文回归', () => {
    assert.equal(isReviewGalaxyDimension('review'), true)
    assert.equal(isReviewGalaxyDimension('verify'), true)
    assert.equal(isReviewGalaxyDimension('frontend'), false)
  })

  it('中文审查/验证维度同样识别', () => {
    assert.equal(isReviewGalaxyDimension('审查改动'), true)
    assert.equal(isReviewGalaxyDimension('验证与回归'), true)
    assert.equal(isReviewGalaxyDimension('实现·登录流程'), false)
  })
})

describe('buildGalaxyBudgetInputs 不受语义归一改动影响（回归）', () => {
  it('显式 profile 优先于维度名推导', () => {
    const out = buildGalaxyBudgetInputs([
      { name: '实现·登录流程', authority: 'wenqu', profile: 'code_scout' },
    ])
    assert.deepEqual(out.profiles, ['code_scout'])
  })

  it('省略 profile 时按维度名推导（中文实现维度落 patcher）', () => {
    const out = buildGalaxyBudgetInputs([
      { name: '实现·登录流程', authority: 'wenqu' },
    ])
    assert.deepEqual(out.profiles, ['patcher'])
  })

  it('DP 副本按 authorities × replicas 展开', () => {
    const out = buildGalaxyBudgetInputs([
      { name: '验证与回归', authority: 'yaoguang', parallelism: 'data', replicas: 3 },
    ])
    assert.equal(out.profiles.length, 3)
    assert.deepEqual(out.profiles, ['verify_scout', 'verify_scout', 'verify_scout'])
  })
})
