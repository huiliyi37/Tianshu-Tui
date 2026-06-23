import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_SECTION_TOOL } from '../read-section.js'
import { ArtifactStore } from '../../artifact/store.js'
import { __setFileReadMtimeForTests, __resetReadHistoryForTests } from '../read-file.js'

function makeTempDir(): string {
  // Use project-local dir instead of os.tmpdir() — the latter is often
  // EPERM-restricted in sandboxed agent runtimes.
  const base = join(process.cwd(), '.rivet', 'tmp')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'read-section-test-'))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

describe('read_section tool', () => {
  it('reads a line range from an artifact', async () => {
    const tempDir = makeTempDir()
    try {
      const artifactStore = new ArtifactStore(tempDir, 'test-session')
      
      // Create an artifact
      const rawContent = 'line 1\nline 2\nline 3\nline 4\nline 5'
      const artifactId = await artifactStore.save({
        tool: 'test',
        target: '/test/file.txt',
        rawContent,
        summary: 'Test file, 5 lines.',
        sections: [],
      })

      // Read lines 2-4
      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId, section: 'L2-L4' },
        toolUseId: 'test-1',
        cwd: tempDir,
        artifactStore,
      })

      assert.ok(!result.isError)
      assert.ok(result.content.includes('line 2'))
      assert.ok(result.content.includes('line 3'))
      assert.ok(result.content.includes('line 4'))
      assert.ok(!result.content.includes('line 1'))
      assert.ok(!result.content.includes('line 5'))
    } finally {
      cleanup(tempDir)
    }
  })

  it('reads a character range from an artifact', async () => {
    const tempDir = makeTempDir()
    try {
      const artifactStore = new ArtifactStore(tempDir, 'test-session')
      
      const rawContent = 'Hello, World! This is a test.'
      const artifactId = await artifactStore.save({
        tool: 'test',
        target: '/test/file.txt',
        rawContent,
        summary: 'Test file.',
        sections: [],
      })

      // Read characters 7-12 ("World")
      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId, section: 'c7-c12' },
        toolUseId: 'test-2',
        cwd: tempDir,
        artifactStore,
      })

      assert.ok(!result.isError)
      assert.ok(result.content.includes('World'))
    } finally {
      cleanup(tempDir)
    }
  })

  it('returns error for missing artifact', async () => {
    const tempDir = makeTempDir()
    try {
      const artifactStore = new ArtifactStore(tempDir, 'test-session')
      
      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId: 'nonexistent', section: 'L1-L10' },
        toolUseId: 'test-3',
        cwd: tempDir,
        artifactStore,
      })

      assert.ok(result.isError)
      assert.ok(result.content.includes('not found'))
    } finally {
      cleanup(tempDir)
    }
  })

  it('returns error for missing parameters', async () => {
    const tempDir = makeTempDir()
    try {
      const artifactStore = new ArtifactStore(tempDir, 'test-session')
      
      const result = await READ_SECTION_TOOL.execute({
        input: {},
        toolUseId: 'test-4',
        cwd: tempDir,
        artifactStore,
      })

      assert.ok(result.isError)
      assert.ok(result.content.includes('required'))
    } finally {
      cleanup(tempDir)
    }
  })

  it('returns error for invalid section format', async () => {
    const tempDir = makeTempDir()
    try {
      const artifactStore = new ArtifactStore(tempDir, 'test-session')
      
      const artifactId = await artifactStore.save({
        tool: 'test',
        target: '/test/file.txt',
        rawContent: 'test content',
        summary: 'Test file.',
        sections: [],
      })

      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId, section: 'invalid' },
        toolUseId: 'test-5',
        cwd: tempDir,
        artifactStore,
      })

      assert.ok(result.isError)
      assert.ok(result.content.includes('Invalid section format'))
    } finally {
      cleanup(tempDir)
    }
  })

  it('handles out-of-range line numbers gracefully', async () => {
    const tempDir = makeTempDir()
    try {
      const artifactStore = new ArtifactStore(tempDir, 'test-session')

      const artifactId = await artifactStore.save({
        tool: 'test',
        target: '/test/file.txt',
        rawContent: 'line 1\nline 2',
        summary: 'Test file, 2 lines.',
        sections: [],
      })

      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId, section: 'L100-L200' },
        toolUseId: 'test-6',
        cwd: tempDir,
        artifactStore,
      })

      assert.ok(!result.isError)
      assert.ok(result.content.includes('out of range'))
    } finally {
      cleanup(tempDir)
    }
  })

  it('detects raw artifact corruption (SHA-256 mismatch)', async () => {
    const tempDir = makeTempDir()
    try {
      const artifactStore = new ArtifactStore(tempDir, 'test-session')
      const artifactId = await artifactStore.save({
        tool: 'test',
        target: '/test/file.txt',
        rawContent: 'original content\nline 2',
        summary: 'Test file, 2 lines.',
        sections: [],
      })

      // Tamper with the raw file directly
      const artifact = artifactStore.get(artifactId)!
      writeFileSync(artifact.rawPath, 'tampered content', 'utf-8')

      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId, section: 'L1-L10' },
        toolUseId: 'test-7',
        cwd: tempDir,
        artifactStore,
      })

      assert.ok(result.isError, 'corruption must surface as isError')
      assert.match(result.content, /corrupted|SHA-256/i, 'error must mention corruption')
    } finally {
      cleanup(tempDir)
    }
  })

  it('errors when artifactStore is not configured', async () => {
    const tempDir = makeTempDir()
    try {
      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId: 'whatever', section: 'L1-L10' },
        toolUseId: 'test-8',
        cwd: tempDir,
      })

      assert.ok(result.isError)
      assert.match(result.content, /not configured/i)
    } finally {
      cleanup(tempDir)
    }
  })
})

describe('read_section file_path branch (任务 B3)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(process.cwd(), '.rivet', 'tmp', 'read-section-file-'))
  })

  afterEach(() => {
    if (tempDir) cleanup(tempDir)
  })

  function makeFile(name: string, content: string): string {
    const path = join(tempDir, name)
    const parent = join(path, '..')
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    writeFileSync(path, content, 'utf-8')
    return name
  }

  it('reads line range from live file via file_path', async () => {
    const file = makeFile('src/test.ts', 'line 1\nline 2\nline 3\nline 4\nline 5')

    const result = await READ_SECTION_TOOL.execute({
      input: { file_path: file, section: 'L2-L4' },
      toolUseId: 'b3-1',
      cwd: tempDir,
    })

    assert.ok(!result.isError)
    assert.ok(result.content.includes('line 2'))
    assert.ok(result.content.includes('line 3'))
    assert.ok(result.content.includes('line 4'))
    assert.ok(!result.content.includes('line 1'))
    assert.ok(!result.content.includes('line 5'))
  })

  it('reads char range from live file via file_path', async () => {
    makeFile('src/chars.ts', 'Hello, World! This is a test.')

    const result = await READ_SECTION_TOOL.execute({
      input: { file_path: 'src/chars.ts', section: 'c7-c12' },
      toolUseId: 'b3-2',
      cwd: tempDir,
    })

    assert.ok(!result.isError)
    assert.ok(result.content.includes('World'))
  })

  it('returns error when neither artifactId nor file_path provided', async () => {
    const result = await READ_SECTION_TOOL.execute({
      input: { section: 'L1-L10' },
      toolUseId: 'b3-3',
      cwd: tempDir,
    })

    assert.ok(result.isError)
    assert.match(result.content, /artifactId or file_path is required/i)
  })

  it('returns error when file does not exist', async () => {
    const result = await READ_SECTION_TOOL.execute({
      input: { file_path: 'nonexistent.ts', section: 'L1-L10' },
      toolUseId: 'b3-4',
      cwd: tempDir,
    })

    assert.ok(result.isError)
    assert.match(result.content, /Error reading file/i)
  })

  it('handles out-of-range line numbers from live file', async () => {
    makeFile('src/short.ts', 'line 1\nline 2')

    const result = await READ_SECTION_TOOL.execute({
      input: { file_path: 'src/short.ts', section: 'L100-L200' },
      toolUseId: 'b3-5',
      cwd: tempDir,
    })

    assert.ok(!result.isError)
    assert.ok(result.content.includes('out of range'))
  })

  it('includes staleness warning when mtime differs from last read_file', async () => {
    __resetReadHistoryForTests()
    const file = makeFile('src/stale.ts', 'version 1\n')

    // Inject stale mtime (different from actual file mtime)
    __setFileReadMtimeForTests(join(tempDir, file), 1)

    const result = await READ_SECTION_TOOL.execute({
      input: { file_path: file, section: 'L1-L1' },
      toolUseId: 'b3-6',
      cwd: tempDir,
    })

    assert.ok(!result.isError)
    assert.ok(result.content.includes('version 1'), 'must return content')
    assert.match(result.content, /已变更/i, 'must include staleness warning')
  })
})

describe('read_section recall of compact-history artifacts', () => {
  it('recalls archived history verbatim and tags it with a recall marker', async () => {
    const tempDir = makeTempDir()
    try {
      const store = new ArtifactStore(tempDir, 'recall-session')
      const { serializeMessagesForArchive } = await import('../../agent/compact-archive.js')
      const { parseRecallMarker, COMPACT_HISTORY_TOOL } = await import('../../compact/recall-marker.js')

      const { rawContent, sections } = serializeMessagesForArchive([
        { role: 'user', content: 'original constraint: keep prefix cache stable' },
        { role: 'assistant', content: 'acknowledged' },
      ])
      const id = await store.save({
        tool: COMPACT_HISTORY_TOOL,
        target: 'session-history@turn0',
        rawContent,
        summary: 'compacted 2 messages',
        sections,
      })
      assert.ok(id.startsWith('compact-history:'))

      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId: id, section: 'L1-L4' },
        toolUseId: 'recall-1',
        cwd: tempDir,
        artifactStore: store,
      })

      assert.ok(!result.isError)
      // Verbatim content recoverable section-by-section.
      assert.match(result.content, /original constraint: keep prefix cache stable/)
      // Tagged so the next compaction can evict the recalled block.
      const parsed = parseRecallMarker(result.content)
      assert.ok(parsed, 'recalled compact-history must carry a recall marker')
      assert.equal(parsed!.artifactId, id)
      assert.equal(parsed!.section, 'L1-L4')
    } finally {
      cleanup(tempDir)
    }
  })

  it('recalls a line range from a >2MB compact-history archive (A1 regression)', async () => {
    const tempDir = makeTempDir()
    try {
      const store = new ArtifactStore(tempDir, 'recall-session')
      const { parseRecallMarker, COMPACT_HISTORY_TOOL } = await import('../../compact/recall-marker.js')

      // >2MB raw: would be rejected by the in-memory 2MB gate. The
      // compact-history line-range fast path must stream past it.
      const total = 60_000
      const rawContent = Array.from({ length: total }, (_, i) => `histline ${i + 1} ${'y'.repeat(40)}`).join('\n')
      assert.ok(rawContent.length > 2 * 1024 * 1024)
      const id = await store.save({
        tool: COMPACT_HISTORY_TOOL,
        target: 'session-history@turn0',
        rawContent,
        summary: 'huge history',
        sections: [],
      })

      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId: id, section: 'L500-L502' },
        toolUseId: 'recall-big',
        cwd: tempDir,
        artifactStore: store,
      })

      assert.ok(!result.isError, `expected success, got: ${result.content.slice(0, 120)}`)
      assert.match(result.content, /histline 500/)
      assert.match(result.content, /histline 502/)
      assert.doesNotMatch(result.content, /too large/)
      assert.ok(parseRecallMarker(result.content), 'big-archive recall must carry a marker')
    } finally {
      cleanup(tempDir)
    }
  })

  it('does NOT tag normal (non-history) artifacts with a recall marker', async () => {
    const tempDir = makeTempDir()
    try {
      const store = new ArtifactStore(tempDir, 'recall-session')
      const { parseRecallMarker } = await import('../../compact/recall-marker.js')
      const id = await store.save({
        tool: 'read_file',
        target: 'src/foo.ts',
        rawContent: 'line a\nline b\nline c',
        summary: 'a file',
        sections: [],
      })
      const result = await READ_SECTION_TOOL.execute({
        input: { artifactId: id, section: 'L1-L2' },
        toolUseId: 'recall-2',
        cwd: tempDir,
        artifactStore: store,
      })
      assert.ok(!result.isError)
      assert.equal(parseRecallMarker(result.content), null)
    } finally {
      cleanup(tempDir)
    }
  })
})
