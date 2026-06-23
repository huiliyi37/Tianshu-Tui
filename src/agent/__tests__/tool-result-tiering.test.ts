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

    it('returns tier 1 collapsed summary for medium read_file content in 1M window', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`).join('\n')
      assert.ok(lines.length > 8_000)
      assert.ok(lines.length < 150_000)

      const result = await tierToolResult('read_file', lines, 'big.ts', undefined, 1_000_000)
      assert.equal(result.tier, 1)
      // read_file now uses collapseReadFileResult → [collapsed read_file: ...]
      assert.ok(result.content.includes('[collapsed read_file:'))
      assert.ok(result.content.length < lines.length)
      assert.equal(result.originalChars, lines.length)
    })

    it('returns tier 1 head+tail fallback for unhandled tool types', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`).join('\n')
      assert.ok(lines.length > 8_000)

      // delegate_task is not in compressByToolType → falls back to head+tail
      const result = await tierToolResult('delegate_task', lines, 'task-1', undefined, 1_000_000)
      assert.equal(result.tier, 1)
      assert.ok(result.content.includes('[tiered-summary:'))
      assert.ok(result.content.includes('lines omitted'))
      assert.ok(result.content.length < lines.length)
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

  describe('content-type-aware compression (Tier 1)', () => {
    it('grep output: collapses to file-name + count summary', async () => {
      // Simulate grep output: multiple files with matches (enough to exceed 8K)
      const matches: string[] = []
      for (let f = 0; f < 20; f++) {
        for (let m = 0; m < 15; m++) {
          matches.push(`src/path/module${f}.ts:${m * 10 + 1}:const value_${f}_${m} = some long data here for padding`)
        }
      }
      const content = matches.join('\n')
      assert.ok(content.length > 8_000)

      const result = await tierToolResult('grep', content, 'src/', undefined, 1_000_000)
      assert.equal(result.tier, 1)
      assert.ok(result.content.includes('[collapsed grep:'), `got: ${result.content.slice(0, 100)}`)
      assert.ok(result.content.includes('matches'))
      assert.ok(result.content.includes('files'))
      // Should be much smaller than original
      assert.ok(result.content.length < content.length * 0.2)
    })

    it('bash test output: preserves fail lines in collapse summary', async () => {
      const lines: string[] = []
      for (let i = 0; i < 300; i++) {
        lines.push(`✔ test_${i} (passed in ${i}ms with some extra padding text here)`)
      }
      lines.push('FAIL test_critical: expected 42 but got 24')
      lines.push('AssertionError: values do not match')
      lines.push('exit code: 1')
      const content = lines.join('\n')
      assert.ok(content.length > 8_000)

      const result = await tierToolResult('bash', content, '/tmp/test', undefined, 1_000_000)
      assert.equal(result.tier, 1)
      assert.ok(result.content.includes('[collapsed bash:'), `got: ${result.content.slice(0, 100)}`)
      // Fail line must be preserved — it's the highest-signal info
      assert.ok(result.content.includes('FAIL'), `fail line missing in: ${result.content}`)
      assert.ok(result.content.includes('AssertionError'), `error line missing in: ${result.content}`)
    })

    it('read_file output: extracts function/class signatures', async () => {
      const lines: string[] = []
      // Padding before signatures (enough to exceed 8K total)
      for (let i = 0; i < 50; i++) lines.push(`// comment line ${i} with extra padding for byte threshold`)
      lines.push('export function handleRequest(req: Request): Response {')
      for (let i = 0; i < 100; i++) lines.push(`  const x${i} = ${i}`)
      lines.push('}')
      lines.push('export class UserService {')
      for (let i = 0; i < 100; i++) lines.push(`  field${i} = ${i}`)
      lines.push('}')
      // Padding after
      for (let i = 0; i < 200; i++) lines.push(`// trailing ${i} with padding for threshold`)
      const content = lines.join('\n')
      assert.ok(content.length > 8_000)

      const result = await tierToolResult('read_file', content, 'big.ts', undefined, 1_000_000)
      assert.equal(result.tier, 1)
      assert.ok(result.content.includes('[collapsed read_file:'), `got: ${result.content.slice(0, 100)}`)
      assert.ok(result.content.includes('handleRequest'), `function name missing in: ${result.content}`)
      assert.ok(result.content.includes('UserService'), `class name missing in: ${result.content}`)
    })

    it('unknown tool type: falls back to head+tail (not generic collapse)', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'data'.repeat(10)}`).join('\n')
      assert.ok(lines.length > 8_000)

      const result = await tierToolResult('custom_tool', lines, 'target', undefined, 1_000_000)
      assert.equal(result.tier, 1)
      // Should use head+tail, not collapseGenericResult
      assert.ok(result.content.includes('[tiered-summary:'), `got: ${result.content.slice(0, 100)}`)
      assert.ok(result.content.includes('lines omitted'))
    })

    it('Tier 0: small results bypass content-type compression entirely', async () => {
      const content = 'export function small() { return 42 }'
      const result = await tierToolResult('read_file', content, 'small.ts', undefined, 1_000_000)
      assert.equal(result.tier, 0)
      assert.equal(result.content, content)
    })

    it('artifact reference preserved after content-type compression', async () => {
      const matches: string[] = []
      for (let f = 0; f < 20; f++) {
        for (let m = 0; m < 15; m++) {
          matches.push(`src/path/module${f}.ts:${m * 10 + 1}:const value_${f}_${m} = padding data here`)
        }
      }
      const content = matches.join('\n')
      assert.ok(content.length > 8_000)

      const result = await tierToolResult('grep', content, 'src/', undefined, 1_000_000, 'existing-art')
      assert.equal(result.tier, 1)
      assert.ok(result.content.includes('[artifact:existing-art]'), `artifact ref missing in: ${result.content}`)
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
