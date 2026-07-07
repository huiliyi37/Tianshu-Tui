import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { ArtifactCorruptionError, ArtifactStore, MAX_RANGE_LINES } from '../store.js'
import { formatArtifactRef } from '../types.js'

async function withTempStore(fn: (store: ArtifactStore, dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-test-'))
  const store = new ArtifactStore(dir, 'test-session', {
    now: () => 1_700_000_000_000,
    idGenerator: () => 'abc12345',
  })
  try {
    await fn(store, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('formatArtifactRef', () => {
  it('formats compact references for message history', () => {
    const formatted = formatArtifactRef({
      artifactId: 'read_file:abc12345',
      summary: 'TypeScript module with exports',
      charCount: 42,
      lineCount: 3,
      sections: ['imports', 'export:run'],
    })

    assert.equal(
      formatted,
      '[42 chars, 3 lines] Sections: imports, export:run. TypeScript module with exports (use read_section to expand)',
    )
  })
})

describe('ArtifactStore', () => {
  it('saves and loads an artifact', async () => {
    await withTempStore(async (store) => {
      const id = await store.save({
        tool: 'read_file',
        target: '/src/app.ts',
        rawContent: 'const x = 1;\nconst y = 2;\nexport { x, y }',
        summary: 'TypeScript module with 2 exports',
        sections: [{ name: 'exports', lineStart: 3, lineEnd: 3, charCount: 16 }],
      })

      const artifact = store.get(id)
      assert.ok(artifact)
      assert.equal(artifact.id, 'read_file:abc12345')
      assert.equal(artifact.tool, 'read_file')
      assert.equal(artifact.target, '/src/app.ts')
      assert.equal(artifact.sessionId, 'test-session')
      assert.equal(artifact.charCount, 41)
      assert.equal(artifact.lineCount, 3)
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
      assert.ok(existsSync(artifact.rawPath))
    })
  })

  it('persists metadata to an append-only index and reloads after restart', async () => {
    await withTempStore(async (store, dir) => {
      const id = await store.save({
        tool: 'grep',
        target: 'ArtifactStore',
        rawContent: 'src/artifact/store.ts:1:export class ArtifactStore',
        summary: '1 grep match',
        sections: [],
      })

      const indexPath = join(dir, 'test-session', '_index.jsonl')
      const lines = readFileSync(indexPath, 'utf-8').trim().split('\n')
      assert.equal(lines.length, 1)

      const restarted = new ArtifactStore(dir, 'test-session')
      assert.deepEqual(restarted.get(id), store.get(id))
      assert.equal(await restarted.readRaw(id), 'src/artifact/store.ts:1:export class ArtifactStore')
    })
  })

  it('reads raw content and specific line ranges', async () => {
    await withTempStore(async (store) => {
      const id = await store.save({
        tool: 'read_file',
        target: '/src/app.ts',
        rawContent: 'line1\nline2\nline3\nline4\nline5',
        summary: '5 lines',
        sections: [],
      })

      assert.equal(await store.readRaw(id), 'line1\nline2\nline3\nline4\nline5')
      assert.equal(await store.readLines(id, 2, 4), 'line2\nline3\nline4')
    })
  })

  it('returns null for unknown artifacts', async () => {
    await withTempStore(async (store) => {
      assert.equal(store.get('nonexistent'), null)
      assert.equal(await store.readRaw('nonexistent'), null)
      assert.equal(await store.readLines('nonexistent', 1, 2), null)
    })
  })

  it('lists artifacts by target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-test-'))
    try {
      let counter = 0
      const store = new ArtifactStore(dir, 'test-session', { idGenerator: () => `id${++counter}` })
      await store.save({ tool: 'read_file', target: '/a.ts', rawContent: 'a', summary: 'a', sections: [] })
      await store.save({ tool: 'grep', target: '/b.ts', rawContent: 'b', summary: 'b', sections: [] })
      await store.save({ tool: 'read_file', target: '/a.ts', rawContent: 'a2', summary: 'a2', sections: [] })

      assert.deepEqual(store.listByTarget('/a.ts').map((artifact) => artifact.summary), ['a', 'a2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readLineRange streams a line window from a multi-MB file without OOM', async () => {
    await withTempStore(async (store) => {
      // ~3MB of content: 60k lines of 50 chars — comfortably over the 2MB
      // in-memory ceiling that readRaw/read_section enforce.
      const total = 60_000
      const rawContent = Array.from({ length: total }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n')
      assert.ok(rawContent.length > 2 * 1024 * 1024)
      const id = await store.save({
        tool: 'compact-history',
        target: 'session',
        rawContent,
        summary: 'big',
        sections: [],
      })

      const ranged = await store.readLineRange(id, 100, 102)
      assert.ok(ranged)
      assert.equal(ranged.content, 'line 100 ' + 'x'.repeat(40) + '\nline 101 ' + 'x'.repeat(40) + '\nline 102 ' + 'x'.repeat(40))
      assert.equal(ranged.capped, false)
    })
  })

  it('readLineRange caps oversized windows at MAX_RANGE_LINES', async () => {
    await withTempStore(async (store) => {
      const rawContent = Array.from({ length: MAX_RANGE_LINES + 500 }, (_, i) => `L${i + 1}`).join('\n')
      const id = await store.save({
        tool: 'compact-history', target: 'session', rawContent, summary: 'big', sections: [],
      })

      const ranged = await store.readLineRange(id, 1, MAX_RANGE_LINES + 500)
      assert.ok(ranged)
      assert.equal(ranged.capped, true)
      assert.equal(ranged.content.split('\n').length, MAX_RANGE_LINES)
      assert.equal(ranged.content.split('\n')[0], 'L1')
      assert.equal(ranged.content.split('\n').at(-1), `L${MAX_RANGE_LINES}`)
    })
  })

  it('readLineRange reports out-of-range with accurate total', async () => {
    await withTempStore(async (store) => {
      const id = await store.save({
        tool: 'compact-history', target: 'session', rawContent: 'a\nb\nc', summary: '3', sections: [],
      })
      const ranged = await store.readLineRange(id, 10, 20)
      assert.ok(ranged)
      assert.equal(ranged.content, '')
      assert.equal(ranged.totalLines, 3)
    })
  })

  it('readLineRange returns null for unknown artifacts', async () => {
    await withTempStore(async (store) => {
      assert.equal(await store.readLineRange('nonexistent', 1, 2), null)
    })
  })

  it('detects raw artifact corruption before returning content', async () => {
    await withTempStore(async (store) => {
      const id = await store.save({
        tool: 'read_file',
        target: '/src/app.ts',
        rawContent: 'original content',
        summary: 'original',
        sections: [],
      })
      const artifact = store.get(id)
      assert.ok(artifact)
      writeFileSync(artifact.rawPath, 'tampered content', 'utf-8')

      await assert.rejects(
        () => store.readRaw(id),
        (error: unknown) => error instanceof ArtifactCorruptionError
          && error.artifactId === id
          && error.expectedSha256 === artifact.sha256,
      )
    })
  })
})

describe('ArtifactStore fallback sessions', () => {
  it('resolves artifacts from a fallback session directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-fallback-test-'))
    try {
      const workerStore = new ArtifactStore(dir, 'worker-order-1', {
        now: () => 1_700_000_000_000,
        idGenerator: () => 'abc12345',
      })
      const id = await workerStore.save({
        tool: 'read_file',
        target: '/src/worker.ts',
        rawContent: 'line1\nline2\nline3',
        summary: 'Worker artifact',
        sections: [],
      })

      const primary = new ArtifactStore(dir, 'primary-session')
      primary.addFallbackSession('worker-order-1')

      assert.equal(primary.get(id)?.id, id)
      assert.equal(await primary.readRaw(id), 'line1\nline2\nline3')
      assert.equal(await primary.readLines(id, 2, 3), 'line2\nline3')
      const ranged = await primary.readLineRange(id, 1, 2)
      assert.ok(ranged)
      assert.equal(ranged.content, 'line1\nline2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('re-anchors rawPath to the fallback session directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-fallback-test-'))
    try {
      const workerStore = new ArtifactStore(dir, 'worker-order-1', {
        now: () => 1_700_000_000_000,
        idGenerator: () => 'abc12345',
      })
      const id = await workerStore.save({
        tool: 'read_file',
        target: '/src/worker.ts',
        rawContent: 'worker content',
        summary: 'Worker artifact',
        sections: [],
      })

      const primary = new ArtifactStore(dir, 'primary-session')
      primary.addFallbackSession('worker-order-1')
      const artifact = primary.get(id)
      assert.ok(artifact)
      assert.ok(artifact.rawPath.includes(`${dir}${sep}worker-order-1${sep}`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores unknown fallback sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-fallback-test-'))
    try {
      const primary = new ArtifactStore(dir, 'primary-session')
      primary.addFallbackSession('missing-worker')
      assert.equal(primary.get('nonexistent'), null)
      assert.equal(await primary.readRaw('nonexistent'), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates fallback session registrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-fallback-test-'))
    try {
      const workerStore = new ArtifactStore(dir, 'worker-order-1', {
        now: () => 1_700_000_000_000,
        idGenerator: () => 'abc12345',
      })
      const id = await workerStore.save({
        tool: 'read_file',
        target: '/src/worker.ts',
        rawContent: 'worker content',
        summary: 'Worker artifact',
        sections: [],
      })

      const primary = new ArtifactStore(dir, 'primary-session')
      primary.addFallbackSession('worker-order-1')
      primary.addFallbackSession('worker-order-1')
      assert.equal(primary.get(id)?.id, id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
