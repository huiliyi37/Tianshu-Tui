/**
 * /connect 向导列表步 UX 回归：
 * - 空格 / Ctrl+A 勾选只翻转复选框，光标保持不动（历史上走 advanceConnect
 *   的 next 分支会把 connectIndex 重置为 0，光标跳回第一项）
 * - input 步的 defaultValue 预填进编辑缓冲——预设地址是可编辑实体而非占位符
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeApp } from './_harness.js'
import type { ProbeReport } from '../../../api/provider-probe.js'

interface ConnectViewLite {
  kind: string
  title: string
  options?: Array<{ id: string; label?: string; checked?: boolean }>
  defaultValue?: string
  fields?: Array<{ id: string; kind: string; label: string; value: string }>
}

interface FlowAccess {
  view(): ConnectViewLite
  submitChoice(id: string): { kind: string }
  submitInput(value: string): { kind: string }
  applyProbe(report: ProbeReport): { kind: string }
  toggleAdvancedField(id: string): void
  submitAdvancedForm(): { kind: string }
  backFromAdvanced(): { kind: string }
}

interface AppInternals {
  connectFlow?: FlowAccess
  connectInput: string
  connectCursor: number
  connectFormFieldIndex: number
  connectEditActiveAt: number
  connectCaret: { row: number; col: number } | null
  connectCursorVisibleNow(): boolean
  startConnect(): void
  registerOverlays(data: Record<string, never>): void
  advanceConnect(result: unknown): void
  handleOverlayKey(k: { name: string; char?: string; ctrl?: boolean }): boolean
  overlayController: { nav(): { connectIndex: number } }
}

const internals = (app: unknown): AppInternals => app as AppInternals

const PAYG_URL = 'https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const PAYG_TEMPLATE = 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'

function probeReport(models: string[]): ProbeReport {
  return { models, modelsOk: true, completionOk: true, hints: {}, errors: [] }
}

/** 白盒驱动到 preset-models 多选步（不发起真实网络探测）。 */
function toModelsStep(app: unknown): AppInternals {
  const a = internals(app)
  a.registerOverlays({})
  a.startConnect()
  a.advanceConnect(a.connectFlow!.submitChoice('dashscope'))
  a.advanceConnect(a.connectFlow!.submitChoice('payg'))
  a.advanceConnect(a.connectFlow!.submitInput('sk-test'))
  // preset-endpoint：提交 URL 返回 probe——绕过 advanceConnect 直接回灌探测结果。
  a.connectFlow!.submitInput(PAYG_URL)
  a.advanceConnect(a.connectFlow!.applyProbe(probeReport(['qwen3.8-max', 'qwen-flash-new', 'qwen-mini-new'])))
  a.advanceConnect(a.connectFlow!.submitChoice('continue'))
  assert.equal(a.connectFlow!.view().kind, 'multi-choice')
  return a
}

describe('connect wizard · 列表步光标与预填', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-connect-list-'))
    process.env.RIVET_HOME = home
  })

  afterEach(() => {
    delete process.env.RIVET_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('preset-endpoint 预填模板地址进编辑缓冲（可编辑实体）', () => {
    const a = internals(makeApp().app)
    a.registerOverlays({})
    a.startConnect()
    a.advanceConnect(a.connectFlow!.submitChoice('dashscope'))
    a.advanceConnect(a.connectFlow!.submitChoice('payg'))
    a.advanceConnect(a.connectFlow!.submitInput('sk-test'))
    assert.equal(a.connectFlow!.view().defaultValue, PAYG_TEMPLATE)
    assert.equal(a.connectInput, PAYG_TEMPLATE, '预填地址必须进输入缓冲，而不是灰底占位符')
  })

  it('空格勾选后光标停在原位', () => {
    const { app } = makeApp()
    const a = toModelsStep(app)
    const nav = a.overlayController.nav()
    nav.connectIndex = 1
    const before = a.connectFlow!.view().options?.[1]?.checked
    a.handleOverlayKey({ name: 'space', char: ' ' })
    assert.equal(a.connectFlow!.view().kind, 'multi-choice', '勾选不推进步骤')
    assert.equal(nav.connectIndex, 1, '光标不得回落到第一项')
    assert.equal(a.connectFlow!.view().options?.[1]?.checked, !before, '复选框已翻转')
  })

  it('Ctrl+A 全选后光标停在原位', () => {
    const { app } = makeApp()
    const a = toModelsStep(app)
    const nav = a.overlayController.nav()
    nav.connectIndex = 2
    a.handleOverlayKey({ name: 'ctrl_a', char: '' })
    assert.equal(a.connectFlow!.view().kind, 'multi-choice')
    assert.equal(nav.connectIndex, 2, '全选不得重置光标')
    assert.ok(a.connectFlow!.view().options?.every(o => o.checked), '过滤后全部勾选')
  })

  it('方向键导航照常移动光标', () => {
    const { app } = makeApp()
    const a = toModelsStep(app)
    const nav = a.overlayController.nav()
    nav.connectIndex = 1
    a.handleOverlayKey({ name: 'down', char: '' })
    assert.equal(nav.connectIndex, 2)
    a.handleOverlayKey({ name: 'up', char: '' })
    assert.equal(nav.connectIndex, 1)
  })
})

/** 白盒驱动到 preset-endpoint 输入步（预填模板地址）。 */
function toEndpointStep(app: unknown): AppInternals {
  const a = internals(app)
  a.registerOverlays({})
  a.startConnect()
  a.advanceConnect(a.connectFlow!.submitChoice('dashscope'))
  a.advanceConnect(a.connectFlow!.submitChoice('payg'))
  a.advanceConnect(a.connectFlow!.submitInput('sk-test'))
  assert.equal(a.connectFlow!.view().kind, 'input')
  return a
}

describe('connect wizard · 输入光标移动与闪烁', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-connect-cursor-'))
    process.env.RIVET_HOME = home
  })

  afterEach(() => {
    delete process.env.RIVET_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('预填后光标停在文本末尾且未激活闪烁', () => {
    const a = toEndpointStep(makeApp().app)
    assert.equal(a.connectInput, PAYG_TEMPLATE)
    assert.equal(a.connectCursor, PAYG_TEMPLATE.length)
    assert.equal(a.connectEditActiveAt, 0, '静止预填不激活闪烁')
    assert.equal(a.connectCursorVisibleNow(), true, '静止时光标常亮')
  })

  it('←/→ 移动光标并在两端收敛', () => {
    const a = toEndpointStep(makeApp().app)
    const len = PAYG_TEMPLATE.length
    a.handleOverlayKey({ name: 'left', char: '' })
    a.handleOverlayKey({ name: 'left', char: '' })
    a.handleOverlayKey({ name: 'left', char: '' })
    assert.equal(a.connectCursor, len - 3)
    a.handleOverlayKey({ name: 'right', char: '' })
    assert.equal(a.connectCursor, len - 2)
    for (let i = 0; i < 10; i++) a.handleOverlayKey({ name: 'right', char: '' })
    assert.equal(a.connectCursor, len, '右端收敛到缓冲末尾')
    for (let i = 0; i < len + 10; i++) a.handleOverlayKey({ name: 'left', char: '' })
    assert.equal(a.connectCursor, 0, '左端收敛到 0')
  })

  it('光标处插入字符、退格删除光标前一字符', () => {
    const a = toEndpointStep(makeApp().app)
    const buf = PAYG_TEMPLATE
    a.handleOverlayKey({ name: 'left', char: '' })
    a.handleOverlayKey({ name: 'left', char: '' })
    a.handleOverlayKey({ name: '', char: 'X' })
    assert.equal(a.connectInput, buf.slice(0, buf.length - 2) + 'X' + buf.slice(buf.length - 2), '在光标处插入')
    assert.equal(a.connectCursor, buf.length - 1)
    a.handleOverlayKey({ name: 'backspace', char: '' })
    assert.equal(a.connectInput, buf, '退格删掉的正是刚插入的字符')
    assert.equal(a.connectCursor, buf.length - 2)
  })

  it('bracketed paste inserts at the cursor and leaves it after the pasted text', async () => {
    const { app, stdin } = makeApp()
    const a = toEndpointStep(app)
    const before = a.connectInput
    a.handleOverlayKey({ name: 'left', char: '' })
    a.handleOverlayKey({ name: 'left', char: '' })
    const cursorBefore = a.connectCursor
    stdin.dataHandler?.('\x1B[200~PASTED\x1B[201~')
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(a.connectInput, before.slice(0, cursorBefore) + 'PASTED' + before.slice(cursorBefore))
    assert.equal(a.connectCursor, cursorBefore + 'PASTED'.length)
    a.handleOverlayKey({ name: '', char: 'X' })
    assert.equal(a.connectInput, before.slice(0, cursorBefore) + 'PASTEDX' + before.slice(cursorBefore))
  })

  it('移动激活闪烁：首 500ms 常亮、之后每 500ms 翻转、激活后持续闪烁', () => {
    const a = toEndpointStep(makeApp().app)
    a.handleOverlayKey({ name: 'left', char: '' })
    assert.ok(a.connectEditActiveAt > 0, '移动激活闪烁')
    assert.equal(a.connectCursorVisibleNow(), true, '激活后第一个 500ms 窗可见')
    a.connectEditActiveAt = Date.now() - 750
    assert.equal(a.connectCursorVisibleNow(), false, '第二个 500ms 窗隐藏')
    a.connectEditActiveAt = Date.now() - 1250
    assert.equal(a.connectCursorVisibleNow(), true, '第三个 500ms 窗可见')
    a.connectEditActiveAt = Date.now() - 2750
    assert.equal(a.connectCursorVisibleNow(), false, '激活后持续闪烁，无闲置回落')
  })
})

/** 白盒驱动到未知模型补参表单步（单个未知模型，勾选后确认进入）。 */
function toUnknownFormStep(app: unknown): AppInternals {
  const a = internals(app)
  a.registerOverlays({})
  a.startConnect()
  a.advanceConnect(a.connectFlow!.submitChoice('dashscope'))
  a.advanceConnect(a.connectFlow!.submitChoice('payg'))
  a.advanceConnect(a.connectFlow!.submitInput('sk-test'))
  a.connectFlow!.submitInput(PAYG_URL)
  a.advanceConnect(a.connectFlow!.applyProbe(probeReport(['mystery-model-x'])))
  a.advanceConnect(a.connectFlow!.submitChoice('continue'))
  // preset 模板模型会自动并进列表——按 label 定位未知模型，移光标过去勾上再确认。
  const options = a.connectFlow!.view().options ?? []
  const unknownIdx = options.findIndex(o => o.label === 'mystery-model-x')
  assert.ok(unknownIdx >= 0, '探测发现的未知模型应出现在列表')
  a.overlayController.nav().connectIndex = unknownIdx
  a.handleOverlayKey({ name: 'space', char: ' ' })
  a.handleOverlayKey({ name: 'return', char: '' })
  assert.equal(a.connectFlow!.view().kind, 'form')
  return a
}

describe('connect wizard · 未知模型补参单步表单', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-connect-form-'))
    process.env.RIVET_HOME = home
  })

  afterEach(() => {
    delete process.env.RIVET_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('勾选确认后进入表单步：字段排列、光标落首字段末尾、硬件 caret 就位', () => {
    const a = toUnknownFormStep(makeApp().app)
    const fields = a.connectFlow!.view().fields ?? []
    assert.deepEqual(fields.map(f => f.id), ['contextWindow', 'maxTokens', 'template'])
    assert.equal(a.connectFormFieldIndex, 0)
    assert.equal(a.connectCursor, fields[0]!.value.length, '光标落首个可编辑字段末尾')
    assert.ok(a.connectCaret, '表单行放置硬件光标')
  })

  it('数字键末尾追加、↓ 换字段且换字段复位为常亮', () => {
    const a = toUnknownFormStep(makeApp().app)
    a.handleOverlayKey({ name: '', char: '9' })
    assert.equal((a.connectFlow!.view().fields ?? [])[0]!.value, '1310729', '在光标（末尾）追加')
    assert.ok(a.connectEditActiveAt > 0, '编辑激活闪烁')
    a.handleOverlayKey({ name: 'down', char: '' })
    assert.equal(a.connectFormFieldIndex, 1)
    assert.equal(a.connectEditActiveAt, 0, '换字段回到静止常亮')
    assert.equal(a.connectCursor, (a.connectFlow!.view().fields ?? [])[1]!.value.length)
  })

  it('能力模板 toggle 字段：空格在通用/推理间切换', () => {
    const a = toUnknownFormStep(makeApp().app)
    a.handleOverlayKey({ name: 'down', char: '' })
    a.handleOverlayKey({ name: 'down', char: '' })
    const before = (a.connectFlow!.view().fields ?? [])[2]!.value
    a.handleOverlayKey({ name: 'space', char: ' ' })
    const after = (a.connectFlow!.view().fields ?? [])[2]!.value
    assert.notEqual(before, after, '空格切换模板')
    assert.match(after, /推理/)
  })

  it('Enter 默认提交进能力检测；Esc 返回模型选择', () => {
    const a = toUnknownFormStep(makeApp().app)
    a.handleOverlayKey({ name: 'escape', char: '' })
    assert.equal(a.connectFlow!.view().kind, 'multi-choice', 'Esc = 返回模型选择（非取消向导）')
    a.handleOverlayKey({ name: 'return', char: '' }) // 再次确认勾选集
    assert.equal(a.connectFlow!.view().kind, 'form')
    a.handleOverlayKey({ name: 'return', char: '' })
    assert.match(a.connectFlow!.view().title, /能力检测/, '默认补参后进入能力检测步')
  })
})

describe('connect wizard · 搜索框 caret 与闪烁联动', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-connect-filter-'))
    process.env.RIVET_HOME = home
  })

  afterEach(() => {
    delete process.env.RIVET_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('空时光标停句首不闪；输入激活闪烁、caret 贴查询末尾；清空停止闪烁', () => {
    const a = toModelsStep(makeApp().app)
    assert.ok(a.connectCaret, '搜索行放置硬件 caret')
    assert.equal(a.connectCaret!.col, 5, '空时 caret 停在占位符前方（句首）')
    assert.equal(a.connectEditActiveAt, 0, '空时不闪烁')
    a.handleOverlayKey({ name: '', char: 'q' })
    assert.equal(a.connectCaret!.col, 6, 'caret 贴查询末尾（行宽不变）')
    assert.ok(a.connectEditActiveAt > 0, '有字符输入即开始闪烁')
    a.handleOverlayKey({ name: 'backspace', char: '' })
    assert.equal(a.connectEditActiveAt, 0, '清空后停止闪烁、恢复占位符常亮')
    assert.equal(a.connectCaret!.col, 5)
  })
})
