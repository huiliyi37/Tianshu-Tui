import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PersistentStore } from '../../context/persistent-store.js'
import { createRecallTool } from '../recall.js'

describe('recall tool', () => {
  let dir: string
  let store: PersistentStore
  let tool: ReturnType<typeof createRecallTool>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    store = new PersistentStore(dir)
    store.archive({ toolName: 'bash', content: 'npm test: 705 passed', sessionId: 's1', roundNumber: 3 })
    store.archive({ toolName: 'read_file', content: 'export function main() {}', sessionId: 's1', roundNumber: 5 })
    tool = createRecallTool(store)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('retrieves by tool name', async () => {
    const result = await tool.execute({
      input: { query: '', type: 'tool_result', toolName: 'bash', limit: 5 },
      toolUseId: 'tu_1',
      cwd: '/test',
    })
    assert.match(result.content, /npm test/)
  })

  it('retrieves by keyword', async () => {
    const result = await tool.execute({
      input: { query: 'main', type: 'all', limit: 5 },
      toolUseId: 'tu_2',
      cwd: '/test',
    })
    assert.match(result.content, /export function main/)
  })

  it('returns empty message when no match', async () => {
    const result = await tool.execute({
      input: { query: 'nonexistent_xyz', type: 'all', limit: 5 },
      toolUseId: 'tu_3',
      cwd: '/test',
    })
    assert.match(result.content, /No archived results/)
  })
})
