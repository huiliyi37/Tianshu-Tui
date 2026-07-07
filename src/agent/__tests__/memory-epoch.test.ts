import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CURRENT_MEMORY_EPOCH,
  memoryEpochMarkerPath,
  resetLegacyMemoryIfNeeded,
} from '../memory-epoch.js'

describe('memory-epoch reset', () => {
  let cwd: string
  let markerBase: string

  const seedLegacyFiles = (): void => {
    mkdirSync(join(cwd, '.rivet', 'knowledge'), { recursive: true })
    writeFileSync(join(cwd, '.rivet', 'playbook.jsonl'), '{"id":"pb_junk","lesson":"垃圾教训"}\n')
    writeFileSync(join(cwd, '.rivet', 'recovery-journal.jsonl'), '{"file":"a.md","action":"write","linesLost":0,"ts":"2026-07-06T00:00:00Z"}\n')
    writeFileSync(join(cwd, '.rivet', 'knowledge', 'advisory-efficacy.jsonl'), '{"key":"self-verify","delivered":34}\n')
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'memepoch-cwd-'))
    markerBase = mkdtempSync(join(tmpdir(), 'memepoch-marker-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(markerBase, { recursive: true, force: true })
  })

  it('首次运行清空存量教训文件并写标记', () => {
    seedLegacyFiles()
    const result = resetLegacyMemoryIfNeeded(cwd, { markerBase })

    assert.equal(result.skipped, false)
    assert.deepEqual(result.cleared.sort(), [
      '.rivet/knowledge/advisory-efficacy.jsonl',
      '.rivet/playbook.jsonl',
      '.rivet/recovery-journal.jsonl',
    ])
    assert.equal(existsSync(join(cwd, '.rivet', 'playbook.jsonl')), false)
    assert.equal(existsSync(join(cwd, '.rivet', 'recovery-journal.jsonl')), false)
    assert.equal(existsSync(join(cwd, '.rivet', 'knowledge', 'advisory-efficacy.jsonl')), false)

    const marker = JSON.parse(readFileSync(memoryEpochMarkerPath(cwd, markerBase), 'utf-8'))
    assert.equal(marker.epoch, CURRENT_MEMORY_EPOCH)
  })

  it('标记已是当前 epoch 时跳过（不重复清理）', () => {
    seedLegacyFiles()
    resetLegacyMemoryIfNeeded(cwd, { markerBase })

    // 用户升级后又攒了新数据——同 epoch 内不再清
    writeFileSync(join(cwd, '.rivet', 'playbook.jsonl'), '{"id":"pb_new"}\n')
    const second = resetLegacyMemoryIfNeeded(cwd, { markerBase })

    assert.equal(second.skipped, true)
    assert.deepEqual(second.cleared, [])
    assert.equal(existsSync(join(cwd, '.rivet', 'playbook.jsonl')), true)
  })

  it('全新安装（无任何存量文件）只落标记，不报错', () => {
    const result = resetLegacyMemoryIfNeeded(cwd, { markerBase })

    assert.equal(result.skipped, false)
    assert.deepEqual(result.cleared, [])
    assert.equal(existsSync(memoryEpochMarkerPath(cwd, markerBase)), true)
  })

  it('调用 clearMistakeEntries 回调并计入 cleared', () => {
    let dbCleared = false
    const result = resetLegacyMemoryIfNeeded(cwd, {
      markerBase,
      clearMistakeEntries: () => { dbCleared = true },
    })

    assert.equal(dbCleared, true)
    assert.ok(result.cleared.includes('meridian.db:mistake_entries'))
  })

  it('clearMistakeEntries 抛错不影响文件清理与标记落盘', () => {
    seedLegacyFiles()
    const result = resetLegacyMemoryIfNeeded(cwd, {
      markerBase,
      clearMistakeEntries: () => { throw new Error('better-sqlite3 not installed') },
    })

    assert.equal(result.skipped, false)
    assert.ok(result.cleared.includes('.rivet/playbook.jsonl'))
    assert.equal(result.cleared.includes('meridian.db:mistake_entries'), false)
    assert.equal(existsSync(memoryEpochMarkerPath(cwd, markerBase)), true)
  })

  it('损坏的标记文件按未清理处理（重清一遍，幂等）', () => {
    seedLegacyFiles()
    const markerPath = memoryEpochMarkerPath(cwd, markerBase)
    mkdirSync(join(markerBase, 'memory-epoch'), { recursive: true })
    writeFileSync(markerPath, 'not-json{{{')

    const result = resetLegacyMemoryIfNeeded(cwd, { markerBase })
    assert.equal(result.skipped, false)
    assert.equal(existsSync(join(cwd, '.rivet', 'playbook.jsonl')), false)
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'))
    assert.equal(marker.epoch, CURRENT_MEMORY_EPOCH)
  })
})
