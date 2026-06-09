import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFsEventRecorder, createFsWatcher, shouldRecordFsEvent } from '../fs-watcher.js'

describe('FsWatcher — 原则③ 参考系锚定', () => {
  let watchers: Array<{ stop: () => void }> = []

  afterEach(() => {
    for (const w of watchers) w.stop()
    watchers = []
  })

  it('filters only classifiable silent paths and fails unknown toward signal', () => {
    assert.equal(shouldRecordFsEvent('layout.log'), false)
    assert.equal(shouldRecordFsEvent('node_modules/pkg/index.js'), false)
    assert.equal(shouldRecordFsEvent('.codex/hooks.json'), false)
    assert.equal(shouldRecordFsEvent('src/context/fs-watcher.ts'), true)
    assert.equal(shouldRecordFsEvent('docs/teamtask/T7-天枢注意力闸·运行碎片识别层.md'), true)
    assert.equal(shouldRecordFsEvent(undefined), true)
  })

  it('treats watched subdirectory filenames as repository-relative paths', () => {
    assert.equal(shouldRecordFsEvent('docs/teamtask.zip'), false)
    assert.equal(shouldRecordFsEvent('docs/teamtask/T7-落地实施方案·注意力闸分阶段执行.md'), true)
  })

  it('does not count classifiable L1/L2/L0 events but counts content and unknown events', () => {
    let t = 10_000
    const recorder = createFsEventRecorder({ debounceMs: 0, now: () => t++ })

    for (let i = 0; i < 10; i++) recorder.recordEvent('layout.log')
    recorder.recordEvent('.codex/hooks.json')
    recorder.recordEvent('node_modules/pkg/index.js')
    assert.equal(recorder.getEventCount(), 0)
    assert.equal(recorder.getEventRate(), 0)

    recorder.recordEvent('src/context/fs-watcher.ts')
    assert.equal(recorder.getEventCount(), 1)

    recorder.recordEvent(undefined)
    assert.equal(recorder.getEventCount(), 2)
  })

  it('does not count watched subdirectory runtime artifacts when recorder sees repo-relative paths', () => {
    let t = 20_000
    const recorder = createFsEventRecorder({ debounceMs: 0, now: () => t++ })

    recorder.recordEvent('docs/output.log')
    recorder.recordEvent('docs/teamtask.zip')
    assert.equal(recorder.getEventCount(), 0)

    recorder.recordEvent('docs/teamtask/T7-落地实施方案·注意力闸分阶段执行.md')
    assert.equal(recorder.getEventCount(), 1)
  })

  it('starts and reports zero event rate initially', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)
    await watcher.start()

    const state = watcher.getState()
    assert.equal(state.eventRate, 0)
    assert.equal(state.eventCount, 0)
    assert.equal(state.active, true)
  })

  it('stop() resets state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)
    await watcher.start()
    watcher.stop()

    const state = watcher.getState()
    assert.equal(state.active, false)
    assert.equal(state.eventCount, 0)
  })

  it('getState normalizes eventRate to [0, 1]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)

    // Even without starting, getState should work
    const state = watcher.getState()
    assert.ok(state.eventRate >= 0 && state.eventRate <= 1)
  })

  it('start() is idempotent — double start does not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir })
    watchers.push(watcher)
    await watcher.start()
    await watcher.start() // should not throw
    assert.equal(watcher.getState().active, true)
  })

  it('handles non-existent directory gracefully', async () => {
    const watcher = createFsWatcher({ cwd: '/nonexistent/path/xyz' })
    watchers.push(watcher)
    await watcher.start() // should not throw
    // watcher may or may not be active depending on OS — but should not crash
    const state = watcher.getState()
    assert.ok(typeof state.eventRate === 'number')
  })

  it('recorder normalizes eventRate: 0 events = 0, many content events → approaches 1', () => {
    let t = 30_000
    const recorder = createFsEventRecorder({ debounceMs: 0, now: () => t++ })

    assert.equal(recorder.getEventRate(), 0)
    assert.equal(recorder.getEventCount(), 0)

    for (let i = 0; i < 35; i++) {
      recorder.recordEvent(`src/test-${i}.txt`)
    }

    assert.equal(recorder.getEventCount(), 35)
    assert.equal(recorder.getEventRate(), 1)
  })
})
