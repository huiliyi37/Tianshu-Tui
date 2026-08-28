import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import stringWidth from 'string-width'
import { formatWelcome, isMissionLine, missionShimmer } from '../format/welcome.js'
import { getTheme } from '../theme.js'
import { color } from '../engine/ansi.js'
import { displayWidth } from '../width.js'

const theme = getTheme()

const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

/** 标准入参,按需覆盖。 */
const base = {
  modelName: 'deepseek-v4',
  cwd: '/tmp/x/proj',
  sessionId: '878e2108abcd',
  priorMsgCount: 0,
  columns: 80,
  rows: 40,
  version: '2.15.1',
  approvalMode: 'auto-safe',
}

const render = (over: Partial<typeof base> & Record<string, unknown> = {}) =>
  formatWelcome({ ...base, ...over } as Parameters<typeof formatWelcome>[0], theme)

const stripAll = (lines: string[]) => lines.map(strip)
const withLine = (lines: string[], needle: string) => stripAll(lines).find(l => l.includes(needle))!
/** 按剥色后的内容定位,返回原始着色行(供 SGR 断言用)。 */
const rawWith = (lines: string[], needle: string) => lines.find(l => strip(l).includes(needle))!

const bodyW = (cols: number): number => Math.min(cols, 72)

/** 全妆:'' + 字标×6(shadow 立体字)+ 使命 + 基准线 + '' + 提醒×3 + ''(使命省略 13 行)。 */
const FULL_LINES = 15
const FULL_LINES_NO_MISSION = 14

// ── 结构契约 ────────────────────────────────────────────────────────

test(`定盘星全妆:${FULL_LINES} 行(立体字标 + 使命 + 基准线 + 进入提示区)`, () => {
  const lines = render()
  assert.equal(lines.length, FULL_LINES, `实得 ${lines.length}:"${lines.join(' | ')}"`)
  assert.equal(lines[0], '', '首行留空')
  assert.equal(lines.at(-1), '', '末行留空')
  const logo = stripAll(lines.slice(1, 7))
  assert.equal(logo.length, 6, 'ANSI Shadow 字标 6 行')
  assert.ok(logo.filter(l => l.includes('█')).length >= 5, '实心块行 ≥5')
  assert.ok(logo.every(l => /[█╔╗╚╝═║]/.test(l)), '每行都是块/双线字符')
  assert.ok(logo.some(l => l.includes('╗')), '双线角=自带阴影的立体字')
  assert.ok(strip(lines[7]!).includes('把星辰带给每一位开发者'), '使命行')
  assert.ok(strip(lines[8]!).includes('✦'), '基准线带亮星')
  assert.equal(strip(lines[9]!), '', '身份块与提示区之间的呼吸')
  const dIdx = lines.findIndex(l => strip(l).includes('/domain'))
  const hIdx = lines.findIndex(l => strip(l).includes('/handoff'))
  const cIdx = lines.findIndex(l => strip(l).includes('/team /scout'))
  assert.ok(dIdx > 0 && hIdx > dIdx, `R12:/domain 置于 /handoff 之前(${dIdx} < ${hIdx})`)
  assert.ok(strip(lines[dIdx]!).includes('工程能力'), '/domain 星域描述在场')
  assert.ok(cIdx > dIdx && cIdx < hIdx, `协同提示行在 /domain 与 /handoff 之间(${dIdx} < ${cIdx} < ${hIdx})`)
  assert.ok(strip(lines[cIdx]!).includes('并行施工'), '协同提示带选型描述')
  assert.ok(strip(lines[cIdx]!).includes('/council'), '协同提示含 /council 入口')
  assert.ok(strip(lines[hIdx + 1]!).includes('碎缓存'), '进入提示·缓存')
})

test('字标:≥58 列 ANSI Shadow 立体字 TIANSHU(56 列 × 6 行);44-57 自动降档点阵(41 列 × 5 行)', () => {
  for (const cols of [58, 78, 79, 80, 120, 200]) {
    const lines = render({ columns: cols })
    const logo = stripAll(lines.slice(1, 7))
    assert.equal(logo.length, 6, `cols=${cols} 立体字 6 行`)
    assert.ok(logo.every(l => [56, 74, 78].includes(displayWidth(l))), `cols=${cols} 字标行宽应恒 56(品牌段行 74/78),实得 ${logo.map(l => displayWidth(l))}`)
    assert.ok(logo.some(l => l.includes('╗')), '双线立体字')
    const second = logo[1]!
    if (cols >= 79) assert.ok(second.includes('天枢') && second.includes('v2.15.1'), `cols=${cols} 应挂原生词标`)
    else assert.ok(!second.includes('天枢'), `cols=${cols} 字标独立(56+6+17=79 才挂)`)
  }
  for (const cols of [44, 57]) {
    const lines = render({ columns: cols })
    const logo = stripAll(lines.slice(1, 6))
    assert.equal(logo.length, 5, `cols=${cols} 自动降档点阵 5 行`)
    assert.ok(logo.every(l => l.includes('#') && displayWidth(l) === 41), `cols=${cols} 点阵 41 列`)
  }
})

test('设计边界:上方零活信息——模型/目录/会话号/权限/effort 不出现在全妆(只归 compact)', () => {
  const joined = strip(render({ reasoningEffort: 'high', numericId: 7281 }).join('\n')).replace(/v2\.15\.1/g, '')
  assert.ok(!joined.includes('deepseek-v4'), '模型名不上屏')
  assert.ok(!joined.includes('/tmp/x/proj'), '目录不上屏')
  assert.ok(!joined.includes('#7281'), '会话号不上屏')
  assert.ok(!joined.includes('自动'), '权限模式不上屏')
  assert.ok(!joined.includes('◎high'), 'effort 徽章不上屏')
})

test('范围纪律:输入框上方禁止 mcp / ctx / F 键 chips 残留', () => {
  const joined = strip(render().join('\n'))
  assert.ok(!/mcp|ctx /.test(joined), '无 mcp/ctx 标识')
  assert.ok(!joined.includes('F1'), '无 F 键 chips')
})

// ── 品牌渐变 ────────────────────────────────────────────────────────

test('「天枢」truecolor 档同色相微渐变:首字符与次字符 SGR 不同', () => {
  const tc = getTheme(3)
  const line = rawWith(formatWelcome({ ...base }, tc), '天枢')
  const sgrs = [...line.matchAll(/\x1B\[38;2;(\d+;\d+;\d+)m(?:\x1B\[1m)?(?=[天枢])/g)].map(m => m[1])
  assert.ok(sgrs.length >= 2, `「天枢」两字符应各自带 38;2 SGR,实得 ${sgrs.length}`)
  assert.notEqual(sgrs[0], sgrs[1], '首字符向白混光(渐变)')
})

// ── 使命行 ──────────────────────────────────────────────────────────

test('使命行:README 品牌句双语上屏;栏宽 <59 整行省略,绝不腰斩', () => {
  const wide = withLine(render({ columns: 80 }), '把星辰')
  assert.ok(wide.includes('把星辰带给每一位开发者'), '中文主句')
  assert.ok(wide.includes('Models as partners, not tools.'), '英文短语')
  assert.ok(!wide.includes('…'), '不截断')
  const narrow = render({ columns: 56 })
  assert.equal(narrow.length, 13, '56 列自动 pixel 且使命行整行省略')
  assert.ok(!strip(narrow.join('\n')).includes('把星辰'), '窄栏无半句 slogan')
  assert.equal(render({ columns: 59 }).length, FULL_LINES, '59 列宽档(·计 2)恰好放下')
  assert.equal(render({ columns: 60 }).length, FULL_LINES, '60 列宽裕')
})

// ── 基准线 ──────────────────────────────────────────────────────────

test('基准线是唯一全幅元素:显示宽度恒等于 cols,✦ 落在 ⌊cols×0.38⌋', () => {
  for (const cols of [44, 59, 60, 80, 120, 200]) {
    const rule = withLine(render({ columns: cols }), '─')
    assert.equal(displayWidth(rule), cols, `cols=${cols} 基准线应全幅,实得 ${displayWidth(rule)}`)
    const k = Math.floor(cols * 0.38)
    assert.equal(displayWidth(rule.slice(0, rule.indexOf('✦'))), k, `cols=${cols} 星位 38%`)
    assert.equal((rule.match(/✦/g) ?? []).length, 1, '唯一亮星')
  }
})

test('星域个性:separator 档位决定基准线横线(thick━ / dots┄),与输入框同源', () => {
  const ruleOf = (o: Record<string, unknown>) => stripAll(render(o).filter(l => /─|━|┄/.test(strip(l))))[0]!
  assert.ok(ruleOf({ separator: 'thick' }).startsWith('━'), 'thick 档用 ━')
  assert.ok(ruleOf({ separator: 'dots' }).startsWith('┄'), 'dots 档用 ┄')
  assert.ok(ruleOf({ separator: 'thin' }).startsWith('─'), 'thin 档用 ─')
})

// ── 用色纪律 ────────────────────────────────────────────────────────

test('单一 accent 纪律:chroma 只出现在 brandColor 与受控位', () => {
  const lines = render({ columns: 80 })
  const mission = rawWith(lines, '把星辰')
  assert.ok(mission.includes(color('把星辰带给每一位开发者', theme.muted)), '使命句走 muted')
  assert.ok(mission.includes(color('Models as partners, not tools.', theme.dim)), '英文短语更退一档')
  const hint = rawWith(lines, '/handoff')
  assert.ok(hint.includes(color('/handoff', theme.brandColor)), '/handoff 是 brandColor')
  assert.ok(hint.includes(color('⏜', theme.secondary)), 'handoff glyph 走 secondary')
  const cacheHint = rawWith(lines, '碎缓存')
  assert.ok(cacheHint.includes(color('/model /domain', theme.secondary)), '缓存提醒命令 token 走 secondary')
})

// ── 进入提示区 ──────────────────────────────────────────────────────

test('进入提示区仅新会话出现;恢复会话(compact)不重复提醒', () => {
  const resume = render({ compact: true, priorMsgCount: 7 })
  assert.ok(!strip(resume.join('\n')).includes('/handoff'), '恢复会话无 handoff 提醒')
})

// ── compact 单行 ────────────────────────────────────────────────────

test('compact(恢复会话)单行:✦ 天枢 · 模型 · ↑续N轮,版本常显', () => {
  const lines = render({ columns: 80, priorMsgCount: 7, compact: true })
  assert.equal(lines.length, 1)
  const line = strip(lines[0]!)
  assert.ok(line.includes('天枢') && line.includes('deepseek-v4'), '品牌 + 模型')
  assert.ok(line.includes('↑续7轮'), '恢复态显示续跑轮次')
  assert.ok(!line.includes('#'), '恢复态不显示会话号')
  assert.ok(line.includes('v2.15.1'), 'compact 也显示版本号(Codex 对齐)')
})

test('compact(非首次启动)单行:无 prior 时显示目录与友好会话号', () => {
  const line = strip(render({ columns: 80, compact: true, numericId: 7281 })[0]!)
  assert.ok(line.includes('/tmp/x/proj'), '目录')
  assert.ok(line.includes('#7281'), 'numericId 优先')
  assert.ok(!line.includes('878e2108'), '有 numericId 不回落会话前缀')
  const fallback = strip(render({ columns: 80, compact: true, sessionId: '8938a88f-xxxx' })[0]!)
  assert.ok(fallback.includes('8938a88f'), '无 numericId 回落会话前缀')
})

test('home 下的 cwd 缩写为 ~(compact 行)', () => {
  const line = strip(render({ columns: 80, compact: true, cwd: `${homedir()}/app/proj` })[0]!)
  assert.ok(line.includes('~/app/proj'))
})

test('effort 徽章档位色:high→primary / auto→secondary', () => {
  const high = render({ columns: 80, compact: true, reasoningEffort: 'high' })[0]!
  assert.ok(high.includes(color('◎high', theme.primary)), '◎high 走 primary')
  const auto = render({ columns: 80, compact: true, reasoningEffort: 'auto' })[0]!
  assert.ok(auto.includes(color('◎auto', theme.secondary)), '◎auto 走 secondary')
})

// ── 降级 ────────────────────────────────────────────────────────────

test('矮终端:shadow rows≥19 全妆;cols 50 自动降档 pixel 时 rows≥18 即全妆', () => {
  assert.equal(render({ columns: 100, rows: 18 }).length, 1)
  assert.equal(render({ columns: 100, rows: 19 }).length, FULL_LINES)
  assert.equal(render({ columns: 50, rows: 18 }).length, 13, '50 列自动 pixel 且使命行让位(5 行字标)')
  assert.equal(render({ columns: 50, rows: 17 }).length, 1)
})

test('字标风格可调:logoStyle / RIVET_WELCOME_LOGO 环境变量', () => {
  const pixel = render({ logoStyle: 'pixel' })
  assert.equal(pixel.length, 14, 'pixel 5 行字标(含使命行)→ 14 行')
  assert.ok(stripAll(pixel.slice(1, 6)).every(l => l.includes('#')), '点阵 TIANSHU')
  const prev = process.env['RIVET_WELCOME_LOGO']
  try {
    process.env['RIVET_WELCOME_LOGO'] = 'pixel'
    assert.equal(render().length, 14, 'env 切换生效(pixel 含使命行)')
    process.env['RIVET_WELCOME_LOGO'] = 'shadow'
    assert.equal(render().length, FULL_LINES, 'env 切回 shadow')
  } finally {
    if (prev === undefined) delete process.env['RIVET_WELCOME_LOGO']
    else process.env['RIVET_WELCOME_LOGO'] = prev
  }
})

test('窄终端(cols<44)退单行;44 列起立体字标(使命行与原生词标让位)', () => {
  assert.equal(render({ columns: 43 }).length, 1)
  const c44 = render({ columns: 44 })
  assert.equal(c44.length, 13, '44 列自动 pixel(使命行让位)')
  assert.ok(strip(c44.join('\n')).includes('#'), '44 列点阵字标仍在')
  assert.ok(!strip(c44.join('\n')).includes('把星辰'), '44 列无使命句')
})

test('未提供 rows 时按全妆渲染(向后兼容)', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 100,
  }, theme)
  assert.equal(lines.length, FULL_LINES)
})

test('R21 ASCII 环境:提示行小符号降级,品牌艺术字标恒为立体 TIANSHU', () => {
  // 用户实锤:# 点阵降级被终端用户视为「坏掉了」。品牌字标(█ ╔ ═)不参与
  // ASCII 降级——现代终端字形覆盖率近 100%,ZCode 同类艺术字无条件输出;
  // 仅 chrome 小符号(⏜✧ → - .)与基准线退档。
  const prev = process.env.RIVET_ASCII_UI
  try {
    process.env.RIVET_ASCII_UI = '1'
    const lines = render({ columns: 80 })
    const logo = stripAll(lines.slice(1, 7))
    assert.equal(logo.length, 6, '立体字标 6 行不随 ASCII 降档')
    assert.ok(logo.some(l => l.includes('████████╗')), 'TIANSHU 立体字保留')
    const rule = withLine(lines.filter(l => strip(l).includes('-') && !strip(l).includes('/')), '-')
    assert.equal(displayWidth(rule), 80, 'ASCII 基准线仍全幅')
    const hint = withLine(lines, '/handoff')
    assert.ok(strip(hint).startsWith('- '), 'handoff glyph 退为 -')
    const collab = withLine(lines, '/team /scout')
    assert.ok(strip(collab).startsWith('. '), '协同提示行 glyph 退为 .')
    // R24 双层豁免:艺术字母恒 Unicode,品牌段小星形单独跟随 tiny-symbol 降级
    const brand = withLine(lines, '天枢')
    assert.ok(strip(brand).includes('* 天枢'), 'ASCII 下品牌段星形退为 *')
    assert.ok(!strip(brand).includes('✦'), 'ASCII 下品牌段不得残留 ✦(豆腐块)')
  } finally {
    if (prev === undefined) delete process.env.RIVET_ASCII_UI
    else process.env.RIVET_ASCII_UI = prev
  }
})

// ── 不折行 ──────────────────────────────────────────────────────────

test('任何输入下都不超出终端宽度(含 ambiguous 恒 2 列的上界)', () => {
  for (const cols of [20, 43, 44, 57, 58, 72, 80, 120, 200]) {
    const lines = render({
      columns: cols,
      modelName: '天枢模型-超长名字测试-deepseek-v4-pro',
      cwd: '/Users/banxia/app/深度求索/超长中文目录名/opencode-tui',
      priorMsgCount: 3,
    })
    for (const line of lines) {
      const plain = strip(line)
      assert.ok(stringWidth(plain) <= cols, `cols=${cols}:窄档 ${stringWidth(plain)} 应 ≤ ${cols}:"${plain}"`)
      assert.ok(
        displayWidth(plain, { ambiguousAsWide: true }) <= cols,
        `cols=${cols}:宽档上界 ${displayWidth(plain, { ambiguousAsWide: true })} 应 ≤ ${cols},否则 CJK 终端折行`,
      )
    }
  }
})

test('缺省 version / approvalMode 不留悬挂文本', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 80, rows: 40,
  }, theme)
  const joined = strip(lines.join('\n'))
  assert.ok(joined.includes('天枢'), '品牌仍在(原生词标挂字标中行)')
  assert.ok(!/v ?(undefined|null)/.test(joined), '无悬挂版本文本')
})
