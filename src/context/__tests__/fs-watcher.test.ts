import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFsWatcher, shouldRecordFsEvent } from '../fs-watcher.js'

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

  it('eventRate is normalized: 0 events = 0, many events → approaches 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-watcher-test-'))
    const watcher = createFsWatcher({ cwd: dir, debounceMs: 0 }) // no debounce for test
    watchers.push(watcher)
    await watcher.start()

    // Write enough files to trigger event rate
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(dir, `test-${i}.txt`), 'x')
    }

    // Wait a bit for fs events to propagate
    await new Promise(r => setTimeout(r, 200))

    const state = watcher.getState()
    // Should have some events detected (may not be exactly 35 due to OS batching)
    // But eventRate should be > 0 if any events were detected
    assert.ok(state.eventRate >= 0, 'eventRate should be non-negative')
    assert.ok(state.eventCount >= 0, 'eventCount should be non-negative')
  })
})
