import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createProjectSidebarSearch,
  type SearchSessionContent,
} from '../project-sidebar-search'

type Pending = {
  query: string
  signal: AbortSignal
  resolve: (results: string[]) => void
}

function deferredSearch(): { search: SearchSessionContent<string>; pending: Pending[] } {
  const pending: Pending[] = []
  return {
    pending,
    search: (query, signal) => new Promise<string[]>((resolve) => {
      pending.push({ query, signal, resolve })
    }),
  }
}

function fakeScheduler() {
  const pending = new Map<number, { callback: () => void; delayMs: number }>()
  let nextId = 0
  return {
    pending,
    scheduler: {
      setTimeout(callback: () => void, delayMs: number) {
        const id = ++nextId
        pending.set(id, { callback, delayMs })
        return id
      },
      clearTimeout(id: unknown) {
        pending.delete(id as number)
      },
    },
    run(id: number) {
      const task = pending.get(id)
      pending.delete(id)
      task?.callback()
    },
  }
}

test('sidebar search schedules its debounce for exactly 250ms', async () => {
  const calls: string[] = []
  const fake = fakeScheduler()
  const controller = createProjectSidebarSearch<string>({
    search: async (query) => {
      calls.push(query)
      return []
    },
    onResults: () => {},
    scheduler: fake.scheduler,
  })

  controller.update('needle')
  assert.deepEqual(calls, [])
  const [id, task] = [...fake.pending.entries()][0]!
  assert.equal(task.delayMs, 250)
  fake.run(id)
  await Promise.resolve()
  assert.deepEqual(calls, ['needle'])
  controller.dispose()
})

test('sidebar search aborts the prior request on new input and on dispose', async () => {
  const { search, pending } = deferredSearch()
  const controller = createProjectSidebarSearch({
    search,
    onResults: () => {},
    delayMs: 0,
  })

  controller.update('first')
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.update('second')
  assert.equal(pending[0]!.signal.aborted, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(pending[1]!.signal.aborted, false)
  controller.dispose()
  assert.equal(pending[1]!.signal.aborted, true)
})

test('sidebar search keeps immediate two-character threshold and rejects stale results', async () => {
  const { search, pending } = deferredSearch()
  const updates: string[][] = []
  const controller = createProjectSidebarSearch({
    search,
    onResults: (results) => updates.push(results),
    delayMs: 0,
  })

  controller.update('a')
  assert.deepEqual(updates, [[]])
  assert.equal(pending.length, 0)

  controller.update('first')
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.update('second')
  await new Promise((resolve) => setTimeout(resolve, 0))
  pending[0]!.resolve(['stale'])
  pending[1]!.resolve(['fresh'])
  await Promise.resolve()

  assert.deepEqual(updates, [[], ['fresh']])
  controller.dispose()
})
