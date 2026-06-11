import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { determineTier, extractTrailingArtifactId, tierToolResult, type TierLevel, type TieringResult } from '../tool-result-tiering.js'

describe('tool-result-tiering', () => {
  describe('determineTier', () => {
    it('tier 0 for small content', () => {
      assert.equal(determineTier(100), 0)
      assert.equal(determineTier(8_000), 0)
    })

    it('tier 1 for medium content', () => {
      assert.equal(determineTier(8_001), 1)
      assert.equal(determineTier(150_000), 1)
    })

    it('tier 2 for large content', () => {
      assert.equal(determineTier(150_001), 2)
      assert.equal(determineTier(1_000_000), 2)
    })
  })

  describe('tierToolResult', () => {
    it('returns tier 0 for small context windows (<500K)', async () => {
      const content = 'x'.repeat(50_000)
      const result = await tierToolResult('read_file', content, 'test.ts', undefined, 200_000)
      assert.equal(result.tier, 0)
      assert.equal(result.content, content)
      assert.equal(result.originalChars, 50_000)
    })

    it('returns tier 0 for small content in 1M window', async () => {
      const content = 'small result'
      const result = await tierToolResult('grep', content, 'src/', undefined, 1_000_000)
      assert.equal(result.tier, 0)
      assert.equal(result.content, content)
    })

    it('returns tier 1 summary for medium content in 1M window', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`).join('\n')
      assert.ok(lines.length > 8_000)
      assert.ok(lines.length < 150_000)

      const result = await tierToolResult('read_file', lines, 'big.ts', undefined, 1_000_000)
      assert.equal(result.tier, 1)
      assert.ok(result.content.includes('[tiered-summary:'))
      assert.ok(result.content.includes('lines omitted'))
      assert.ok(result.content.length < lines.length)
      assert.equal(result.originalChars, lines.length)
    })

    it('returns tier 2 minimal for huge content in 1M window', async () => {
      const content = 'x\n'.repeat(100_000)
      assert.ok(content.length > 150_000)

      const result = await tierToolResult('bash', content, '/tmp/output', undefined, 1_000_000)
      assert.equal(result.tier, 2)
      assert.ok(result.content.includes('[tiered-minimal:'))
      assert.ok(result.content.includes('read_section'))
      assert.ok(result.content.length < 500)
      assert.equal(result.originalChars, content.length)
    })

    it('saves to artifact store when provided', async () => {
      let savedArtifact: unknown = null
      const mockStore = {
        save: async (data: unknown) => {
          savedArtifact = data
          return 'artifact-123'
        },
      } as any

      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`).join('\n')
      const result = await tierToolResult('read_file', lines, 'big.ts', mockStore, 1_000_000)

      assert.equal(result.tier, 1)
      assert.equal(result.artifactId, 'artifact-123')
      assert.ok(result.content.includes('[artifact:artifact-123]'))
      assert.ok(savedArtifact !== null)
    })

    it('falls back to tier 0 if artifact store throws', async () => {
      const mockStore = {
        save: async () => { throw new Error('disk full') },
      } as any

      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`).join('\n')
      const result = await tierToolResult('read_file', lines, 'big.ts', mockStore, 1_000_000)

      assert.equal(result.tier, 0)
      assert.equal(result.content, lines)
    })

    it('reuses an existing tool-level artifact instead of saving a second copy', async () => {
      let saveCalls = 0
      const mockStore = {
        save: async () => {
          saveCalls++
          return 'artifact-dup'
        },
      } as any

      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`).join('\n')
      const result = await tierToolResult('grep', lines, 'src/', mockStore, 1_000_000, 'artifact-orig')

      assert.equal(result.tier, 1)
      assert.equal(result.artifactId, 'artifact-orig')
      assert.ok(result.content.includes('[artifact:artifact-orig]'))
      assert.equal(saveCalls, 0)
    })
  })

  describe('extractTrailingArtifactId', () => {
    it('extracts a trailing artifact reference', () => {
      assert.equal(extractTrailingArtifactId('big content\n[artifact:abc-123]'), 'abc-123')
      assert.equal(extractTrailingArtifactId('big content\n[artifact:abc-123]\n'), 'abc-123')
    })

    it('returns undefined when the reference is not trailing', () => {
      assert.equal(extractTrailingArtifactId('[artifact:abc-123] then more text'), undefined)
      assert.equal(extractTrailingArtifactId('no artifact here'), undefined)
    })
  })
})
