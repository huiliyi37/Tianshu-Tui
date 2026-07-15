import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL } from '../bash.js'

// W0/W1-A1 RED baseline → GREEN gate: bash raw persistence must not lose the
// head of large outputs. The in-memory preview may truncate to a tail (model
// view policy is unchanged), but the recovery path (rawPath / artifact raw)
// must contain BOTH head and tail up to the spool cap. Before the bounded
// spool fix, stdout was truncated to the last 24KB *before* persistence, so
// rawPath silently lost the head while claiming "full output at rawPath".

const HEAD_SENTINEL = 'RIVET_HEAD_SENTINEL_7f3a'
const TAIL_SENTINEL = 'RIVET_TAIL_SENTINEL_9c2e'

describe('bash raw output recovery (bounded spool)', () => {
  it('rawPath preserves head AND tail for a 40K output that exceeds the 32K preview cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-spool-'))
    try {
      const script = `process.stdout.write('${HEAD_SENTINEL}\\n' + 'x'.repeat(40000) + '\\n${TAIL_SENTINEL}')`
      const result = await BASH_TOOL.execute({
        input: { command: `node -e "${script}"` },
        toolUseId: 'bash-spool-headtail-test',
        cwd: dir,
      })
      assert.equal(result.isError, false)
      assert.ok(result.rawPath, 'rawPath must be present for persisted output')
      const raw = readFileSync(result.rawPath!, 'utf-8')
      assert.ok(raw.includes(TAIL_SENTINEL), 'recovery content must contain the tail sentinel')
      assert.ok(
        raw.includes(HEAD_SENTINEL),
        'recovery content must contain the HEAD sentinel — head loss before persistence is the A1 defect',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('model preview stays bounded (tail view) while recovery is complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-spool-preview-'))
    try {
      const script = `process.stdout.write('${HEAD_SENTINEL}\\n' + 'y'.repeat(60000) + '\\n${TAIL_SENTINEL}')`
      const result = await BASH_TOOL.execute({
        input: { command: `node -e "${script}"` },
        toolUseId: 'bash-spool-preview-test',
        cwd: dir,
      })
      // Model view policy unchanged: bounded, tail-biased.
      assert.ok(result.content.length < 40_000, 'model content must stay bounded')
      assert.ok(result.content.includes(TAIL_SENTINEL), 'model preview keeps the tail')
      // Recovery completeness lives in rawPath.
      const raw = readFileSync(result.rawPath!, 'utf-8')
      assert.ok(raw.includes(HEAD_SENTINEL), 'rawPath must retain the head')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('9 MiB output: spool caps honestly — no false "full output" claim, head retained up to cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-spool-cap-'))
    try {
      // 9 MiB > 8 MiB spool cap. Write in chunks to avoid a single giant argv string.
      const script =
        `process.stdout.write('${HEAD_SENTINEL}\\n');` +
        `const chunk = 'z'.repeat(65536);` +
        `for (let i = 0; i < 144; i++) process.stdout.write(chunk);` + // 144 * 64KiB = 9 MiB
        `process.stdout.write('\\n${TAIL_SENTINEL}')`
      const result = await BASH_TOOL.execute({
        input: { command: `node -e "${script}"`, timeout: 120_000 },
        toolUseId: 'bash-spool-cap-test',
        cwd: dir,
      })
      assert.equal(result.isError, false)
      assert.ok((result.rawBytes ?? 0) > 9_000_000, 'raw byte accounting counts the full stream')
      const raw = readFileSync(result.rawPath!, 'utf-8')
      assert.ok(raw.includes(HEAD_SENTINEL), 'head retained up to the spool cap')
      assert.ok(
        raw.includes('[raw capture capped'),
        'capped capture must be explicitly declared — no silent "full output" claim',
      )
      // Bounded: persisted file must not grow linearly with input beyond cap + notes.
      assert.ok(raw.length < 9 * 1024 * 1024, 'persisted raw must be bounded by the spool cap')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
