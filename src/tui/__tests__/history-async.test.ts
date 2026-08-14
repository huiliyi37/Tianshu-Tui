import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('appendHistoryAsync serializes concurrent appends and recovers after a failed write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-history-'))
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home

  try {
    const { appendHistoryAsync } = await import('../history.js')
    const historyFile = join(home, 'history.json')

    await Promise.all([
      appendHistoryAsync('first'),
      appendHistoryAsync('second'),
    ])
    assert.deepEqual(JSON.parse(readFileSync(historyFile, 'utf8')), ['second', 'first'])

    rmSync(historyFile)
    mkdirSync(historyFile)
    await assert.rejects(appendHistoryAsync('blocked'))
    rmSync(historyFile, { recursive: true })

    await appendHistoryAsync('recovered')
    assert.deepEqual(JSON.parse(readFileSync(historyFile, 'utf8')), ['recovered'])
  } finally {
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
