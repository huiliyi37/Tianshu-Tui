/**
 * /connect 草稿机制的 engine 层测试 — startConnect 读盘提示、Esc 落盘、
 * commit 成功/失败对草稿的去留。走白盒：通过类型 cast 访问私有成员驱动。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeApp } from './_harness.js'
import { saveConnectDraft, readConnectDraft, type ConnectDraft } from '../../connect-draft.js'
import { connectDraftPath } from '../../../config/paths.js'
import { writeSecret, readSecret } from '../../../config/secrets-store.js'
import { DIY_PENDING_KEY_REF } from '../../connect-flow.js'

interface FlowAccess {
  view(): { kind: string; title: string }
  submitChoice(id: string): unknown
  submitInput(value: string): unknown
}

interface AppInternals {
  connectFlow?: FlowAccess
  connectInput: string
  advanceConnect(result: unknown): void
  cancelConnect(): void
  overlayController: { setConnectExec(fn: ((commit: unknown, summary: string) => boolean | void) | undefined): void }
}

const internals = (app: unknown): AppInternals => app as AppInternals

function sampleDraft(overrides: Partial<ConnectDraft> = {}): ConnectDraft {
  return {
    version: 1,
    savedAt: Date.now(),
    phase: 'diy-apikey',
    collected: { baseUrl: 'https://api.example.com/v1', keyRef: DIY_PENDING_KEY_REF },
    ...overrides,
  }
}

const presetCommit = {
  kind: 'commit',
  commit: { mode: 'preset', setup: { providerName: 'deepseek', preset: 'deepseek', apiKey: 'sk', makeDefault: true } },
  summary: 'test commit',
}

describe('connect draft · engine wiring', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-connect-draft-engine-'))
    process.env.RIVET_HOME = home
  })

  afterEach(() => {
    delete process.env.RIVET_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('Esc before the key is saved creates no draft (pure cancel)', () => {
    const { app } = makeApp()
    const a = internals(app)
    app.startConnect()
    a.connectFlow!.submitChoice('custom')
    a.connectFlow!.submitChoice('openai')
    // 模拟打了半个 URL 还没回车——密钥未保存，Esc 不落草稿。
    a.connectInput = 'https://half-typed.example.com/v1'
    a.cancelConnect()
    assert.equal(existsSync(connectDraftPath(home)), false)
  })

  it('Esc on the first step creates no draft file', () => {
    const { app } = makeApp()
    app.startConnect()
    internals(app).cancelConnect()
    assert.equal(existsSync(connectDraftPath(home)), false)
  })

  it('draft on disk opens the resume prompt; resume preloads the input buffer', () => {
    writeSecret(DIY_PENDING_KEY_REF, 'sk-saved')
    saveConnectDraft(sampleDraft(), home)
    const { app } = makeApp()
    app.startConnect()
    const a = internals(app)
    assert.match(a.connectFlow!.view().title, /上次的配置进度/)
    a.advanceConnect(a.connectFlow!.submitChoice('resume'))
    assert.equal(a.connectInput, 'sk-saved')
  })

  it('Esc past the key step stores the key in secrets.json, draft keeps only the ref', () => {
    const { app } = makeApp()
    const a = internals(app)
    app.startConnect()
    a.connectFlow!.submitChoice('custom')
    a.connectFlow!.submitChoice('openai')
    a.advanceConnect(a.connectFlow!.submitInput('https://api.example.com/v1'))
    // 直接喂给 flow（不经 advanceConnect）——避免测试发起真实网络探测。
    // submitInput 已把 key 收进 collected 并进入 busy 态。
    a.connectFlow!.submitInput('sk-live-key')
    a.cancelConnect()
    const draft = readConnectDraft(home)
    assert.ok(draft)
    assert.equal(draft.collected.keyRef, DIY_PENDING_KEY_REF)
    assert.ok(!JSON.stringify(draft).includes('sk-live-key'), '草稿磁盘不得含明文密钥')
    assert.equal(readSecret(DIY_PENDING_KEY_REF), 'sk-live-key')
  })

  it('Esc on the key step saves nothing — the key was never submitted', () => {
    const { app } = makeApp()
    const a = internals(app)
    app.startConnect()
    a.connectFlow!.submitChoice('custom')
    a.connectFlow!.submitChoice('openai')
    a.advanceConnect(a.connectFlow!.submitInput('https://api.example.com/v1'))
    a.connectInput = 'sk-half-typed'
    a.cancelConnect()
    assert.equal(existsSync(connectDraftPath(home)), false)
  })

  it('Esc past the key step carries unsubmitted input on the next step', () => {
    const { app } = makeApp()
    const a = internals(app)
    app.startConnect()
    a.connectFlow!.submitChoice('deepseek')
    a.advanceConnect(a.connectFlow!.submitInput('sk-test'))
    // 端点步打了半个地址还没回车——落草稿时带上 pendingInput。
    a.connectInput = 'https://half-endpoint.example.com'
    a.cancelConnect()
    const draft = readConnectDraft(home)
    assert.ok(draft)
    assert.equal(draft.phase, 'preset-endpoint')
    assert.equal(draft.pendingInput, 'https://half-endpoint.example.com')
  })

  it('Esc on the resume prompt leaves the draft untouched', () => {
    const original = sampleDraft({ phase: 'diy-url', collected: {}, pendingInput: 'https://x.example.com' })
    saveConnectDraft(original, home)
    const { app } = makeApp()
    app.startConnect()
    internals(app).cancelConnect()
    assert.deepEqual(readConnectDraft(home), original)
  })

  it('discard then Esc clears the old draft', () => {
    saveConnectDraft(sampleDraft({ phase: 'diy-url', collected: {}, pendingInput: 'https://x.example.com' }), home)
    const { app } = makeApp()
    app.startConnect()
    const a = internals(app)
    a.advanceConnect(a.connectFlow!.submitChoice('discard'))
    a.cancelConnect()
    assert.equal(existsSync(connectDraftPath(home)), false)
  })

  it('commit success clears the draft; commit failure keeps it', () => {
    saveConnectDraft(sampleDraft(), home)
    const { app } = makeApp()
    const a = internals(app)
    app.startConnect()
    a.overlayController.setConnectExec(() => true)
    a.advanceConnect(presetCommit)
    assert.equal(existsSync(connectDraftPath(home)), false)

    saveConnectDraft(sampleDraft(), home)
    const { app: app2 } = makeApp()
    const b = internals(app2)
    app2.startConnect()
    b.overlayController.setConnectExec(() => false)
    b.advanceConnect(presetCommit)
    assert.ok(readConnectDraft(home), '失败的提交必须保留草稿')
  })
})
