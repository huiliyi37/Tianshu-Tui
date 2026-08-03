import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SettingsFlow } from '../settings-flow.js'
import type { SettingsDraft, SettingsEnv } from '../settings-model.js'

function draft(): SettingsDraft {
  return {
    workers: {
      profiles: { 'cheap-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' }, capable: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
      routing: { code_edit: 'cheap-flash', planning: 'capable' },
      patcherTier: 'cheap',
      escalationCap: 'off',
    },
    review: { profiles: {}, skipAuto: true, mechanicalFastPath: true },
    vision: null,
    visionAutoBridge: false,
    modelVision: {},
    basics: {
      toolPreset: 'minimal',
      approval: 'auto-safe',
      checkpointEveryTurns: 0,
      defaultDomain: 'qiming',
      defaultModel: '',
    },
    net: { mirrorsEnabled: false, mirrorsPreset: 'default', proxy: '', noProxy: '', searchBackends: 'bing, duckduckgo', jinaBaseUrl: 'https://r.jina.ai' },
  }
}

const env: SettingsEnv = {
  models: [
    { provider: 'deepseek', id: 'deepseek-v4-flash', supportsVision: false },
    { provider: 'deepseek', id: 'deepseek-v4-pro', supportsVision: false },
    { provider: 'minimax', id: 'MiniMax-M3', supportsVision: true },
  ],
  domains: [{ key: 'auto', name: 'Auto' }, { key: 'qiming', name: '启明' }, { key: 'tianshu', name: '天枢' }],
}

function open(): SettingsFlow {
  return new SettingsFlow(draft(), env)
}

/** Move the field cursor onto a field by id (categories must already be focused). */
function focusField(flow: SettingsFlow, id: string): void {
  flow.focusFields()
  for (let i = 0; i < 200; i++) {
    const view = flow.view()
    if (view.fields[view.fieldIndex]?.id === id) return
    flow.moveDown()
  }
  throw new Error(`field not reachable: ${id}`)
}

function gotoCategory(flow: SettingsFlow, id: string): void {
  flow.focusCategories()
  for (let i = 0; i < 20; i++) {
    const view = flow.view()
    if (view.categories[view.categoryIndex]?.id === id) return
    flow.moveDown()
  }
  throw new Error(`category not reachable: ${id}`)
}

describe('SettingsFlow navigation', () => {
  it('opens on the first category with the category column focused', () => {
    const view = open().view()
    assert.equal(view.mode, 'browse')
    assert.equal(view.focus, 'categories')
    assert.equal(view.categoryIndex, 0)
    assert.equal(view.categories[0]?.id, 'workers')
    assert.equal(view.categories.length, 5)
  })

  it('clamps the category cursor at both ends instead of wrapping', () => {
    const flow = open()
    flow.moveUp()
    assert.equal(flow.view().categoryIndex, 0)
    for (let i = 0; i < 20; i++) flow.moveDown()
    assert.equal(flow.view().categoryIndex, flow.view().categories.length - 1)
  })

  it('clamps the field cursor to the active category length', () => {
    const flow = open()
    flow.focusFields()
    for (let i = 0; i < 200; i++) flow.moveDown()
    const view = flow.view()
    assert.equal(view.fieldIndex, view.fields.length - 1)
    for (let i = 0; i < 200; i++) flow.moveUp()
    assert.equal(flow.view().fieldIndex, 0)
  })

  it('resets the field cursor when the category changes', () => {
    const flow = open()
    flow.focusFields()
    flow.moveDown()
    flow.moveDown()
    assert.equal(flow.view().fieldIndex, 2)
    flow.focusCategories()
    flow.moveDown()
    assert.equal(flow.view().fieldIndex, 0)
  })

  it('Enter on the category column descends into the fields', () => {
    const flow = open()
    flow.activate()
    assert.equal(flow.view().focus, 'fields')
  })

  it('每个字段都标注生效时机', () => {
    const flow = open()
    gotoCategory(flow, 'basics')
    const fields = flow.view().fields
    const approval = fields.find(f => f.id === 'agent.approval')
    const preset = fields.find(f => f.id === 'tools.preset')
    assert.equal(approval?.effect, 'immediate')
    assert.equal(preset?.effect, 'next-session')
  })
})

describe('SettingsFlow editing', () => {
  it('toggles a bool field in place', () => {
    const flow = open()
    gotoCategory(flow, 'review')
    focusField(flow, 'review.skipAuto')
    assert.equal(flow.view().fields[flow.view().fieldIndex]?.value, '开')
    flow.activate()
    const view = flow.view()
    assert.equal(view.mode, 'browse')
    assert.equal(view.fields[view.fieldIndex]?.value, '关')
    assert.deepEqual(flow.dirty(), ['review'])
  })

  it('opens an enum picker positioned on the current value', () => {
    const flow = open()
    gotoCategory(flow, 'basics')
    focusField(flow, 'tools.preset')
    flow.activate()
    const view = flow.view()
    assert.equal(view.mode, 'picker')
    assert.equal(view.picker?.options[view.picker.index]?.id, 'minimal')
    flow.moveDown()
    flow.activate()
    assert.equal(flow.view().mode, 'browse')
    assert.equal(flow.view().fields[flow.view().fieldIndex]?.value, 'frontend')
    assert.deepEqual(flow.dirty(), ['toolPreset'])
  })

  it('识图候选只列 supportsVision 的模型', () => {
    const flow = open()
    gotoCategory(flow, 'vision')
    focusField(flow, 'vision.model')
    flow.activate()
    const options = flow.view().picker?.options ?? []
    assert.deepEqual(options.map(o => o.id), ['', 'minimax:MiniMax-M3'])
  })

  it('rejects a bad integer and keeps the editor open', () => {
    const flow = open()
    gotoCategory(flow, 'basics')
    focusField(flow, 'agent.checkpointEveryTurns')
    flow.activate()
    assert.equal(flow.view().mode, 'editor')
    flow.clearBuffer()
    for (const ch of 'abc') flow.typeChar(ch)
    flow.activate()
    const view = flow.view()
    assert.equal(view.mode, 'editor')
    assert.match(view.error ?? '', /整数/)
    assert.deepEqual(flow.dirty(), [])
  })

  it('accepts a valid integer and closes the editor', () => {
    const flow = open()
    gotoCategory(flow, 'basics')
    focusField(flow, 'agent.checkpointEveryTurns')
    flow.activate()
    flow.clearBuffer()
    for (const ch of '5') flow.typeChar(ch)
    flow.activate()
    assert.equal(flow.view().mode, 'browse')
    assert.equal(flow.view().fields[flow.view().fieldIndex]?.value, '5')
    assert.deepEqual(flow.dirty(), ['checkpoint'])
  })

  it('识图子字段在未选模型时明确报错，而不是静默无效', () => {
    const flow = open()
    gotoCategory(flow, 'vision')
    focusField(flow, 'vision.prompt')
    flow.activate()
    for (const ch of 'hello') flow.typeChar(ch)
    flow.activate()
    assert.match(flow.view().error ?? '', /先选一个识图模型/)
    assert.deepEqual(flow.dirty(), [])
  })

  it('backspace edits the buffer by code point', () => {
    const flow = open()
    gotoCategory(flow, 'net')
    focusField(flow, 'network.proxy')
    flow.activate()
    for (const ch of '中文x') flow.typeChar(ch)
    flow.backspace()
    assert.equal(flow.view().editor?.buffer, '中文')
  })

  it('changing a value back to the original leaves nothing dirty', () => {
    const flow = open()
    gotoCategory(flow, 'review')
    focusField(flow, 'review.skipAuto')
    flow.activate()
    assert.deepEqual(flow.dirty(), ['review'])
    flow.activate()
    assert.deepEqual(flow.dirty(), [])
    assert.equal(flow.view().categories.find(c => c.id === 'review')?.dirty, false)
  })

  it('marks the owning category dirty', () => {
    const flow = open()
    gotoCategory(flow, 'workers')
    focusField(flow, 'workers.patcherTier')
    flow.activate()
    flow.moveDown()
    flow.activate()
    const view = flow.view()
    assert.equal(view.categories.find(c => c.id === 'workers')?.dirty, true)
    assert.equal(view.categories.find(c => c.id === 'basics')?.dirty, false)
  })
})

describe('SettingsFlow exit', () => {
  it('Esc closes immediately when nothing changed', () => {
    assert.equal(open().cancel(), 'closed')
  })

  it('Esc asks for confirmation when edits are unsaved', () => {
    const flow = open()
    gotoCategory(flow, 'review')
    focusField(flow, 'review.skipAuto')
    flow.activate()
    assert.equal(flow.cancel(), 'handled')
    assert.equal(flow.view().mode, 'confirm-discard')
    assert.equal(flow.isConfirmingDiscard(), true)
  })

  it('Esc on the confirmation returns to editing with the draft intact', () => {
    const flow = open()
    gotoCategory(flow, 'review')
    focusField(flow, 'review.skipAuto')
    flow.activate()
    flow.cancel()
    assert.equal(flow.cancel(), 'handled')
    assert.equal(flow.view().mode, 'browse')
    assert.deepEqual(flow.dirty(), ['review'])
  })

  it('confirming discard drops the draft', () => {
    const flow = open()
    gotoCategory(flow, 'review')
    focusField(flow, 'review.skipAuto')
    flow.activate()
    flow.cancel()
    assert.equal(flow.confirmDiscard(), 'closed')
    assert.deepEqual(flow.dirty(), [])
  })

  it('Esc inside a picker only closes the picker', () => {
    const flow = open()
    gotoCategory(flow, 'basics')
    focusField(flow, 'tools.preset')
    flow.activate()
    assert.equal(flow.cancel(), 'handled')
    assert.equal(flow.view().mode, 'browse')
  })
})

describe('SettingsFlow save handshake', () => {
  it('reports the dirty blocks and rebaselines after a successful save', () => {
    const flow = open()
    gotoCategory(flow, 'review')
    focusField(flow, 'review.skipAuto')
    flow.activate()
    gotoCategory(flow, 'basics')
    focusField(flow, 'tools.preset')
    flow.activate()
    flow.moveDown()
    flow.activate()

    const request = flow.saveRequest()
    assert.deepEqual(request.blocks.sort(), ['review', 'toolPreset'])

    flow.commitSaved({ saved: request.blocks, errors: [] })
    assert.deepEqual(flow.dirty(), [])
    assert.match(flow.view().status ?? '', /已保存 2 项/)
  })

  it('says nothing was written when there is nothing to write', () => {
    const flow = open()
    flow.commitSaved({ saved: [], errors: [] })
    assert.match(flow.view().status ?? '', /没有改动/)
  })

  it('keeps the draft dirty when the write failed', () => {
    const flow = open()
    gotoCategory(flow, 'review')
    focusField(flow, 'review.skipAuto')
    flow.activate()
    flow.commitSaved({ saved: [], errors: ['review: boom'] })
    assert.deepEqual(flow.dirty(), ['review'])
    assert.match(flow.view().error ?? '', /boom/)
  })
})
