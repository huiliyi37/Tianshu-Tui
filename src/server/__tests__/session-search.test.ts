import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { searchSessionTranscripts, type SessionSearchRecord } from '../session-search.js'

function records(count: number): SessionSearchRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `Session ${index}`,
    cwd: '/unused',
  }))
}

function row(content: string, role: 'user' | 'assistant' = 'user'): string {
  return `${JSON.stringify({ role, content })}\n`
}

test('search reads at most four transcripts concurrently', async () => {
  let active = 0
  let maximum = 0
  const result = await searchSessionTranscripts(records(12), 'needle', {
    filePathFor: (session) => session.id,
    readFile: async (path) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      return row(`a needle in ${path}`)
    },
  })

  assert.equal(maximum, 4)
  assert.equal(result.metadata.scannedFiles, 12)
})

test('search preserves session and transcript order when reads finish out of order', async () => {
  const delays = [30, 20, 10, 0]
  const result = await searchSessionTranscripts(records(4), 'needle', {
    filePathFor: (session) => session.id,
    readFile: async (path) => {
      const index = Number(path.split('-')[1])
      await new Promise((resolve) => setTimeout(resolve, delays[index]))
      return [
        row(`first needle ${index}`, 'assistant'),
        row(`second needle ${index}`),
      ].join('')
    },
  })

  assert.deepEqual(
    result.results.map((hit) => [hit.sessionId, hit.role, hit.snippet]),
    records(4).flatMap((session, index) => [
      [session.id, 'assistant', `first needle ${index}`],
      [session.id, 'user', `second needle ${index}`],
    ]),
  )
})

test('search pool starts new work as soon as a worker becomes available', async () => {
  let releaseSlow!: () => void
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
  const started: string[] = []
  const search = searchSessionTranscripts(records(6), 'needle', {
    filePathFor: (session) => session.id,
    yieldControl: async () => {},
    readFile: async (path) => {
      started.push(path)
      if (path === 'session-0') await slow
      return row(`needle ${path}`)
    },
  })

  await yieldImmediate()
  assert.ok(started.includes('session-4'), 'a free worker should not wait for slow session-0')
  releaseSlow()
  const result = await search
  assert.deepEqual(result.results.map((hit) => hit.sessionId), records(6).map((record) => record.id))
})

test('search caps each session at three hits and all sessions at fifty', async () => {
  const result = await searchSessionTranscripts(records(20), 'needle', {
    filePathFor: (session) => session.id,
    readFile: async () => Array.from({ length: 5 }, (_, index) => row(`needle ${index}`)).join(''),
  })

  assert.equal(result.results.length, 50)
  assert.ok(records(20).every((session) =>
    result.results.filter((hit) => hit.sessionId === session.id).length <= 3,
  ))
})

test('search skips missing files and malformed rows while normalizing snippets', async () => {
  const result = await searchSessionTranscripts(records(3), 'needle', {
    filePathFor: (session) => session.id,
    readFile: async (path) => {
      if (path === 'session-0') throw new Error('ENOENT')
      if (path === 'session-1') return 'not json\n{"role":"tool","content":"needle"}\n'
      return row(`${'x'.repeat(70)} \n needle\twith   spaces ${'y'.repeat(70)}`, 'assistant')
    },
  })

  assert.equal(result.results.length, 1)
  assert.equal(result.results[0]!.role, 'assistant')
  assert.match(result.results[0]!.snippet, /^…/)
  assert.match(result.results[0]!.snippet, /needle with spaces/)
  assert.match(result.results[0]!.snippet, /…$/)
})

test('search yields to the event loop between ordered batches', async () => {
  let yielded = 0
  const result = await searchSessionTranscripts(records(9), 'absent', {
    filePathFor: (session) => session.id,
    readFile: async () => row('no match'),
    yieldControl: async () => {
      yielded++
      await yieldImmediate()
    },
  })

  assert.equal(result.results.length, 0)
  assert.ok(yielded > 0)
})

test('aborting an obsolete scan stops scheduling and releases active reads promptly', async () => {
  let active = 0
  let maximumAggregate = 0
  const started: string[] = []
  const cancellableRead = (request: string) => async (
    path: string,
    options: { signal?: AbortSignal } | BufferEncoding,
  ): Promise<string> => {
    const signal = typeof options === 'string' ? undefined : options.signal
    started.push(`${request}:${path}`)
    active++
    maximumAggregate = Math.max(maximumAggregate, active)
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        active--
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        finish()
        reject(new DOMException('aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      if (!signal) setTimeout(() => { finish(); resolve(row('needle')) }, 2)
    })
  }

  const obsolete = new AbortController()
  const oldSearch = searchSessionTranscripts(records(20), 'needle', {
    signal: obsolete.signal,
    filePathFor: (session) => session.id,
    readFile: cancellableRead('old'),
  })
  await yieldImmediate()
  assert.equal(active, 4)
  obsolete.abort()
  const current = new AbortController()
  const newSearch = searchSessionTranscripts(records(20), 'needle', {
    signal: current.signal,
    filePathFor: (session) => session.id,
    readFile: cancellableRead('new'),
  })
  await yieldImmediate()
  await oldSearch
  assert.equal(active, 4)
  assert.equal(started.filter((entry) => entry.startsWith('old:')).length, 4)
  assert.equal(maximumAggregate, 4)
  current.abort()
  await newSearch
  assert.equal(active, 0)
})

test('search reports duration and scanned-file metrics for a 100-session fixture', async () => {
  let observed: { durationMs: number; scannedFiles: number } | undefined
  const result = await searchSessionTranscripts(records(100), 'absent', {
    filePathFor: (session) => session.id,
    readFile: async () => row('haystack'),
    onMetrics: (metrics) => { observed = metrics },
  })

  assert.equal(result.metadata.scannedFiles, 100)
  assert.ok(result.metadata.durationMs >= 0)
  assert.deepEqual(observed, result.metadata)
})
