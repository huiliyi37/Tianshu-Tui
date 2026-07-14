import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractWalkthroughStep,
  buildWalkthroughDocument,
  buildWalkthroughMarkdown,
  isApprovalHaltStep,
  createWalkthroughRecorderHooks,
  type WalkthroughStep,
} from '../walkthrough-recorder.js'
import { createRuntimeHookContext, type RuntimeHookSnapshot, type RuntimeToolEvent } from '../../runtime-hooks.js'

function snapshot(turn = 3): RuntimeHookSnapshot {
  return {
    cwd: '/tmp',
    turn,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  }
}

const META = { index: 1, turn: 3, ts: 1_700_000_000_000 }

test('extractWalkthroughStep ignores non-computer_use tools', () => {
  const tool: RuntimeToolEvent = { name: 'read_file', success: true }
  assert.equal(extractWalkthroughStep(tool, META), null)
})

test('extractWalkthroughStep captures browser_debug steps (2026-07-15)', () => {
  const nav: RuntimeToolEvent = {
    name: 'browser_debug',
    success: true,
    input: { action: 'navigate', url: 'http://localhost:3000' },
    resultContent: 'Navigated to http://localhost:3000/. Captured 12 network request(s), 0 console error(s).',
  }
  const navStep = extractWalkthroughStep(nav, META)
  assert.ok(navStep)
  assert.equal(navStep.tool, 'browser_debug')
  assert.equal(navStep.action, 'navigate')
  assert.equal(navStep.app, 'http://localhost:3000')

  const shot: RuntimeToolEvent = {
    name: 'browser_debug',
    success: true,
    input: { action: 'screenshot' },
    resultContent: 'Captured screenshot of http://localhost:3000/ → artifact browser_screenshot:aa11\nSaved: /tmp/x.png',
  }
  const shotStep = extractWalkthroughStep(shot, { ...META, index: 2 })
  assert.ok(shotStep)
  assert.equal(shotStep.screenshotArtifactId, 'browser_screenshot:aa11')
  assert.equal(shotStep.app, 'http://localhost:3000/')
})

test('extractWalkthroughStep captures action/app/screenshot/diff', () => {
  const tool: RuntimeToolEvent = {
    name: 'computer_use',
    success: true,
    input: { action: 'click', app: 'Safari', ref: 12 },
    resultContent:
      'Clicked button "Submit" (screenshot → artifact computer_use_screenshot:ab12cd34)\n'
      + 'UI changed after action (+2/-1 elements):\n+ button "OK"\n- spinner',
  }
  const step = extractWalkthroughStep(tool, META)
  assert.ok(step)
  assert.equal(step.action, 'click')
  assert.equal(step.app, 'Safari')
  assert.equal(step.success, true)
  assert.equal(step.screenshotArtifactId, 'computer_use_screenshot:ab12cd34')
  assert.match(step.uiDiff ?? '', /UI changed after action \(\+2\/-1 elements\)/)
  assert.match(step.detail ?? '', /ref=12/)
})

test('extractWalkthroughStep records failure note on error', () => {
  const tool: RuntimeToolEvent = {
    name: 'computer_use',
    success: false,
    isError: true,
    input: { action: 'type', app: 'Notes', text: 'hello' },
    resultContent: 'Tool "computer_use" (Notes) was not executed: it requires explicit user approval, which you cannot grant yourself.\nDo NOT re-emit this call.',
  }
  const step = extractWalkthroughStep(tool, META)
  assert.ok(step)
  assert.equal(step.success, false)
  assert.match(step.errorNote ?? '', /requires explicit user approval/)
  assert.equal(isApprovalHaltStep(step), true)
})

test('isApprovalHaltStep is false for ordinary failures', () => {
  const step: WalkthroughStep = {
    index: 1, turn: 1, ts: 0, action: 'click', app: 'X',
    success: false, errorNote: 'Cannot locate ref 5: element vanished',
  }
  assert.equal(isApprovalHaltStep(step), false)
})

test('buildWalkthroughDocument aggregates summary + markdown', () => {
  const steps: WalkthroughStep[] = [
    { index: 1, turn: 1, ts: 1000, action: 'launch_app', app: 'Notes', success: true },
    { index: 2, turn: 1, ts: 2000, action: 'type', app: 'Notes', success: true, uiDiff: 'UI changed after action (+1/-0 elements):' },
    { index: 3, turn: 2, ts: 3000, action: 'click', app: 'Safari', success: false, errorNote: 'requires explicit user approval' },
  ]
  const doc = buildWalkthroughDocument(steps, { sessionId: 's1', createdAt: 5000 })
  assert.equal(doc.version, 1)
  assert.equal(doc.summary.totalSteps, 3)
  assert.equal(doc.summary.failedSteps, 1)
  assert.deepEqual(doc.summary.apps, ['Notes', 'Safari'])
  assert.equal(doc.summary.halted, true)
  assert.match(doc.markdown, /运行走查/)
  assert.match(doc.markdown, /### 3\. ✗ click @ Safari/)
})

test('buildWalkthroughMarkdown lists screenshots as artifact refs', () => {
  const md = buildWalkthroughMarkdown(
    [{ index: 1, turn: 1, ts: 0, action: 'snapshot', app: 'Notes', success: true, screenshotArtifactId: 'computer_use_screenshot:x1' }],
    { sessionId: 's', createdAt: 0 },
  )
  assert.match(md, /artifact `computer_use_screenshot:x1`/)
})

test('recorder hooks: postTool accumulates, postSession saves once', async () => {
  const saved: Array<{ tool: string; target: string; rawContent: string; summary: string }> = []
  const store = { save: async (input: any) => { saved.push(input); return 'walkthrough:1' } }
  const [postTool, postSession] = createWalkthroughRecorderHooks({
    getArtifactStore: () => store,
    sessionId: 'sess-9',
    now: () => 42,
  })

  const ctx = createRuntimeHookContext(snapshot(7))
  await postTool.run(ctx, {
    name: 'computer_use', success: true,
    input: { action: 'click', app: 'Finder' },
    resultContent: 'Clicked (screenshot → artifact computer_use_screenshot:zz)',
  })
  await postTool.run(ctx, { name: 'bash', success: true })

  await postSession.run(ctx)
  await postSession.run(ctx) // idempotent — second flush must not duplicate

  assert.equal(saved.length, 1)
  assert.equal(saved[0]!.tool, 'walkthrough')
  assert.equal(saved[0]!.target, 'run-walkthrough.json')
  const doc = JSON.parse(saved[0]!.rawContent)
  assert.equal(doc.sessionId, 'sess-9')
  assert.equal(doc.summary.totalSteps, 1)
  assert.equal(doc.steps[0].turn, 7)
  assert.equal(doc.steps[0].screenshotArtifactId, 'computer_use_screenshot:zz')
})

test('recorder hooks: no computer_use activity → no artifact', async () => {
  let saves = 0
  const [postTool, postSession] = createWalkthroughRecorderHooks({
    getArtifactStore: () => ({ save: async () => { saves++; return 'x' } }),
  })
  const ctx = createRuntimeHookContext(snapshot())
  await postTool.run(ctx, { name: 'grep', success: true })
  await postSession.run(ctx)
  assert.equal(saves, 0)
})
