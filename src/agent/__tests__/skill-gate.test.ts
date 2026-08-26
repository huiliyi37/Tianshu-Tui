import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearSkillGate,
  evaluateSkillGate,
  extractRequiredSkills,
  formatSkillGateBlock,
  getInvokedSkills,
  isSkillGateEnabled,
  recordSkillInvoked,
} from '../skill-gate.js'
import { executePlan, type PlanExecutorDeps } from '../plan-executor.js'
import { skillRegistry } from '../../skills/skill-loader.js'
import { buildPlanKickoff } from '../../plan/plan-approval.js'

// ── extractRequiredSkills ────────────────────────────────────────────

describe('extractRequiredSkills', () => {
  it('识别显式 skill(name=…) 调用形状（带/不带引号）', () => {
    assert.deepEqual(extractRequiredSkills('先 skill(name="executing-plans") 加载'), ['executing-plans'])
    assert.deepEqual(extractRequiredSkills("skill(name='writing-plans')"), ['writing-plans'])
    assert.deepEqual(extractRequiredSkills('skill(name=brainstorming)'), ['brainstorming'])
  })

  it('识别中文指令式提及（连字符命名）', () => {
    assert.deepEqual(extractRequiredSkills('使用 executing-plans 逐任务实现'), ['executing-plans'])
    assert.deepEqual(extractRequiredSkills('遵循 `test-driven-development` 的流程'), ['test-driven-development'])
    assert.deepEqual(extractRequiredSkills('加载「systematic-debugging」后再排查'), ['systematic-debugging'])
  })

  it('识别反引号名 + skill/技能 后缀', () => {
    assert.deepEqual(extractRequiredSkills('`executing-plans` skill 要求逐任务验证'), ['executing-plans'])
    assert.deepEqual(extractRequiredSkills('「writing-plans」技能 已覆盖此流程'), ['writing-plans'])
  })

  it('指令式提及要求连字符——普通词汇不误中', () => {
    assert.deepEqual(extractRequiredSkills('use grep to search, 使用 rg 检索, load config'), [])
    // 工具名走下划线，不会误中
    assert.deepEqual(extractRequiredSkills('使用 plan_task 执行计划'), [])
  })

  it('大小写不敏感去重', () => {
    const out = extractRequiredSkills('使用 Executing-Plans;后文 skill(name="executing-plans") 再次点名')
    assert.equal(out.length, 1)
    assert.equal(out[0]!.toLowerCase(), 'executing-plans')
  })

  it('空文本/无引用 → 空数组', () => {
    assert.deepEqual(extractRequiredSkills(''), [])
    assert.deepEqual(extractRequiredSkills('# 计划\n改 src/foo.ts 三处调用点'), [])
  })
})

// ── 会话级记录 store ─────────────────────────────────────────────────

describe('skill-gate 会话记录', () => {
  afterEach(() => {
    clearSkillGate('sg-test-a')
    clearSkillGate('sg-test-b')
    clearSkillGate()
  })

  it('按 sessionId 隔离记录', () => {
    recordSkillInvoked('executing-plans', 'sg-test-a')
    assert.ok(getInvokedSkills('sg-test-a').has('executing-plans'))
    assert.ok(!getInvokedSkills('sg-test-b').has('executing-plans'))
  })

  it('记录小写归一', () => {
    recordSkillInvoked('Executing-Plans', 'sg-test-a')
    assert.ok(getInvokedSkills('sg-test-a').has('executing-plans'))
  })

  it('clear 后查询为空', () => {
    recordSkillInvoked('x-y', 'sg-test-a')
    clearSkillGate('sg-test-a')
    assert.equal(getInvokedSkills('sg-test-a').size, 0)
  })

  it('无 sessionId 走默认键', () => {
    recordSkillInvoked('a-b')
    assert.ok(getInvokedSkills().has('a-b'))
  })
})

// ── evaluateSkillGate ────────────────────────────────────────────────

describe('evaluateSkillGate', () => {
  it('可加载未加载 → missing；运行时没有 → unavailable；已加载 → 都不进', () => {
    const verdict = evaluateSkillGate(
      ['subagent-driven-development', 'alien-skill', 'brainstorming'],
      {
        availableNames: new Set(['subagent-driven-development', 'brainstorming']),
        invokedNames: new Set(['brainstorming']),
      },
    )
    assert.deepEqual(verdict.missing, ['subagent-driven-development'])
    assert.deepEqual(verdict.unavailable, ['alien-skill'])
    assert.deepEqual(verdict.native, [])
  })

  it('退役名（executing-plans / writing-plans）→ native 桶，不拦', () => {
    const verdict = evaluateSkillGate(
      ['executing-plans', 'writing-plans'],
      {
        availableNames: new Set(),
        invokedNames: new Set(),
      },
    )
    assert.deepEqual(verdict.native, ['executing-plans', 'writing-plans'])
    assert.deepEqual(verdict.missing, [])
    assert.deepEqual(verdict.unavailable, [])
  })

  it('名称比较大小写不敏感（含退役名映射）', () => {
    const verdict = evaluateSkillGate(['Executing-Plans'], {
      availableNames: new Set(['executing-plans']),
      invokedNames: new Set(['EXECUTING-PLANS']),
    })
    assert.deepEqual(verdict.missing, [])
    assert.deepEqual(verdict.unavailable, [])
    assert.deepEqual(verdict.native, ['Executing-Plans'])
  })
})

// ── executePlan 入口硬拦 ─────────────────────────────────────────────

describe('executePlan 技能门禁', () => {
  const SKILL_NAME = 'sg-test-only-executing-plans'
  const SESSION = 'sg-exec-test'

  /** 门禁应在触碰任何 deps 前抛错——deps 被调用即测试失败。 */
  const untouchableDeps: PlanExecutorDeps = {
    delegateBatch: () => {
      throw new Error('delegateBatch must not be reached when the skill gate blocks')
    },
  }

  afterEach(() => {
    clearSkillGate(SESSION)
    delete process.env.RIVET_SKILL_GATE
  })

  it('计划点名可加载但未加载的 skill → 硬拦，deps 不被触碰', async () => {
    skillRegistry.register({ name: SKILL_NAME, description: 't', triggers: [], body: 'x' })
    await assert.rejects(
      executePlan(
        {
          mode: 'standard',
          objective: 'test objective',
          planMarkdown: `# 计划\n使用 ${SKILL_NAME} 逐任务实现`,
          fromWave: 0,
          reviewDepth: 0,
          cwd: process.cwd(),
          reviewGate: false,
          sessionId: SESSION,
        },
        untouchableDeps,
      ),
      (err: Error) => {
        assert.match(err.message, /技能门禁/)
        assert.match(err.message, new RegExp(SKILL_NAME))
        assert.match(err.message, /RIVET_SKILL_GATE=0/)
        return true
      },
    )
  })

  /** 放行类断言：executePlan 可能在下游任意点成功或失败，唯一要求是
   *  错误（若有）不是技能门禁拦截。 */
  async function assertGatePassed(planMarkdown: string, fromWave = 0): Promise<void> {
    try {
      await executePlan(
        {
          mode: 'standard',
          objective: 'test objective',
          planMarkdown,
          fromWave,
          reviewDepth: 0,
          cwd: process.cwd(),
          reviewGate: false,
          sessionId: SESSION,
        },
        untouchableDeps,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      assert.ok(!/技能门禁/.test(msg), `expected the skill gate to pass, got: ${msg}`)
    }
  }

  it('skill 已加载 → 门禁放行', async () => {
    skillRegistry.register({ name: SKILL_NAME, description: 't', triggers: [], body: 'x' })
    recordSkillInvoked(SKILL_NAME, SESSION)
    await assertGatePassed(`# 计划\n使用 ${SKILL_NAME} 逐任务实现\n## 任务\n- 改一个文件`)
  })

  it('点名了运行时不存在的 skill → 不拦', async () => {
    await assertGatePassed('# 计划\n使用 totally-alien-skill 实现')
  })

  it('RIVET_SKILL_GATE=0 整体禁用', async () => {
    process.env.RIVET_SKILL_GATE = '0'
    assert.equal(isSkillGateEnabled(), false)
    skillRegistry.register({ name: SKILL_NAME, description: 't', triggers: [], body: 'x' })
    await assertGatePassed(`# 计划\n使用 ${SKILL_NAME} 实现`)
  })

  it('续波（fromWave>0）不再查门禁', async () => {
    skillRegistry.register({ name: SKILL_NAME, description: 't', triggers: [], body: 'x' })
    await assertGatePassed(`# 计划\n使用 ${SKILL_NAME} 实现`, 1)
  })
})

// ── kickoff 契约指令 ─────────────────────────────────────────────────

describe('buildPlanKickoff 技能契约注入', () => {
  it('有点名 skill → 注入契约指令段', () => {
    const msg = buildPlanKickoff('slug', 'Title', undefined, undefined, ['executing-plans'])
    assert.match(msg, /本计划点名了流程 skill：executing-plans/)
    // 减负改版（2026-07-25）：skill 正文瘦身为纯增量后警告缩短，
    // 核心语义是「计划专属契约 + 先加载 + 硬拦兜底」。
    assert.match(msg, /计划专属契约/)
    assert.match(msg, /技能门禁硬拦/)
  })

  it('无点名 skill → 不注入', () => {
    const msg = buildPlanKickoff('slug', 'Title')
    assert.ok(!msg.includes('点名了流程 skill'))
  })
})

// ── formatSkillGateBlock ─────────────────────────────────────────────

describe('formatSkillGateBlock', () => {
  it('包含逐个加载指令与逃生阀', () => {
    const msg = formatSkillGateBlock(['a-b', 'c-d'])
    assert.match(msg, /skill\(name="a-b"\)/)
    assert.match(msg, /skill\(name="c-d"\)/)
    assert.match(msg, /RIVET_SKILL_GATE=0/)
  })
})
