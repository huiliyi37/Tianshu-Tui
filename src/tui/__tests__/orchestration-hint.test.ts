import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectOrchestrationFit,
  formatOrchestrationHint,
  OrchestrationHint,
  ORCHESTRATION_HINT_MAX_SHOWS,
} from '../engine/orchestration-hint.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')
const idle = { planMode: false, askMode: false, streaming: false }

// ── 信号检测（宁缺勿滥：≥2 信号才命中） ──────────────────────────────

test('detect: 并列连接词 + 多阶段动词共现 → 命中', () => {
  const r = detectOrchestrationFit('同时重构 auth 模块并补齐测试')
  assert.ok(r.hit)
  assert.ok(r.signals.includes('parallel-words'))
  assert.ok(r.signals.includes('multi-stage'))
})

test('detect: 单信号不命中（只含「以及」的普通句子）', () => {
  assert.ok(!detectOrchestrationFit('把这个函数的名字以及注释改一下').hit)
})

test('detect: 多个 @file 引用 + 改动动词 → 命中', () => {
  const r = detectOrchestrationFit('重构 @file:src/a.ts 和 @file:src/b.ts 两条链路并补文档')
  assert.ok(r.hit)
  assert.ok(r.signals.includes('multi-mention'))
})

test('detect: 长文本枚举多任务 → 命中 long-multi-task', () => {
  const text = '1. 重构登录模块的错误处理路径，把散落在各处的 try-catch 收口到统一的错误族\n' +
    '2. 实现刷新 token 的静默续期，覆盖并发请求下的单飞语义\n' +
    '3. 修复会话过期后的跳转闪烁与状态残留问题\n' +
    '4. 优化首屏加载的资源体积与缓存策略，给出量化对账并补齐回归测试'
  const r = detectOrchestrationFit(text)
  assert.ok(r.hit)
  assert.ok(r.signals.includes('long-multi-task'))
})

test('detect: 纯疑问句不触发（问答不是施工）', () => {
  assert.ok(!detectOrchestrationFit('/team 和 /scout 有什么区别？分别什么时候用？').hit)
})

test('detect: 短文本/空文本不触发', () => {
  assert.ok(!detectOrchestrationFit('').hit)
  assert.ok(!detectOrchestrationFit('   ').hit)
  assert.ok(!detectOrchestrationFit('修个 typo').hit)
})

// ── 状态机：激活/频率帽/Esc 关闭/Tab 采纳 ────────────────────────────

test('state: 命中时激活，文本改回普通即消失；每会话至多 2 次', () => {
  const h = new OrchestrationHint(true)
  assert.ok(h.evaluate('同时重构 auth 模块并补齐测试', idle))
  assert.ok(h.active)
  // 文本变成普通 → 消失
  assert.ok(h.evaluate('修个 typo', idle))
  assert.ok(!h.active)
  // 第二次出现
  h.evaluate('同时重构 user 模块并补齐测试', idle)
  assert.ok(h.active)
  assert.equal(h.shownCount, ORCHESTRATION_HINT_MAX_SHOWS)
  // 第三次不再出现（频率帽）
  h.evaluate('修个 typo', idle)
  h.evaluate('同时重构 order 模块并补齐测试', idle)
  assert.ok(!h.active, '超过频率帽后不再提示')
})

test('state: Esc dismiss 后本会话彻底关闭', () => {
  const h = new OrchestrationHint(true)
  h.evaluate('同时重构 auth 模块并补齐测试', idle)
  assert.ok(h.active)
  h.dismiss()
  assert.ok(!h.active)
  h.evaluate('同时重构 user 模块并补齐测试', idle)
  assert.ok(!h.active, 'dismiss 后不再出现')
})

test('state: Tab adopt 后本会话彻底关闭', () => {
  const h = new OrchestrationHint(true)
  h.evaluate('同时重构 auth 模块并补齐测试', idle)
  h.adopt()
  h.evaluate('同时重构 user 模块并补齐测试', idle)
  assert.ok(!h.active, 'adopt 后不再出现')
})

test('state: plan/ask 模式与流式中不触发；slash 输入不触发；总开关关闭不触发', () => {
  const text = '同时重构 auth 模块并补齐测试'
  const h = new OrchestrationHint(true)
  assert.ok(!h.evaluate(text, { ...idle, planMode: true }).valueOf(), 'plan mode 不触发')
  assert.ok(!h.active)
  assert.ok(!h.evaluate(text, { ...idle, askMode: true }), 'ask mode 不触发')
  assert.ok(!h.evaluate(text, { ...idle, streaming: true }), 'streaming 不触发')
  assert.ok(!h.evaluate('/team 同时重构 auth 并补测试', idle), 'slash 输入不触发')
  const off = new OrchestrationHint(false)
  assert.ok(!off.evaluate(text, idle), 'enabled=false 不触发')
})

// ── 渲染行（按 kind 分流，不全推） ──────────────────────────────────

test('render: team 档推 /team+/scout（不推 council）；council 档带 token 开销警示', () => {
  const teamLine = strip(formatOrchestrationHint(theme, false, 'team'))
  assert.ok(teamLine.includes('/team') && teamLine.includes('/scout'), 'team 档含施工与侦察入口')
  assert.ok(!teamLine.includes('/council'), 'team 档不推 council（不全推荐）')
  assert.ok(teamLine.includes('Tab') && teamLine.includes('Esc'))

  const councilLine = strip(formatOrchestrationHint(theme, false, 'council'))
  assert.ok(councilLine.includes('/council'), 'council 档推议事会')
  assert.ok(councilLine.includes('token 开销大'), 'council 档必须标注 token 开销（多席烧 Pro 额度）')

  const scoutLine = strip(formatOrchestrationHint(theme, false, 'scout'))
  assert.ok(scoutLine.includes('/scout') && !scoutLine.includes('/council'), 'scout 档只推侦察')

  const asciiLine = strip(formatOrchestrationHint(theme, true, 'team'))
  assert.ok(!asciiLine.includes('⚡'), 'ASCII 无 ⚡')
  assert.ok(asciiLine.includes('>'), 'ASCII 退化为 >')
})

test('kind 分流：评审/方案词 → council；排查/诊断词 → scout；多模块施工 → team', () => {
  assert.equal(detectOrchestrationFit('同时重构 auth 模块并补齐测试').kind, 'team')
  assert.equal(
    detectOrchestrationFit('这个迁移方案要不要上？帮我从架构和风险角度评审，分别看数据层和服务层的影响').kind,
    'council',
  )
  assert.equal(
    detectOrchestrationFit('排查一下为什么构建偶发失败，分别看依赖安装、类型检查和打包三个环节并给出归因').kind,
    'scout',
  )
})

test('state: kind 随命中更新，供 Tab 采纳组命令行', () => {
  const h = new OrchestrationHint(true)
  h.evaluate('同时重构 auth 模块并补齐测试', idle)
  assert.equal(h.kind, 'team')
  h.evaluate('改个注释', idle) // active=false，kind 保持
  h.evaluate('同时从架构和风险角度评审这个迁移方案并给出权衡', idle)
  assert.equal(h.kind, 'council')
})
