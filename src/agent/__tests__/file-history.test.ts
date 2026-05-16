import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FileHistory } from '../file-history.js'

const TMP = join(import.meta.dirname, '.fh-test-tmp')
const BACKUP = join(import.meta.dirname, '.fh-test-backup')

describe('FileHistory', () => {
  let history: FileHistory

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    mkdirSync(BACKUP, { recursive: true })
    history = new FileHistory(BACKUP, 'test-session')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
  })

  it('captures backup before write and tracks file', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'original')
    await history.trackEdit(file, 'msg_1')

    writeFileSync(file, 'modified')
    const stats = await history.getDiffStats('msg_1')
    assert.ok(stats !== undefined)
    assert.ok(stats!.filesChanged.length > 0)
  })

  it('restores file to previous version', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')

    writeFileSync(file, 'v2')
    await history.trackEdit(file, 'msg_2')

    writeFileSync(file, 'v3')

    await history.rewind('msg_1')
    assert.equal(readFileSync(file, 'utf-8'), 'v1')
  })

  it('handles file that did not exist at target snapshot', async () => {
    const file = join(TMP, 'new.txt')
    // trackEdit before file exists — captures null backup
    await history.trackEdit(file, 'msg_1')
    // Then create the file
    writeFileSync(file, 'created')

    await history.rewind('msg_1')
    assert.equal(existsSync(file), false)
  })

  it('returns undefined diff stats for unknown message', async () => {
    const stats = await history.getDiffStats('nonexistent')
    assert.equal(stats, undefined)
  })

  it('reports latest snapshot id', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    assert.equal(history.getLatestSnapshotId(), 'msg_1')
  })

  it('reports hasSnapshot correctly', async () => {
    assert.equal(history.hasSnapshot('msg_1'), false)
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    assert.equal(history.hasSnapshot('msg_1'), true)
  })

  it('cleanupOrphans removes unreferenced backup files', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')

    const sessionDir = join(BACKUP, 'test-session')
    writeFileSync(join(sessionDir, 'orphan_file'), 'orphan content')

    const { readdirSync } = await import('node:fs')
    const beforeClean = readdirSync(sessionDir)
    assert.ok(beforeClean.includes('orphan_file'))

    const removed = await history.cleanupOrphans()
    assert.ok(removed >= 1)

    const afterClean = readdirSync(sessionDir)
    assert.ok(!afterClean.includes('orphan_file'))
  })
})
