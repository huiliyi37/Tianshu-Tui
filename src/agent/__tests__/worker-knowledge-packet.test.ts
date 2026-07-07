import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildMemoryKnowledgePacket, needsMemoryKnowledgePacket } from '../worker-knowledge-packet.js'

describe('worker knowledge packet', () => {
  it('detects memory-related objectives', () => {
    assert.equal(needsMemoryKnowledgePacket({ objective: 'Review project memory recall behavior', scope: {} }), true)
    assert.equal(needsMemoryKnowledgePacket({ objective: 'Inspect volatile prompt construction', scope: {} }), true)
    assert.equal(needsMemoryKnowledgePacket({ objective: 'Find TUI rendering seams', scope: {} }), false)
  })

  it('detects memory-related scope files', () => {
    assert.equal(needsMemoryKnowledgePacket({ objective: 'Review this file', scope: { files: ['src/context/project-memory-loader.ts'] } }), true)
    assert.equal(needsMemoryKnowledgePacket({ objective: 'Review this file', scope: { files: ['src/tools/recall.ts'] } }), true)
    assert.equal(needsMemoryKnowledgePacket({ objective: 'Review this file', scope: { files: ['src/tui/app.tsx'] } }), false)
  })

  it('builds a concrete reading packet for workers', () => {
    const packet = buildMemoryKnowledgePacket()

    assert.match(packet, /\.rivet\/knowledge\/manifest\.md/)
    assert.match(packet, /2026-06-01-project-memory-architecture-conflict\.md/)
    assert.match(packet, /2026-06-01-guided-memory-retrieval\.md/)
    assert.match(packet, /src\/context\/project-memory-loader\.ts/)
    assert.match(packet, /src\/tools\/recall\.ts/)
    assert.match(packet, /memory\.jsonl is local structured cache/)
    assert.match(packet, /Tier 1 injection is restricted/)
  })
})
