import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnHeartbeat } from '../turn-heartbeat.js'

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('TurnHeartbeat', () => {
  it('fires after silentMs of silence', async () => {
    const events: Array<{ elapsed: number; activity: string }> = []
    const hb = new TurnHeartbeat({
      silentMs: 50,
      repeatMs: 50,
      onHeartbeat: (elapsed, activity) => events.push({ elapsed, activity }),
    })
    hb.start()
    await delay(80)
    hb.stop()
    assert.ok(events.length >= 1, `expected at least 1 heartbeat, got ${events.length}`)
    assert.equal(events[0]!.activity, 'starting')
    assert.ok(events[0]!.elapsed >= 50, `elapsed should be >= 50ms, got ${events[0]!.elapsed}`)
  })

  it('does not fire if tick happens before silentMs', async () => {
    const events: Array<{ elapsed: number; activity: string }> = []
    const hb = new TurnHeartbeat({
      silentMs: 100,
      repeatMs: 100,
      onHeartbeat: (e, a) => events.push({ elapsed: e, activity: a }),
    })
    hb.start()
    await delay(40)
    hb.tick('reading file')
    await delay(40)
    hb.tick('processing')
    await delay(40)
    hb.stop()
    assert.equal(events.length, 0, 'should not fire when ticks reset the clock')
  })

  it('reports the most recent activity in heartbeat events', async () => {
    const events: Array<{ activity: string }> = []
    const hb = new TurnHeartbeat({
      silentMs: 40,
      repeatMs: 40,
      onHeartbeat: (_, a) => events.push({ activity: a }),
    })
    hb.start()
    hb.tick('compacting messages')
    await delay(70)
    hb.stop()
    assert.ok(events.length >= 1)
    assert.equal(events[0]!.activity, 'compacting messages')
  })

  it('repeats after first fire at repeatMs interval', async () => {
    const fireTimes: number[] = []
    const hb = new TurnHeartbeat({
      silentMs: 50,
      repeatMs: 30,
      onHeartbeat: () => fireTimes.push(Date.now()),
    })
    const t0 = Date.now()
    hb.start()
    await delay(150)
    hb.stop()
    // First fire ~50ms, second ~80ms, third ~110ms — expect 3 fires total
    assert.ok(fireTimes.length >= 2, `expected >=2 fires, got ${fireTimes.length}`)
    if (fireTimes.length >= 2) {
      const gap = fireTimes[1]! - fireTimes[0]!
      assert.ok(gap >= 25 && gap <= 60, `repeat gap should be ~30ms, got ${gap}`)
    }
    // First fire should be after silentMs, not repeatMs
    const firstDelay = fireTimes[0]! - t0
    assert.ok(firstDelay >= 45, `first fire should respect silentMs (>=45ms), got ${firstDelay}`)
  })

  it('stops cleanly on stop()', async () => {
    let count = 0
    const hb = new TurnHeartbeat({
      silentMs: 30,
      repeatMs: 30,
      onHeartbeat: () => { count++ },
    })
    hb.start()
    await delay(50)
    hb.stop()
    const afterStop = count
    await delay(80)
    assert.equal(count, afterStop, 'should not fire after stop()')
  })

  it('survives errors in callback', async () => {
    let calls = 0
    const hb = new TurnHeartbeat({
      silentMs: 30,
      repeatMs: 30,
      onHeartbeat: () => {
        calls++
        throw new Error('callback boom')
      },
    })
    hb.start()
    await delay(100)
    hb.stop()
    // Should keep firing despite the throws
    assert.ok(calls >= 2, `expected >=2 calls despite errors, got ${calls}`)
  })
})
