import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LWTGuard } from '../lwt-guard.js'

describe('LWTGuard', () => {
  let tempDir: string
  let guard: LWTGuard

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lwt-test-'))
    guard = new LWTGuard({ stateDir: tempDir })
  })

  afterEach(() => {
    guard.releaseLock()
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('checkPreviousCrash', () => {
    it('returns null when no alive file exists', () => {
      assert.equal(guard.checkPreviousCrash(), null)
    })

    it('returns session ID when alive file exists and process not running', () => {
      const marker = {
        sessionId: 'test-session-123',
        pid: 99999, // 不太可能存在的 PID
        startedAt: new Date().toISOString(),
      }
      writeFileSync(join(tempDir, 'agent.alive'), JSON.stringify(marker))

      assert.equal(guard.checkPreviousCrash(), 'test-session-123')
    })

    it('returns null when alive file exists and process is running', () => {
      const marker = {
        sessionId: 'test-session-123',
        pid: process.pid, // 当前进程
        startedAt: new Date().toISOString(),
      }
      writeFileSync(join(tempDir, 'agent.alive'), JSON.stringify(marker))

      assert.equal(guard.checkPreviousCrash(), null)
    })

    it('handles corrupted alive file', () => {
      writeFileSync(join(tempDir, 'agent.alive'), 'invalid json')

      assert.equal(guard.checkPreviousCrash(), null)
    })
  })

  describe('acquireLock', () => {
    it('acquires lock when no lock file exists', () => {
      assert.equal(guard.acquireLock(), true)
    })

    it('writes pid into the atomically-created lock file', () => {
      assert.equal(guard.acquireLock(), true)
      assert.equal(readFileSync(join(tempDir, 'agent.lock'), 'utf-8'), String(process.pid))
    })

    it('fails to acquire lock when lock file exists and process is running', () => {
      writeFileSync(join(tempDir, 'agent.lock'), String(process.pid))

      assert.equal(guard.acquireLock(), false)
    })

    it('acquires lock when lock file exists but process is dead', () => {
      writeFileSync(join(tempDir, 'agent.lock'), '99999')

      assert.equal(guard.acquireLock(), true)
    })
  })

  describe('register and clear', () => {
    it('creates alive file on register', () => {
      guard.register('test-session')

      assert.ok(existsSync(join(tempDir, 'agent.alive')))
      const data = JSON.parse(readFileSync(join(tempDir, 'agent.alive'), 'utf-8'))
      assert.equal(data.sessionId, 'test-session')
      assert.equal(data.pid, process.pid)
    })

    it('removes alive file on clear', () => {
      guard.register('test-session')
      guard.clear()

      assert.ok(!existsSync(join(tempDir, 'agent.alive')))
    })

    it('does not register twice', () => {
      guard.register('session-1')
      guard.register('session-2') // 应该被忽略

      const data = JSON.parse(readFileSync(join(tempDir, 'agent.alive'), 'utf-8'))
      assert.equal(data.sessionId, 'session-1')
    })
  })
})
