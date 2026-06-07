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

  describe('hard-stall watchdog', () => {
    it('fires onHardStall once when silence exceeds hardStallMs', async () => {
      const stalls: Array<{ elapsed: number; activity: string }> = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 60,
        onHeartbeat: () => {},
        onHardStall: (elapsed, activity) => stalls.push({ elapsed, activity }),
      })
      hb.start()
      hb.tick('read_file returned')
      await delay(140)
      hb.stop()
      assert.equal(stalls.length, 1, `onHardStall must fire exactly once, got ${stalls.length}`)
      assert.equal(stalls[0]!.activity, 'read_file returned')
      assert.ok(stalls[0]!.elapsed >= 60, `elapsed should be >= hardStallMs, got ${stalls[0]!.elapsed}`)
    })

    it('does not fire onHardStall when a tick resets the clock in time', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 80,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      // Tick every 30ms — never silent for the full 80ms ceiling.
      for (let i = 0; i < 5; i++) {
        await delay(30)
        hb.tick(`activity ${i}`)
      }
      hb.stop()
      assert.equal(stalls.length, 0, 'watchdog must not fire while ticks keep arriving')
    })

    it('re-arms the watchdog after a tick (fires again on a second stall)', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      await delay(90)        // first stall fires
      hb.tick('recovered')   // re-arm
      await delay(90)        // second stall fires
      hb.stop()
      assert.ok(stalls.length >= 2, `expected watchdog to re-arm and fire twice, got ${stalls.length}`)
    })

    it('disables the watchdog when hardStallMs is 0', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 0,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      await delay(120)
      hb.stop()
      assert.equal(stalls.length, 0, 'hardStallMs=0 must disable the watchdog')
    })

    it('keeps emitting heartbeats after a hard stall fires', async () => {
      let beats = 0
      let stalls = 0
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => { beats++ },
        onHardStall: () => { stalls++ },
      })
      hb.start()
      await delay(140)
      hb.stop()
      assert.equal(stalls, 1, 'hard stall fires once')
      assert.ok(beats >= 3, `heartbeats keep emitting while abort propagates, got ${beats}`)
    })
  })
})
