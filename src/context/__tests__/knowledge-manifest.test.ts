/**
 * Knowledge manifest 路由地图块测试（Wave 4b 知识重构）。
 *
 * 契约：manifest.md → 摘要索引（doc → load_when 触发词），字节稳定纯函数，
 * 只留"何时召回什么"，不留知识本文。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadKnowledgeManifestBlock, parseKnowledgeManifest } from '../knowledge-manifest.js'

const SAMPLE = `# Rivet Knowledge Manifest

## Prompt and memory hygiene

### .rivet/knowledge/prompt.md
- kind: prompt-history-reference
- contents: historical session records
- load_when:
  - modifying static prompt (src/prompt/static.ts)
  - modifying volatile prompt construction
  - discussing prompt weight or prefix cache impact
  - a fourth trigger that should be dropped by the per-doc cap

### .rivet/knowledge/testing.md
- kind: testing-conventions-reference
- load_when:
  - modifying test infrastructure

### .rivet/knowledge/session-retro.md
- kind: session-retrospective
- load_when: discussing chat mode or identity behavior

### .rivet/knowledge/no-triggers.md
- kind: orphan-doc
- contents: has no load_when section
`

function writeManifest(cwd: string, content: string): void {
  const dir = join(cwd, '.rivet', 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.md'), content, 'utf-8')
}

describe('knowledge-manifest', () => {
  it('parses doc sections with multi-line and inline load_when triggers', () => {
    const docs = parseKnowledgeManifest(SAMPLE)
    assert.deepEqual(docs.map(d => d.path), [
      '.rivet/knowledge/prompt.md',
      '.rivet/knowledge/testing.md',
      '.rivet/knowledge/session-retro.md',
    ])
    assert.equal(docs[0]!.triggers.length, 4)
    assert.equal(docs[0]!.triggers[0], 'modifying static prompt (src/prompt/static.ts)')
    assert.deepEqual(docs[2]!.triggers, ['discussing chat mode or identity behavior'])
  })

  it('renders index-only block: triggers present, knowledge bodies absent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-manifest-'))
    try {
      writeManifest(cwd, SAMPLE)
      const block = loadKnowledgeManifestBlock(cwd)

      assert.match(block, /^<knowledge-manifest docs="3">/)
      assert.match(block, /\.rivet\/knowledge\/prompt\.md/)
      assert.match(block, /modifying test infrastructure/)
      // 无触发词的 doc 不入索引
      assert.doesNotMatch(block, /no-triggers\.md/)
      // 每 doc 触发词上限 3——第四条被裁掉
      assert.doesNotMatch(block, /fourth trigger/)
      // kind/contents 等知识本文不进 prompt
      assert.doesNotMatch(block, /prompt-history-reference/)
      assert.doesNotMatch(block, /historical session records/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('is byte-stable: same file content → identical output', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-manifest-'))
    try {
      writeManifest(cwd, SAMPLE)
      const a = loadKnowledgeManifestBlock(cwd)
      const b = loadKnowledgeManifestBlock(cwd)
      assert.equal(a, b)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns empty string when manifest is absent or has no routable docs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-manifest-'))
    try {
      assert.equal(loadKnowledgeManifestBlock(cwd), '')
      writeManifest(cwd, '# Empty manifest\n\nJust prose, no sections.\n')
      assert.equal(loadKnowledgeManifestBlock(cwd), '')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('respects the block budget with many docs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-manifest-'))
    try {
      const many = Array.from({ length: 100 }, (_, i) => `### docs/design/doc-${i}.md
- load_when:
  - modifying subsystem number ${i} with a reasonably long trigger description
`).join('\n')
      writeManifest(cwd, `# M\n\n${many}`)
      const block = loadKnowledgeManifestBlock(cwd)
      assert.ok(block.length <= 2_300, `block stays within budget, got ${block.length}`)
      assert.match(block, /doc-0\.md/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
