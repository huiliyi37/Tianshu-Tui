import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAuthorities, createGeneralLedgerHook } from '../general-ledger-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function seededCwd(slugs: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), 'ledger-hook-'))
  mkdirSync(join(cwd, '.rivet/generals'), { recursive: true })
  for (const slug of slugs) {
    writeFileSync(join(cwd, `.rivet/generals/${slug}.md`), `# 将星\n\n### some-family | recurrenceCount: 1 | lastSeen: 2026-07-04\n`)
  }
  return cwd
}

function makeCtx(cwd: string): RuntimeHookContext {
  return {
    snapshot: { cwd, turn: 3, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function delegateEvent(input: Record<string, unknown>, name = 'delegate_task', success = true): RuntimeToolEvent {
  return { name, success, input } as unknown as RuntimeToolEvent
}

describe('general-ledger-hook (G2 记账触发面)', () => {
  describe('collectAuthorities', () => {
    it('collects top-level authority (delegate_task) and per-task authorities (delegate_batch)', () => {
      assert.deepEqual(collectAuthorities({ authority: 'yaoguang' }), ['yaoguang'])
      assert.deepEqual(
        collectAuthorities({ tasks: [{ authority: 'tianliang' }, { authority: 'yaoguang' }, { objective: 'x' }] }),
        ['tianliang', 'yaoguang'],
      )
      assert.deepEqual(collectAuthorities(undefined), [])
      assert.deepEqual(collectAuthorities({}), [])
    })
  })

  it('fires an informational advisory when a ledger-backed authority completes', () => {
    const cwd = seededCwd(['yaoguang'])
    const entries: AdvisoryEntry[] = []
    const hook = createGeneralLedgerHook({ advisoryBus: { submit: e => { entries.push(e as AdvisoryEntry) } } })

    hook.run(makeCtx(cwd), delegateEvent({ authority: 'yaoguang', objective: 'review it' }))

    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.key, 'general-ledger-writeback')
    assert.equal(entries[0]!.tier, 'informational')
    assert.ok(entries[0]!.content.includes('record_general_finding'))
    assert.ok(entries[0]!.content.includes('yaoguang'))
  })

  it('stays silent when the authority has no ledger on disk', () => {
    const cwd = seededCwd([]) // 目录存在但无账本
    const entries: AdvisoryEntry[] = []
    const hook = createGeneralLedgerHook({ advisoryBus: { submit: e => { entries.push(e as AdvisoryEntry) } } })

    hook.run(makeCtx(cwd), delegateEvent({ authority: 'tianquan' }))
    assert.equal(entries.length, 0)
  })

  it('stays silent for non-delegate tools, failed delegates, and missing authority', () => {
    const cwd = seededCwd(['yaoguang'])
    const entries: AdvisoryEntry[] = []
    const hook = createGeneralLedgerHook({ advisoryBus: { submit: e => { entries.push(e as AdvisoryEntry) } } })

    hook.run(makeCtx(cwd), { name: 'read_file', success: true, input: { authority: 'yaoguang' } } as unknown as RuntimeToolEvent)
    hook.run(makeCtx(cwd), delegateEvent({ authority: 'yaoguang' }, 'delegate_task', false))
    hook.run(makeCtx(cwd), delegateEvent({ objective: 'no authority' }))
    assert.equal(entries.length, 0)
  })

  it('reminds at most once per star per session (repeat delegates stay silent)', () => {
    const cwd = seededCwd(['yaoguang', 'tanlang'])
    const entries: AdvisoryEntry[] = []
    const hook = createGeneralLedgerHook({ advisoryBus: { submit: e => { entries.push(e as AdvisoryEntry) } } })

    hook.run(makeCtx(cwd), delegateEvent({ authority: 'yaoguang' }))
    hook.run(makeCtx(cwd), delegateEvent({ authority: 'yaoguang' }))
    assert.equal(entries.length, 1, 'same star reminded once')

    // 不同星（贪狼是 EXTRA slug，非 star-domain）仍可触发一次
    hook.run(makeCtx(cwd), delegateEvent({ authority: 'tanlang' }))
    assert.equal(entries.length, 2)

    hook.resetRemindedStars()
    hook.run(makeCtx(cwd), delegateEvent({ authority: 'yaoguang' }))
    assert.equal(entries.length, 3, 'reset re-arms the reminder')
  })

  it('delegate_batch with mixed authorities lists only ledger-backed stars', () => {
    const cwd = seededCwd(['yaoguang'])
    const entries: AdvisoryEntry[] = []
    const hook = createGeneralLedgerHook({ advisoryBus: { submit: e => { entries.push(e as AdvisoryEntry) } } })

    hook.run(makeCtx(cwd), delegateEvent(
      { tasks: [{ authority: 'yaoguang' }, { authority: 'tianquan' }] },
      'delegate_batch',
    ))
    assert.equal(entries.length, 1)
    assert.ok(entries[0]!.content.includes('yaoguang'))
    assert.ok(!entries[0]!.content.includes('tianquan'), '无账本的星不出现在提醒里')
  })
})
