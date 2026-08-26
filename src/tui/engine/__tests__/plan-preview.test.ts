/**
 * 计划全文预览（方案 A）：审批卡 / plan-picker 按 v 暂离到全屏 pager，
 * q/Esc 按原路返回；/plan-view（无 returnTo）q 退出回主屏。
 *
 * 契约：
 *  - 审批卡 v → pager 显示全文；q/Esc 返回审批卡（标题与选项仍在屏）
 *  - plan-picker v → pager；q 返回 picker
 *  - 无 returnTo 的预览 q 退出后指针清空（不劫持后续 pager）
 *  - 预览态 v/m 是 no-op（无 verbose/message 可切）
 *  - 长计划 PgDn 翻页出页码
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { parseScrollbackTranscript } from '../../scrollback-transcript.js'
import type { PlanSubmittedInfo } from '../../../tools/types.js'

class MockOut {
  columns = 80
  rows = 24
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
  clear() { this.chunks = [] }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

const PLAN_BODY = Array.from({ length: 60 }, (_, i) => `计划第${i}行`).join('\n')

function makeApp(rows = 24) {
  const out = new MockOut()
  out.rows = rows
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows, modelName: 'test',
  })
  // 仿 main.ts pagerContent 的 plan 分支：预览指针在 → 全文 + footerHints 覆盖
  //（无 verbose/message 可切，q 语义是「返回」）+ messages 供 / 搜索与 n/N 跳匹配。
  app.registerOverlays({
    pagerContent: () => {
      const preview = app.getPlanPreview()
      if (!preview) return { content: 'scrollback content', page: 0, title: 'Scrollback' }
      const back: [string, string] = preview.returnTo ? ['q/Esc', '返回'] : ['q/Esc', '关闭']
      return {
        content: PLAN_BODY,
        page: 0,
        title: '计划预览: 「重构缓存层」· fix-cache',
        footerHints: [['↑↓/j/k', '滚动'], ['PgUp/PgDn', '翻页'], ['/', '搜索'], back],
        messages: parseScrollbackTranscript(PLAN_BODY),
      }
    },
    choicePanelData: () => ({
      title: '计划审批 / Plan Approval\n「重构缓存层」\n──\n摘要行',
      choices: [{ id: 'approve', label: '批准并执行', description: '执行计划「重构缓存层」' }],
      selectedIndex: 0,
    }),
    planPickerData: () => ({
      entries: [{ slug: 'fix-cache', title: '重构缓存层', status: 'submitted' as const, createdAt: '刚刚' }],
      selectedIndex: 0,
    }),
  })
  app.start()
  return { app, out, stdin }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

// 行级 diff 写入流回放为虚拟行网格（同 overlay-nav.test.ts）。
function reconstructScreen(raw: string): string {
  const grid: string[] = []
  let row = 0
  const ensure = (r: number) => { row = r; while (grid.length <= row) grid.push('') }
  ensure(0)
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '\x1B' && raw[i + 1] === '[') {
      const m = /^\x1B\[([0-9;?]*)([a-zA-Z])/.exec(raw.slice(i))
      if (m) {
        const cmd = m[2]
        if (cmd === 'H') {
          const r = parseInt((m[1] || '1').split(';')[0] || '1', 10)
          ensure(Math.max(1, r) - 1)
        } else if (cmd === 'K') {
          grid[row] = ''
        }
        i += m[0].length
        continue
      }
    }
    const ch = raw[i]!
    if (ch === '\n') ensure(row + 1)
    else if (ch !== '\r') grid[row] += ch
    i += 1
  }
  return grid.join('\n')
}

const screenOf = (out: MockOut): string => stripAnsi(reconstructScreen(out.chunks.join('')))

const PLAN_INFO: PlanSubmittedInfo = { slug: 'fix-cache', title: '重构缓存层' }

test('审批卡 v → pager 显示计划全文，q 返回审批卡', () => {
  const { app, out, stdin } = makeApp()
  app.openPlanApprovalPanel(PLAN_INFO, { body: PLAN_BODY, date: '2026-08-26' })
  const opened = screenOf(out)
  assert.ok(opened.includes('计划审批'), '前置：钉底审阅卡已打开')
  assert.ok(opened.includes('2026-08-26'), '标题标日期')
  assert.ok(opened.includes('❯'), '输入框仍可见')
  assert.ok(!opened.includes('低阶'), '不标模型档')

  out.clear()
  stdin.dataHandler!('v')
  const preview = screenOf(out)
  assert.ok(preview.includes('计划预览'), `v 应打开全文预览，帧: ${preview}`)
  assert.ok(preview.includes('计划第0行') && preview.includes('计划第19行'), '首页应含前 20 行（pageSize = rows-4）')
  assert.ok(!preview.includes('计划第20行'), '首页不应含第 21 行')
  // footerHints 覆盖：无 verbose 可切、q 是「返回」而非「关闭」。
  assert.ok(!preview.includes('详细/简略'), '预览 footer 不应提示 v:详细/简略')
  assert.ok(preview.includes('返回'), '有 returnTo 时 footer 应提示返回')

  out.clear()
  stdin.dataHandler!('q')
  const back = screenOf(out)
  assert.ok(back.includes('计划审批') && back.includes('批准并执行'), `q 应回审批卡，帧: ${back}`)
  assert.ok(!back.includes('计划预览'), '返回后预览标题应消失')
  assert.equal(app.getPlanPreview(), null, '预览指针应已清空')
})

test('审批卡预览 Esc 同样返回审批卡', () => {
  const { app, out, stdin } = makeApp()
  app.openPlanApprovalPanel(PLAN_INFO, { body: PLAN_BODY, date: '2026-08-26' })
  stdin.dataHandler!('v')
  out.clear()
  stdin.dataHandler!('\x1B')
  const back = screenOf(out)
  assert.ok(back.includes('计划审批'), `Esc 应回审批卡，帧: ${back}`)
  assert.equal(app.getPlanPreview(), null)
})

test('plan-picker v → pager，q 返回 picker', () => {
  const { app, out, stdin } = makeApp()
  app.activateOverlay('plan-picker')
  assert.ok(screenOf(out).includes('选择要批准执行的计划'), '前置：picker 已打开')

  out.clear()
  stdin.dataHandler!('v')
  const preview = screenOf(out)
  assert.ok(preview.includes('计划预览') && preview.includes('计划第0行'), `v 应预览选中计划，帧: ${preview}`)

  out.clear()
  stdin.dataHandler!('q')
  const back = screenOf(out)
  assert.ok(back.includes('选择要批准执行的计划'), `q 应回 picker，帧: ${back}`)
  assert.equal(app.getPlanPreview(), null)
})

test('/plan-view（无 returnTo）q 退出回主屏，指针不残留', () => {
  const { app, out, stdin } = makeApp()
  app.openPlanPreview('fix-cache')
  const frame = screenOf(out)
  assert.ok(frame.includes('计划预览'), '前置：预览已打开')
  assert.ok(frame.includes('关闭') && !frame.includes('返回'), '无 returnTo 时 footer 应提示关闭')

  out.clear()
  stdin.dataHandler!('q')
  assert.equal(app.getPlanPreview(), null, '退出后指针必须清空（防劫持后续 pager）')
  assert.ok(!screenOf(out).includes('计划预览'), '预览标题应消失')
})

test('预览支持 / 搜索与匹配计数（messages 传入后 n/N 可用）', () => {
  const { app, out, stdin } = makeApp()
  app.openPlanPreview('fix-cache')
  out.clear()
  stdin.dataHandler!('/') // 进入搜索模式
  stdin.dataHandler!('计划第5')
  stdin.dataHandler!('\r') // 确认搜索
  const frame = screenOf(out)
  // 匹配计数按「消息」口径（searchTranscript）：整份计划文本被 parse 成
  // 1 条消息，含查询串即计 1 —— (1/1)。行级高亮由 highlightMatch 负责。
  const first2 = frame.split('\n').slice(0, 2).join(' | ')
  assert.ok(frame.includes('搜索 "计划第5"'), `搜索标题应出现，首两行: ${first2}`)
  assert.ok(frame.includes('(1/1)'), `匹配计数应为 1/1，首两行: ${first2}`)
})

test('预览态 v/m 是 no-op（无 verbose/message 可切，不 rerender）', () => {
  const { app, out, stdin } = makeApp()
  app.openPlanPreview('fix-cache')
  out.clear()
  stdin.dataHandler!('v')
  assert.equal(stripAnsi(out.chunks.join('')), '', 'v 不应触发 rerender')
  stdin.dataHandler!('m')
  assert.equal(stripAnsi(out.chunks.join('')), '', 'm 不应触发 rerender')
})

test('长计划翻页：PgDn 后标题页码推进到 (2/3)', () => {
  const { app, out, stdin } = makeApp()
  app.openPlanPreview('fix-cache')
  out.clear()
  stdin.dataHandler!('\x1B[6~')
  const page2 = screenOf(out)
  assert.ok(page2.includes('(2/3)'), `60 行 / pageSize 20 → 3 页，PgDn 后应显示 (2/3)，帧: ${page2}`)
  assert.ok(page2.includes('计划第20行'), '第 2 页应从第 21 行起')
})
