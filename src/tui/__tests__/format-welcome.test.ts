import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import stringWidth from 'string-width'
import { formatWelcome } from '../format/welcome.js'
import { getTheme } from '../theme.js'
import { color } from '../engine/ansi.js'
import { displayWidth } from '../width.js'
import { boxCharsFor, boxInnerWidth, boxOuterWidth } from '../box-chars.js'

const theme = getTheme()

const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

/** 标准入参，按需覆盖。 */
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

/** 某字符在行内的显示起列（含 `│ ` 前缀，按指定口径度量）。 */
const colOf = (line: string, ch: string, cal: { ambiguousAsWide?: boolean } = {}) => {
  const plain = strip(line)
  const idx = plain.indexOf(ch)
  return idx < 0 ? -1 : displayWidth(plain.slice(0, idx), cal)
}

/** 框体行（剥掉首尾呼吸空行）。 */
const boxOf = (lines: string[]) => lines.slice(1, -1)

/**
 * 框高契约。刻意增删首屏行时只改这里 —— 其余断言一律用相对位置
 * （`at(-1)` / `slice(1, -1)`），别再把行号散写进各个用例。
 */
const BOX_LINES = 10
const TOTAL_LINES = BOX_LINES + 2 // 首尾各一行呼吸空行

// ── 结构契约 ────────────────────────────────────────────────────────

test(`星阁定稿：${BOX_LINES} 行框体 + 首尾呼吸空行 = ${TOTAL_LINES} 行`, () => {
  const lines = render()
  assert.equal(lines.length, TOTAL_LINES, `框 ${BOX_LINES} 行加首尾空行共 ${TOTAL_LINES} 行，实得 ${lines.length}`)
  assert.equal(lines[0], '', '首行留空，清屏后不贴顶边')
  assert.equal(lines.at(-1), '', '末行留空，底框不与输入框顶框粘连')
  const box = boxOf(lines)
  assert.equal(box.length, BOX_LINES)
  assert.ok(strip(box[0]!).startsWith('╭'), '框首行是顶框')
  assert.ok(strip(box.at(-1)!).startsWith('╰'), '框末行是底框')
  for (const line of box.slice(1, -1)) {
    assert.ok(strip(line).startsWith('│ ') && strip(line).endsWith(' │'), `内容行两侧有竖边线: "${strip(line)}"`)
  }
})

test('框宽与输入框逐列一致：每行显示宽度恒等于 boxOuterWidth(cols)', () => {
  for (const cols of [48, 60, 80, 100, 120, 200]) {
    const box = boxOf(render({ columns: cols }))
    const want = boxOuterWidth(cols)
    for (const [i, line] of box.entries()) {
      assert.equal(
        displayWidth(strip(line)), want,
        `cols=${cols} 框内第 ${i + 1} 行宽度应为 ${want}，实得 ${displayWidth(strip(line))}："${strip(line)}"`,
      )
    }
  }
})

test('底框与 app.ts 输入框底边同构（tl/bl + h×(inner+2) + tr/br）', () => {
  const cols = 80
  const chars = boxCharsFor('thin')
  const inner = boxInnerWidth(cols)
  const box = boxOf(render({ columns: cols }))
  assert.equal(strip(box.at(-1)!), `${chars.bl}${chars.h.repeat(inner + 2)}${chars.br}`)
})

/** 提取一段着色后的首个前景色 SGR（含 24-bit 与 8/16 色命名档 30-39 / 90-99）。 */
const firstFg = (line: string): string | null => {
  const m = line.match(/\x1B\[(?:38;2;\d+;\d+;\d+|3[0-9]|9[0-9])/)
  return m ? m[0]! : null
}

/** 检测首段着色是否带 `bold`（1）/ `dim`（2）SGR 属性——用作视觉权重断言的 ground truth。 */
const firstAttr = (line: string): string | null => {
  const m = line.match(/\x1B\[(?:1|2|22)m/)
  return m ? m[0]! : null
}

/** theme.muted 套上 `color()` 后产出的前景色 SGR——用作色档 ground truth。
 *  muted 在多套主题里都比 dim 提亮一档且带轻微色相偏移（Tianshu #adb2bf、
 *  Starfield #aab4d4、Slate #8b93a3），符合"精致但不抢眼"的诉求。 */
const mutedFg = ((): string | null => {
  const sample = `${color('x', theme.muted)}x`
  return firstFg(sample)
})()

test('框线着色：左/右竖线 + 顶框 + 底框的 SGR 与 theme.muted 一致 + 视觉权重 bold', () => {
  // 不变量：色档 = muted（提亮一档带色相偏移，避免纯中性灰的"表格感"），
  // 视觉权重 = bold（让框线在暗底上有"压"住的份量，避免纯色色块感）。
  // 与 app.ts 输入框静息档形成可读层次：输入框静息档 = dim（更退），
  // 欢迎框 = muted + bold（更精致），两框咬合但有视觉区分。
  // 必须用 truecolor 主题才能区分 dim/muted/pulseQuiet（fallback 轨三者是同一命名色 "gray"）。
  const tcTheme = getTheme(3)
  const frameFg = firstFg(`${color('x', tcTheme.muted)}x`)
  assert.ok(frameFg, 'theme.muted 须能套出 SGR 序列，否则 helper 与主题同时坏，断言无意义')
  const chars = boxCharsFor('thin')
  // 在真色主题下重渲染
  const lines = formatWelcome({
    modelName: base.modelName, cwd: base.cwd, sessionId: base.sessionId,
    priorMsgCount: base.priorMsgCount, columns: 80, rows: base.rows,
    version: base.version, approvalMode: base.approvalMode,
  }, tcTheme)
  const box = boxOf(lines)

  // 左竖线 `│`：首段着色就是它
  assert.equal(
    firstFg(box[1]!), frameFg,
    `左竖线 SGR 应等于 theme.muted（${frameFg}），实得 ${firstFg(box[1]!)}`,
  )
  // 顶框首字符 `╭` 着色应是 muted
  assert.equal(
    firstFg(box[0]!), frameFg,
    `顶框首段着色应是 theme.muted，实得 ${firstFg(box[0]!)}`,
  )
  // 底框
  assert.equal(strip(box.at(-1)!), `${chars.bl}${chars.h.repeat(boxInnerWidth(80) + 2)}${chars.br}`)
  assert.equal(
    firstFg(box.at(-1)!), frameFg,
    `底框首段着色应是 theme.muted，实得 ${firstFg(box.at(-1)!)}`,
  )
  // 反断言：不能是 pulseQuiet（真色轨下能区分的关键）
  const pulseFg = firstFg(`${color('x', tcTheme.pulseQuiet)}x`)
  assert.notEqual(
    firstFg(box.at(-1)!), pulseFg,
    `底框不该是 pulseQuiet（${pulseFg}）——该色档在深底上近乎隐形`,
  )
  // 反断言：不能是纯 dim（避免"表格中性灰"的回归）
  const dimFg2 = firstFg(`${color('x', tcTheme.dim)}x`)
  assert.notEqual(
    firstFg(box.at(-1)!), dimFg2,
    `底框不该是 theme.dim（${dimFg2}）——中性灰会让框线读起来像表格`,
  )
  // 视觉权重：边线字符位的 SGR 序列里应含 bold（ANSI.BOLD = ESC[1m）
  // color(text, muted, { bold:true }) 输出的格式是 ESC[1m + 颜色 SGR + ...
  // color() 的 bold 前缀在 color 前缀之前（ansi.ts:188），所以首段属性 SGR = ESC[1m
  assert.equal(
    firstAttr(box.at(-1)!), '\x1B[1m',
    `底框首段属性 SGR 须是 bold（[1m），实得 ${JSON.stringify(firstAttr(box.at(-1)!))}；视觉权重不足会让框线像表格线`,
  )
  assert.equal(
    firstAttr(box[1]!), '\x1B[1m',
    `左竖线首段属性 SGR 须是 bold，实得 ${JSON.stringify(firstAttr(box[1]!))}`,
  )
})

// ── 北斗 ────────────────────────────────────────────────────────────

test('北斗占两行：顶行斗身上边接斗柄，次行 ╰…╯ 收口成斗', () => {
  const box = boxOf(render({ columns: 100 }))
  const top = strip(box[1]!)
  const bowl = strip(box[2]!)
  assert.equal((top.match(/[✦✧∙]/g) ?? []).length, 5, '顶行 5 颗：天枢 天权 玉衡 开阳 瑶光')
  assert.equal((bowl.match(/[✦✧∙]/g) ?? []).length, 2, '次行 2 颗：天璇 天玑')
  assert.ok(bowl.includes('╰') && bowl.includes('╯'), '次行用圆角收口成勺')
  assert.ok(top.startsWith('│ ✦'), `天枢是最亮档实心星: "${top}"`)
})

test('星等三档编码：✦ 最亮双星 · ✧ 次亮四星 · ∙ 最暗的天权', () => {
  const box = boxOf(render({ columns: 100 }))
  const dipper = strip(box[1]!) + strip(box[2]!)
  assert.equal((dipper.match(/✦/g) ?? []).length, 2, '天枢 1.79 与玉衡 1.77 是实心 ✦')
  assert.equal((dipper.match(/✧/g) ?? []).length, 4, '天璇/天玑/开阳/瑶光 是空心 ✧')
  assert.equal((dipper.match(/∙/g) ?? []).length, 1, '天权 3.31 是微点 ∙')
})

test('斗身收口对齐天权，且 narrow / wide 两档下列位一致', () => {
  const prev = process.env.RIVET_AMBIGUOUS_WIDTH
  try {
    for (const mode of ['narrow', 'wide'] as const) {
      process.env.RIVET_AMBIGUOUS_WIDTH = mode
      const box = boxOf(render({ columns: 100 }))
      const cal = { ambiguousAsWide: mode === 'wide' }
      assert.equal(
        colOf(box[2]!, '╯', cal), colOf(box[1]!, '∙', cal),
        `${mode} 档下 ╯ 应正落在天权 ∙ 的列位`,
      )
    }
  } finally {
    if (prev === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = prev
  }
})

test('星图字形宽度恒定：不含 East-Asian Ambiguous 字符（★ · 等）', () => {
  const box = boxOf(render({ columns: 100 }))
  for (const line of [box[1]!, box[2]!]) {
    const plain = strip(line)
    assert.equal(
      displayWidth(plain), displayWidth(plain, { ambiguousAsWide: true }),
      `星图行在两档下宽度必须相同，否则右边线随终端参差: "${plain}"`,
    )
    assert.ok(!/[★·]/.test(plain), '不得使用 ambiguous 的 ★ / ·')
  }
})

// ── 内容 ────────────────────────────────────────────────────────────

test('顶框嵌 wordmark，版本号贴右', () => {
  const head = strip(boxOf(render())[0]!)
  assert.ok(head.includes('天枢'), '中文品牌名')
  assert.ok(head.includes('T I Ā N S H Ū'), '宽字距拼音')
  assert.ok(head.includes('Code'), '英文后缀')
  assert.ok(/v2\.15\.1 ─╮$/.test(head), `版本号贴右边线: "${head}"`)
})

test('wordmark 在版本号过长时逐级降级', () => {
  const head = strip(boxOf(render({ columns: 48, version: '2.23.0-nightly.20260726' }))[0]!)
  assert.ok(head.includes('天枢'), '最窄也保留中文品牌名')
  assert.ok(!head.includes('T I Ā N S H Ū'), '宽字距拼音让位给版本号')
})

test('模型 / effort / 权限模式 / 路径 / 会话号各就其位', () => {
  const box = boxOf(render({ columns: 100, reasoningEffort: 'high', numericId: 7281 }))
  assert.ok(strip(box[4]!).includes('deepseek-v4'), '配置行含模型')
  assert.ok(strip(box[4]!).includes('◎high'), '配置行含 effort')
  assert.ok(strip(box[4]!).includes('auto-safe'), '配置行含权限模式')
  assert.ok(strip(box[5]!).includes('/tmp/x/proj'), '路径行含 cwd')
  assert.ok(strip(box[5]!).includes('#7281'), '路径行优先展示友好会话号')
  assert.ok(!strip(box[5]!).includes('878e2108'), '有 numericId 时不再显示会话前缀')
})

test('无 numericId 时路径行回落到会话前缀', () => {
  const box = boxOf(render({ columns: 100, sessionId: '8938a88f-c865-4c49-9c75-2c69e5b49e24' }))
  assert.ok(strip(box[5]!).includes('8938a88f'))
})

test('yolo 模式与 auto effort 正常显示', () => {
  const box = boxOf(render({ columns: 100, approvalMode: 'dangerously-skip-permissions', reasoningEffort: 'auto' }))
  const config = strip(box[4]!)
  assert.ok(config.includes('yolo'), 'dangerously-skip-permissions 简写为 yolo')
  assert.ok(config.includes('◎auto'))
})

test('缺省 version / approvalMode 时不留悬挂文本', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 80, rows: 40,
  }, theme)
  const joined = strip(lines.join('\n'))
  assert.ok(joined.includes('天枢'), '品牌仍在')
  assert.ok(!/v ?(undefined|null)/.test(joined), '无悬挂版本文本')
  assert.equal(displayWidth(strip(boxOf(lines)[0]!)), boxOuterWidth(80), '无版本时顶框仍然等宽')
})

test('home 下的 cwd 缩写为 ~', () => {
  const box = boxOf(render({ columns: 100, cwd: `${homedir()}/app/proj` }))
  assert.ok(strip(box[5]!).includes('~/app/proj'))
})

test('上手行按框宽贪心装填，窄框只留装得下的条目', () => {
  const wide = strip(boxOf(render({ columns: 100 }))[7]!)
  assert.ok(wide.includes('/init') && wide.includes('/domain') && wide.includes('/help'), '宽框三条齐上')
  const narrow = strip(boxOf(render({ columns: 56 }))[7]!)
  assert.ok(narrow.includes('/init'), '窄框保留第一条')
  assert.ok(!narrow.includes('/help'), '装不下的条目整条略去，不截半句')
})

// ── 降级 ────────────────────────────────────────────────────────────

test('compact 模式（恢复会话）折成单行', () => {
  const lines = render({ columns: 80, priorMsgCount: 7, compact: true })
  assert.equal(lines.length, 1)
  const line = strip(lines[0]!)
  assert.ok(line.includes('天枢') && line.includes('deepseek-v4') && line.includes('/help'))
  assert.ok(line.includes('7 prior'), '显示历史消息数')
})

test('矮终端（放不下星阁 + 输入框）退单行', () => {
  const lines = render({ columns: 100, rows: 12 })
  assert.equal(lines.length, 1, `rows=12 → 单行，实得 ${lines.length}`)
  assert.ok(strip(lines[0]!).includes('天枢'))
})

test('窄终端（< 48 列）退单行——框内挤不下正文时单行更诚实', () => {
  assert.equal(render({ columns: 47 }).length, 1)
  assert.equal(render({ columns: 48 }).length, TOTAL_LINES, '48 列是星阁下限')
})

test('未提供 rows 时按完整星阁渲染（向后兼容）', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 100,
  }, theme)
  assert.equal(lines.length, TOTAL_LINES)
})

test('ASCII 降级：框线与星形同时退到 ASCII，斗身仍收口成勺', () => {
  const prev = process.env.RIVET_ASCII_UI
  try {
    process.env.RIVET_ASCII_UI = '1'
    const box = boxOf(render({ columns: 80 }))
    assert.equal(box.length, BOX_LINES)
    assert.ok(strip(box[0]!).startsWith('+-'), '顶框走 ASCII')
    assert.ok(!/[✦✧∙╭╮╰╯│─]/.test(strip(box[1]!) + strip(box[2]!)), '星图不留 Unicode 字形')
    assert.ok(strip(box[2]!).includes('\\') && strip(box[2]!).includes('/'), 'ASCII 斗身用 \\ / 收口')
    for (const line of box) {
      assert.equal(displayWidth(strip(line)), boxOuterWidth(80), 'ASCII 档仍逐列等宽')
    }
  } finally {
    if (prev === undefined) delete process.env.RIVET_ASCII_UI
    else process.env.RIVET_ASCII_UI = prev
  }
})

// ── 不折行 ──────────────────────────────────────────────────────────

test('任何输入下都不超出终端宽度（含 ambiguous 恒 2 列的上界）', () => {
  for (const cols of [20, 40, 48, 60, 80, 120]) {
    const lines = render({
      columns: cols,
      modelName: '天枢模型-超长名字测试-deepseek-v4-pro',
      cwd: '/Users/banxia/app/深度求索/超长中文目录名/opencode-tui',
      priorMsgCount: 3,
      approvalMode: 'dangerously-skip-permissions',
      reasoningEffort: 'high',
    })
    for (const line of lines) {
      const plain = strip(line)
      assert.ok(stringWidth(plain) <= cols, `cols=${cols}：窄档 ${stringWidth(plain)} 应 ≤ ${cols}`)
      assert.ok(
        displayWidth(plain, { ambiguousAsWide: true }) <= cols,
        `cols=${cols}：宽档上界 ${displayWidth(plain, { ambiguousAsWide: true })} 应 ≤ ${cols}，否则 CJK 终端折行`,
      )
    }
  }
})
