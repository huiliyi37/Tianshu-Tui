import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ZenPhaseController,
  ZenConfigError,
  DEFAULT_ZEN_FACE,
  DEFAULT_ZEN_STRUCTURED_READ_FACE,
  foldFromMeta,
  foldZenFromMeta,
  isZenBudgetExhausted,
  isZenFaceTool,
  resolveZenConfig,
  shouldTriagePromote,
  zenUnregisteredHint,
  type ResolvedZenConfig,
  type ZenPhaseControllerOpts,
} from '../zen-mode.js'

describe('resolveZenConfig — 默认物化与 fail-loud 校验', () => {
  it('undefined / null → 默认开启（读面四件套 + 8 turn 预算 + 短消息分诊 + appendix 收敛）', () => {
    for (const raw of [undefined, null]) {
      const cfg = resolveZenConfig(raw)
      assert.equal(cfg.enabled, true)
      assert.deepEqual(cfg.face, DEFAULT_ZEN_FACE)
      assert.equal(cfg.timeoutSteps, 8)
      assert.deepEqual(cfg.triage, { enabled: true, maxChars: 80 })
      assert.equal(cfg.appendixLean, true)
    }
  })

  it('合法配置：显式值保留', () => {
    const cfg = resolveZenConfig({
      enabled: false,
      face: ['read_file'],
      timeoutSteps: 2,
      triage: { enabled: false, maxChars: 10 },
      appendixLean: false,
    })
    assert.equal(cfg.enabled, false)
    assert.deepEqual(cfg.face, ['read_file'])
    assert.equal(cfg.timeoutSteps, 2)
    assert.deepEqual(cfg.triage, { enabled: false, maxChars: 10 })
    assert.equal(cfg.appendixLean, false)
  })

  it('faceMode=structuredRead → minimal + 结构化只读工具；缺省仍 minimal', () => {
    const structured = resolveZenConfig({ faceMode: 'structuredRead' })
    assert.equal(structured.faceMode, 'structuredRead')
    assert.deepEqual(structured.face, [...DEFAULT_ZEN_FACE, ...DEFAULT_ZEN_STRUCTURED_READ_FACE])

    const minimal = resolveZenConfig({})
    assert.equal(minimal.faceMode, 'minimal')
    assert.deepEqual(minimal.face, DEFAULT_ZEN_FACE)
  })

  it('显式 face 优先于 faceMode', () => {
    const cfg = resolveZenConfig({ faceMode: 'structuredRead', face: ['grep'] })
    assert.deepEqual(cfg.face, ['grep'])
    assert.equal(cfg.faceMode, 'structuredRead')
  })

  it('部分配置：缺省字段物化默认', () => {
    const cfg = resolveZenConfig({ face: ['grep'] })
    assert.equal(cfg.enabled, true)
    assert.deepEqual(cfg.face, ['grep'])
    assert.equal(cfg.timeoutSteps, 8)
    assert.deepEqual(cfg.triage, { enabled: true, maxChars: 80 })
    assert.equal(cfg.appendixLean, true)
  })

  it('timeoutSteps: 0 = 禁用超时晋升（合法）', () => {
    const cfg = resolveZenConfig({ timeoutSteps: 0 })
    assert.equal(cfg.timeoutSteps, 0)
  })

  // ── 反例表（全部抛 ZenConfigError）──────────────────
  const invalidCases: Array<[string, unknown]> = [
    ['非对象（字符串）', 'zen'],
    ['非对象（数组）', ['read_file']],
    ['未知键', { foo: 1 }],
    ['enabled 非布尔（字符串）', { enabled: 'yes' }],
    ['enabled 非布尔（数字）', { enabled: 1 }],
    ['face 非数组', { face: 'read_file' }],
    ['face 空数组', { face: [] }],
    ['face 含非字符串', { face: ['read_file', 42] }],
    ['face 含空字符串', { face: ['read_file', ''] }],
    ['face 重复名', { face: ['read_file', 'read_file'] }],
    ['faceMode 非法值', { faceMode: 'max' }],
    ['timeoutSteps 负数', { timeoutSteps: -1 }],
    ['timeoutSteps 非整数', { timeoutSteps: 1.5 }],
    ['timeoutSteps 非数字', { timeoutSteps: '8' }],
    ['triage 非对象', { triage: 'yes' }],
    ['triage 未知键', { triage: { bogus: 1 } }],
    ['triage.enabled 非布尔', { triage: { enabled: 1 } }],
    ['triage.maxChars 非正整数（0）', { triage: { maxChars: 0 } }],
    ['triage.maxChars 非数字', { triage: { maxChars: '80' } }],
    ['appendixLean 非布尔', { appendixLean: 'yes' }],
  ]

  for (const [label, raw] of invalidCases) {
    it(`反例：${label}`, () => {
      assert.throws(() => resolveZenConfig(raw), ZenConfigError, label)
    })
  }
})

describe('isZenFaceTool — 面判定三态', () => {
  const face = ['read_file', 'grep']
  const registered = new Set(['read_file', 'grep', 'edit_file', 'bash'])

  it('面内：read_file / grep', () => {
    assert.equal(isZenFaceTool('read_file', face, registered), 'in-face')
    assert.equal(isZenFaceTool('grep', face, registered), 'in-face')
  })

  it('面外：edit_file / bash（已注册但不属于读面）', () => {
    assert.equal(isZenFaceTool('edit_file', face, registered), 'out-of-face')
    assert.equal(isZenFaceTool('bash', face, registered), 'out-of-face')
  })

  it('未注册：registry 没有的工具（幻觉调用，不构成晋升证据）', () => {
    assert.equal(isZenFaceTool('nonexistent_tool', face, registered), 'unregistered')
  })

  it('registered 缺省：凡不在 face 即面外（不区分未注册）', () => {
    assert.equal(isZenFaceTool('edit_file', face), 'out-of-face')
    assert.equal(isZenFaceTool('nonexistent_tool', face), 'out-of-face')
  })
})

describe('shouldTriagePromote — 首消息分诊纯判定', () => {
  it('单行且 ≤ maxChars → true（琐碎请求跳过禅）', () => {
    assert.equal(shouldTriagePromote('ok', 80), true)
    assert.equal(shouldTriagePromote('2+2=4', 80), true)
    assert.equal(shouldTriagePromote('你好', 80), true)
  })

  it('多行 → false（任务请求）', () => {
    assert.equal(shouldTriagePromote('读一下 src/main.ts\n然后总结', 80), false)
  })

  it('超长单行 → false（可能是任务）', () => {
    const long = 'x'.repeat(81)
    assert.equal(shouldTriagePromote(long, 80), false)
    // 中文 9 字符 + 72 = 81 > 80 → 不 triage
    assert.equal(shouldTriagePromote('刚好 80 字符的请求' + 'y'.repeat(72), 80), false)
  })
})

describe('isZenBudgetExhausted — 步数预算纯判定', () => {
  it('timeoutSteps > 0 且 zenTurns ≥ 预算 → true（边界相等触发）', () => {
    assert.equal(isZenBudgetExhausted(8, 8), true)
    assert.equal(isZenBudgetExhausted(9, 8), true)
  })

  it('未到预算 → false', () => {
    assert.equal(isZenBudgetExhausted(7, 8), false)
    assert.equal(isZenBudgetExhausted(0, 8), false)
  })

  it('timeoutSteps = 0 → 永不超时', () => {
    assert.equal(isZenBudgetExhausted(100, 0), false)
  })
})

function makeController(
  over: Partial<ResolvedZenConfig> = {},
  opts: Partial<ZenPhaseControllerOpts> = {},
): { c: ZenPhaseController; applied: string[][]; phases: Array<{ phase: string; reason?: string }> } {
  const applied: string[][] = []
  const phases: Array<{ phase: string; reason?: string }> = []
  const registered = ['read_file', 'grep', 'glob', 'repo_map', 'edit_file', 'bash']
  const c = new ZenPhaseController(
    resolveZenConfig(over),
    {
      isTopLevel: true,
      registeredNames: () => registered,
      applyFace: names => { applied.push([...names]) },
      onPhaseChange: (phase, reason) => { phases.push(reason === undefined ? { phase } : { phase, reason }) },
      ...opts,
    },
  )
  return { c, applied, phases }
}

describe('ZenPhaseController — 状态机', () => {
  it('初始相位 full——未 arm 即全量（worker/禁用天然放行）', () => {
    const { c } = makeController()
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.isZen, false)
  })

  it('arm → zen 相位，applyFace 应用读面（face ∩ 注册），onPhaseChange 通知', () => {
    const { c, applied, phases } = makeController({ face: ['read_file', 'grep'] })
    c.arm()
    assert.equal(c.currentPhase, 'zen')
    assert.equal(c.isZen, true)
    // applyFace 收到读面 ∩ 注册（注册含全部六件，face 只取前二）
    assert.deepEqual(applied.at(-1), ['read_file', 'grep'])
    assert.deepEqual(phases.at(-1), { phase: 'zen' })
  })

  it('arm(initialZenTurns) 恢复步数预算：未到预算保持 zen 且下次 tick 正常推进', () => {
    const { c } = makeController({ timeoutSteps: 8 })
    c.arm(7)
    assert.equal(c.isZen, true)
    assert.equal(c.snapshot().zenStats.zenTurns, 7)
    c.tick()
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.lastPromoteReason, 'timeout')
  })

  it('arm(initialZenTurns) 已到预算 → 立即 promote(timeout)，不重入读面（resume 不续期）', () => {
    const { c, applied, phases } = makeController({ timeoutSteps: 8 })
    c.arm(8)
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.lastPromoteReason, 'timeout')
    // 已到预算的 resume 直接落 full 面，不应先闪读面再翻全量。
    assert.ok(applied.at(-1)!.includes('edit_file'))
    assert.deepEqual(phases.at(-1), { phase: 'full', reason: 'timeout' })
    assert.equal(c.snapshot().zenStats.zenTurns, 8)
  })

  it('arm(initialZenTurns) 非法值 → 归零（脏 meta 不炸状态机）', () => {
    const { c } = makeController({ timeoutSteps: 8 })
    c.arm(-3)
    assert.equal(c.isZen, true)
    assert.equal(c.snapshot().zenStats.zenTurns, 0)
  })

  it('非顶层（worker/子代理）→ arm 无操作（恒 full 不 applyFace）', () => {
    const { c, applied } = makeController({}, { isTopLevel: false })
    c.arm()
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.isZen, false)
    assert.equal(applied.length, 0)
  })

  it('enabled:false → arm 后 isZen 仍 false、promote 恒 false（禁用恒放行）', () => {
    const { c } = makeController({ enabled: false })
    c.arm()
    assert.equal(c.isZen, false)
    assert.equal(c.promote('tool'), false)
    assert.equal(c.currentPhase, 'full')
  })

  it('promote → full 且记录原因；重复 promote 幂等返回 false', () => {
    const { c, phases } = makeController()
    c.arm()
    assert.equal(c.promote('triage'), true)
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.lastPromoteReason, 'triage')
    assert.equal(c.promote('timeout'), false)
    assert.equal(phases.at(-1)?.reason, 'triage')
  })

  it('promote 后 applyFace 恢复全量注册名', () => {
    const { c, applied } = makeController()
    c.arm()
    c.promote('tool')
    const names = applied.at(-1)
    assert.ok(names!.includes('edit_file'), `晋升后必须恢复全量（含 edit_file），实际 ${names?.join(', ')}`)
    assert.ok(names!.includes('bash'), `晋升后必须恢复全量（含 bash），实际 ${names?.join(', ')}`)
  })

  it('maybeTriage：zen + 单行短消息 + 无附件 → promote(triage)；多行/附件不晋升', () => {
    const { c } = makeController()
    c.arm()
    c.maybeTriage('ok', false)
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.lastPromoteReason, 'triage')
  })

  it('maybeTriage：多行消息不晋升（保持 zen）', () => {
    const { c } = makeController()
    c.arm()
    c.maybeTriage('读一下 src/main.ts\n然后总结', false)
    assert.equal(c.isZen, true)
  })

  it('maybeTriage：带附件不晋升（图片请求是任务）', () => {
    const { c } = makeController()
    c.arm()
    c.maybeTriage('ok', true)
    assert.equal(c.isZen, true)
  })

  it('maybeTriage：triage.enabled=false 时即使短消息也不晋升', () => {
    const { c } = makeController({ triage: { enabled: false, maxChars: 80 } })
    c.arm()
    c.maybeTriage('ok', false)
    assert.equal(c.isZen, true)
  })

  it('onToolRequest：面内工具恒放行不晋升', () => {
    const { c } = makeController({ face: ['read_file', 'grep'] })
    c.arm()
    assert.equal(c.onToolRequest('read_file'), true)
    assert.equal(c.isZen, true)
  })

  it('onToolRequest：面外工具 → 晋升 full 且返回 true（放行语义）', () => {
    const { c } = makeController({ face: ['read_file', 'grep'] })
    c.arm()
    assert.equal(c.onToolRequest('edit_file'), true)
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.lastPromoteReason, 'tool')
  })

  it('onToolRequest：未注册工具（幻觉调用）不晋升但放行', () => {
    const { c } = makeController({ face: ['read_file', 'grep'] })
    c.arm()
    assert.equal(c.onToolRequest('nonexistent_tool'), true)
    assert.equal(c.isZen, true)
  })

  it('tick：zenTurns 累计，达到预算 → promote(timeout)', () => {
    const { c } = makeController({ timeoutSteps: 2 })
    c.arm()
    c.tick()
    assert.equal(c.isZen, true)
    c.tick()
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.lastPromoteReason, 'timeout')
  })

  it('tick：timeoutSteps=0 → 永不超时', () => {
    const { c } = makeController({ timeoutSteps: 0 })
    c.arm()
    for (let i = 0; i < 20; i++) c.tick()
    assert.equal(c.isZen, true)
  })

  it('fast：/fast 用户跳过 → promote(user)', () => {
    const { c } = makeController()
    c.arm()
    c.fast()
    assert.equal(c.currentPhase, 'full')
    assert.equal(c.lastPromoteReason, 'user')
  })

  it('currentFace：zen → face ∩ 注册；full → 全注册', () => {
    const { c } = makeController({ face: ['read_file', 'missing_tool', 'grep'] })
    c.arm()
    assert.deepEqual([...c.currentFace()], ['read_file', 'grep'])  // missing_tool 未注册被剔除
    c.promote('tool')
    assert.ok(c.currentFace().includes('edit_file'))
    assert.ok(c.currentFace().includes('bash'))
  })

  it('snapshot：相位 + 原因 + zenStats 完整', () => {
    const { c } = makeController({ timeoutSteps: 2 })
    c.arm()
    c.tick()
    const snap = c.snapshot()
    assert.deepEqual(snap, {
      zenPhase: 'zen',
      zenPromoteReason: undefined,
      zenStats: { armed: true, promoteReason: undefined, zenTurns: 1 },
    })
    c.tick()
    const snap2 = c.snapshot()
    assert.deepEqual(snap2.zenPhase, 'full')
    assert.equal(snap2.zenPromoteReason, 'timeout')
    assert.deepEqual(snap2.zenStats, { armed: true, promoteReason: 'timeout', zenTurns: 2 })
  })

  it('重复 arm 幂等：不重复 applyFace/onPhaseChange', () => {
    const { c, applied, phases } = makeController()
    c.arm()
    c.arm()
    assert.equal(applied.length, 1)
    assert.equal(phases.length, 1)
  })
})

describe('foldFromMeta — resume 相位恢复', () => {
  it('meta 记录 zen → zen', () => {
    assert.equal(foldFromMeta({ zenPhase: 'zen' }), 'zen')
  })

  it('meta 记录 full → full', () => {
    assert.equal(foldFromMeta({ zenPhase: 'full' }), 'full')
  })

  it('meta 无 zenPhase 记录 → undefined', () => {
    assert.equal(foldFromMeta({ model: 'deepseek-v4-pro', cwd: '/x' }), undefined)
    assert.equal(foldFromMeta(undefined), undefined)
    assert.equal(foldFromMeta(null), undefined)
  })

  it('zenPhase 值非法 → undefined（不信任脏数据）', () => {
    assert.equal(foldFromMeta({ zenPhase: 'warp' }), undefined)
    assert.equal(foldFromMeta({ zenPhase: 42 }), undefined)
  })
})

describe('foldZenFromMeta — resume 相位 + 步数预算恢复', () => {
  it('zen + zenStats.zenTurns=7 → 恢复 7 轮预算', () => {
    assert.deepEqual(
      foldZenFromMeta({ zenPhase: 'zen', zenStats: { armed: true, zenTurns: 7 } }),
      { phase: 'zen', zenTurns: 7 },
    )
  })

  it('full → 恢复 full（不重入 zen）', () => {
    assert.deepEqual(
      foldZenFromMeta({ zenPhase: 'full', zenStats: { armed: true, zenTurns: 3 } }),
      { phase: 'full', zenTurns: 3 },
    )
  })

  it('zenStats 缺失 / 非法 / 负数 → zenTurns 归零（脏 meta 保守处理）', () => {
    assert.deepEqual(foldZenFromMeta({ zenPhase: 'zen' }), { phase: 'zen', zenTurns: 0 })
    assert.deepEqual(
      foldZenFromMeta({ zenPhase: 'zen', zenStats: { armed: true, zenTurns: -1 } }),
      { phase: 'zen', zenTurns: 0 },
    )
    assert.deepEqual(
      foldZenFromMeta({ zenPhase: 'zen', zenStats: { armed: true, zenTurns: '7' } }),
      { phase: 'zen', zenTurns: 0 },
    )
  })
})

describe('zenUnregisteredHint — 幻觉调用的可行动出路', () => {
  it('包含工具名与 zen_unlock 指引', () => {
    const hint = zenUnregisteredHint('warp_tool')
    assert.ok(hint.includes('warp_tool'))
    assert.ok(hint.includes('zen_unlock'))
    assert.ok(hint.includes('禅模式'))
  })
})
