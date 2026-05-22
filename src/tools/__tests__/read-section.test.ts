import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_SECTION_TOOL } from '../read-section.js'
import { ArtifactStore } from '../../artifact/store.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'read-section-test-'))
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
