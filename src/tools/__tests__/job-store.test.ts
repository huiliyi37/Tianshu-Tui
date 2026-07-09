import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionJobs, type JobEvent } from '../job-store.js'

// These tests spawn real short-lived shell commands via the platform shell
// (sh -c on POSIX). They assume a POSIX-ish shell — consistent with the rest of
// the bash tool tests in this suite.

const env = { ...process.env }

function makeStore(): { store: SessionJobs; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-jobs-'))
  return { store: new SessionJobs(join(dir, 'jobs')), dir }
}

describe('SessionJobs', () => {
  let dir = ''
  let store: SessionJobs

  before(() => {
    const m = makeStore()
    store = m.store
    dir = m.dir
  })

  after(() => {
    store.killAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawn returns a running snapshot immediately and lists it', () => {
    const snap = store.spawn({ command: "sh -c 'sleep 1'", rawCommand: 'sleep 1', cwd: dir, env })
    assert.equal(snap.status, 'running')
    assert.ok(snap.id.length > 0)
    const list = store.list()
    assert.ok(list.some((j) => j.id === snap.id))
  })

  it('await resolves when the process exits, with exit code and tail', async () => {
    const snap = store.spawn({ command: "echo done-marker", rawCommand: 'echo done-marker', cwd: dir, env })
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'exited')
    assert.equal(res!.job.exitCode, 0)
    assert.match(res!.tail, /done-marker/)
  })

  it('await resolves early when output matches the pattern', async () => {
    const snap = store.spawn({
      command: "sh -c 'echo READY; sleep 3'",
      rawCommand: 'server',
      cwd: dir,
      env,
    })
    const res = await store.await(snap.id, { pattern: 'READY', timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.matched, true)
    assert.equal(res!.timedOut, false)
    // Process is still running — pattern matched before exit.
    assert.equal(res!.job.status, 'running')
    store.kill(snap.id)
  })

  it('await times out while the process keeps running', async () => {
    const snap = store.spawn({ command: "sh -c 'sleep 3'", rawCommand: 'sleep 3', cwd: dir, env })
    const res = await store.await(snap.id, { timeoutMs: 120 })
    assert.ok(res)
    assert.equal(res!.timedOut, true)
    assert.equal(res!.matched, false)
    store.kill(snap.id)
  })

  it('kill terminates a running job and marks it killed', async () => {
    const snap = store.spawn({ command: "sh -c 'sleep 10'", rawCommand: 'sleep 10', cwd: dir, env })
    assert.equal(store.kill(snap.id), true)
    // Give the signal a moment to land + close event to fire.
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'killed')
  })

  it('auto-kills a job that exceeds its max lifetime', async () => {
    const snap = store.spawn({
      command: "sh -c 'sleep 30'",
      rawCommand: 'sleep 30',
      cwd: dir,
      env,
      maxLifetimeMs: 150,
    })
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'killed')
    assert.match(res!.tail, /exceeded max lifetime/)
  })

  it('does not cap lifetime when maxLifetimeMs is absent', async () => {
    const snap = store.spawn({ command: "sh -c 'sleep 1'", rawCommand: 'sleep 1', cwd: dir, env })
    // No lifetime cap → the job runs to natural completion (exit, not killed).
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'exited')
  })

  it('await on an unknown job id returns null', async () => {
    const res = await store.await('does-not-exist', { timeoutMs: 10 })
    assert.equal(res, null)
  })

  it('emits started and exit events; writes a log file', async () => {
    const events: JobEvent[] = []
    store.on('event', (ev: JobEvent) => events.push(ev))
    const snap = store.spawn({ command: 'echo hi-there', rawCommand: 'echo hi-there', cwd: dir, env })
    await store.await(snap.id, { timeoutMs: 5000 })
    // exit event may be followed by a final flush; poll briefly for it.
    await new Promise((r) => setTimeout(r, 50))
    const kinds = events.filter((e) => e.job.id === snap.id).map((e) => e.kind)
    assert.ok(kinds.includes('started'), 'expected a started event')
    assert.ok(kinds.includes('exit'), 'expected an exit event')
    assert.ok(existsSync(join(dir, 'jobs', `${snap.id}.log`)), 'expected a log file on disk')
  })

  it('killAll terminates every running job', async () => {
    const a = store.spawn({ command: "sh -c 'sleep 10'", rawCommand: 'sleep 10', cwd: dir, env })
    const b = store.spawn({ command: "sh -c 'sleep 10'", rawCommand: 'sleep 10', cwd: dir, env })
    store.killAll()
    await store.await(a.id, { timeoutMs: 5000 })
    await store.await(b.id, { timeoutMs: 5000 })
    const list = store.list()
    assert.equal(list.filter((j) => j.status === 'running').length, 0)
    assert.equal(store.hasRunning(), false)
  })
})
