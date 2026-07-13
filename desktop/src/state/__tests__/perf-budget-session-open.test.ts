import { test } from 'node:test'
import assert from 'node:assert/strict'

test('session-open tracker owns explicit generations and records fold/content/interactive once', async () => {
  const module = await import('../perf-budget')
  const createTracker = (module as unknown as {
    createSessionOpenTracker?: (
      now: () => number,
      record: (name: string, duration: number) => void,
    ) => {
      begin: (
        id: string,
        initial?: { hasFoldedEvents: boolean; hasContent: boolean },
      ) => { id: string; generation: number }
      firstFold: (id: string) => void
      firstContent: (token: { id: string; generation: number }) => void
      firstInteractive: (token: { id: string; generation: number }) => void
      end: (token: { id: string; generation: number }) => void
    }
  }).createSessionOpenTracker
  assert.equal(typeof createTracker, 'function', 'perf budget should expose a testable session-open tracker')
  if (!createTracker) return

  let now = 100
  const samples: Array<{ name: string; duration: number }> = []
  const tracker = createTracker(
    () => now,
    (name, duration) => samples.push({ name, duration }),
  )

  tracker.firstFold('session-a')
  assert.deepEqual(samples, [], 'background hub folds must not create an open baseline')

  const first = tracker.begin('session-a')
  now = 110
  tracker.firstFold('session-a')
  now = 115
  tracker.firstContent(first)
  now = 120
  tracker.firstInteractive(first)
  tracker.firstFold('session-a')
  tracker.firstContent(first)

  now = 200
  const second = tracker.begin('session-a', { hasFoldedEvents: true, hasContent: true })
  assert.notEqual(second.generation, first.generation)
  now = 205
  tracker.firstContent(first)
  now = 210
  tracker.firstFold('session-a')
  now = 220
  tracker.firstContent(second)
  now = 230
  tracker.firstInteractive(second)
  tracker.end(second)

  assert.deepEqual(samples, [
    { name: 'sessionOpen.firstFold', duration: 10 },
    { name: 'sessionOpen.firstContent', duration: 15 },
    { name: 'sessionOpen.firstInteractive', duration: 20 },
    { name: 'sessionOpen.firstFold', duration: 0 },
    { name: 'sessionOpen.firstContent', duration: 0 },
    { name: 'sessionOpen.firstInteractive', duration: 30 },
  ])
})

test('interactive readiness requires content, virtual rows, scroll container, and composer', async () => {
  const module = await import('../perf-budget')
  const ready = (module as unknown as {
    isSessionOpenInteractiveReady?: (input: {
      hasContent: boolean
      virtualItemCount: number
      hasScrollContainer: boolean
      hasComposer: boolean
    }) => boolean
  }).isSessionOpenInteractiveReady
  assert.equal(typeof ready, 'function')
  if (!ready) return

  const complete = {
    hasContent: true,
    virtualItemCount: 1,
    hasScrollContainer: true,
    hasComposer: true,
  }
  assert.equal(ready(complete), true)
  assert.equal(ready({ ...complete, hasContent: false }), false)
  assert.equal(ready({ ...complete, virtualItemCount: 0 }), false)
  assert.equal(ready({ ...complete, hasScrollContainer: false }), false)
  assert.equal(ready({ ...complete, hasComposer: false }), false)
})
