import { describe, it, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createWriteEvidenceProbe,
  extractTargetPath,
  formatBytes,
  formatWriteRecoveryContent,
  isWriteProbeEnabled,
} from '../write-evidence-probe.js'
import { runResumePreflightOai } from '../resume-preflight.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('write-evidence-probe', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-write-probe-'))
    delete process.env.RIVET_WRITE_PROBE
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_WRITE_PROBE
  })

  it('extractTargetPath reads file_path from JSON string args', () => {
    assert.equal(
      extractTargetPath('{"file_path":"src/App.tsx","content":"<ptr>"}'),
      'src/App.tsx',
    )
  })

  it('formatBytes renders human sizes', () => {
    assert.equal(formatBytes(512), '512B')
    assert.equal(formatBytes(2048), '2.0KB')
  })

  it('formatWriteRecoveryContent uses disk evidence when file exists', () => {
    const text = formatWriteRecoveryContent('write_file', 'a.ts', { exists: true, bytes: 4096 })
    assert.ok(text.includes('磁盘证据'))
    assert.ok(text.includes('a.ts'))
    assert.ok(text.includes('4.0KB'))
    assert.ok(text.includes('直接继续'))
  })

  it('formatWriteRecoveryContent says safe to retry when file missing', () => {
    const text = formatWriteRecoveryContent('edit_file', 'b.tsx', { exists: false, bytes: 0 })
    assert.ok(text.includes('不存在'))
    assert.ok(text.includes('可安全重试'))
  })

  it('createWriteEvidenceProbe returns exists+bytes for an on-disk file', () => {
    const rel = 'probe-target.ts'
    writeFileSync(join(tempDir, rel), 'export const x = 1\n', 'utf-8')
    const probe = createWriteEvidenceProbe(tempDir)
    const ev = probe('write_file', { file_path: rel })
    assert.ok(ev)
    assert.equal(ev!.exists, true)
    assert.ok(ev!.bytes > 0)
  })

  it('createWriteEvidenceProbe returns exists:false for a missing file', () => {
    const probe = createWriteEvidenceProbe(tempDir)
    const ev = probe('write_file', { file_path: 'missing.tsx' })
    assert.deepEqual(ev, { exists: false, bytes: 0 })
  })

  it('createWriteEvidenceProbe rejects path escape', () => {
    const probe = createWriteEvidenceProbe(tempDir)
    assert.equal(probe('write_file', { file_path: '../../etc/passwd' }), undefined)
  })

  it('RIVET_WRITE_PROBE=0 disables the probe', () => {
    process.env.RIVET_WRITE_PROBE = '0'
    writeFileSync(join(tempDir, 'on.ts'), 'x', 'utf-8')
    const probe = createWriteEvidenceProbe(tempDir)
    assert.equal(probe('write_file', { file_path: 'on.ts' }), undefined)
    assert.equal(isWriteProbeEnabled(), false)
  })
})

describe('runResumePreflightOai + write probe', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-preflight-probe-'))
    delete process.env.RIVET_WRITE_PROBE
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_WRITE_PROBE
  })

  it('embeds disk evidence in synthetic write-tool result when file exists', () => {
    const rel = 'src/Widget.tsx'
    mkdirSync(join(tempDir, 'src'), { recursive: true })
    writeFileSync(join(tempDir, rel), '<div />', 'utf-8')

    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_w', type: 'function', function: { name: 'write_file', arguments: `{"file_path":"${rel}"}` } },
      ]},
    ]
    const report = runResumePreflightOai(messages, { writeProbe: createWriteEvidenceProbe(tempDir) })
    const toolResult = report.messages.find(
      (m): m is OaiMessage & { role: 'tool'; tool_call_id: string; content: string } =>
        m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'tc_w',
    )
    assert.ok(toolResult)
    const text = String(toolResult.content)
    assert.ok(text.includes('磁盘证据'))
    assert.ok(text.includes(rel))
    assert.ok(text.includes('直接继续'))
  })

  it('reports missing file when probe sees no on-disk target', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_w', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"gone.js"}' } },
      ]},
    ]
    const report = runResumePreflightOai(messages, { writeProbe: createWriteEvidenceProbe(tempDir) })
    const toolResult = report.messages.find(
      (m): m is OaiMessage & { role: 'tool'; tool_call_id: string; content: string } =>
        m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'tc_w',
    )
    assert.ok(toolResult)
    const text = String(toolResult.content)
    assert.ok(text.includes('不存在'))
    assert.ok(text.includes('可安全重试'))
  })
})
