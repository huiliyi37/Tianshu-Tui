import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

// Always-on observability for the parallel tool_call argument-pollution class
// of bug. The streaming layer writes a JSONL event log per session WITHOUT
// requiring RIVET_DEBUG — this is what makes the bug class diagnosable next
// time (the original 384919c7 incident left zero trace because no debug flags
// were on). These tests pin: (1) pollution-risk events land on disk, (2) a
// healthy stream writes nothing.

const CONFIG: OpenAIClientConfig = {
  baseUrl: 'x', apiKey: 'x', model: 'deepseek-v4-flash', maxTokens: 4096,
  sessionId: 'obs-test-session',
}

let workdir: string
let origCwd: string

function frame(obj: unknown): string { return `data: ${JSON.stringify(obj)}\n\n` }

async function runFrames(frames: string[]): Promise<any[]> {
  const client = new OpenAIClient(CONFIG)
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  const response = new Response(stream)
  const blocks: any[] = []
  await (client as any).parseStreamFromReader(
    response.body!.getReader(),
    { onTextDelta: () => {}, onContentBlock: (b: any) => { blocks.push(b) } },
  )
  return blocks
}

describe('tool-stream event log (observability)', () => {
  before(() => {
    origCwd = process.cwd()
    workdir = mkdtempSync(join(tmpdir(), 'rivet-obs-'))
    process.chdir(workdir)
  })
  after(() => {
    process.chdir(origCwd)
    rmSync(workdir, { recursive: true, force: true })
  })

  it('ambiguous continuation chunk (multiple open buffers) → drop-ambiguous logged', async () => {
    await runFrames([
      frame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'c0', type: 'function', function: { name: 'read_section', arguments: '{"file_path":"a.ts","section":"L1-L10"}' } },
        { index: 1, id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"path":"src","pattern":"foo"}' } },
      ] }, finish_reason: null }] }),
      // Ambiguous trailing fragment: no index, no id, both buffers still open → dropped.
      frame({ choices: [{ delta: { tool_calls: [
        { function: { arguments: ',"extra":"orphan"}' } },
      ] }, finish_reason: 'tool_calls' }] }),
    ])
    const logPath = join(workdir, '.rivet', 'tool-stream-obs-test-session.jsonl')
    assert.ok(existsSync(logPath), 'event log must be created on pollution-risk event')
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    const events = lines.map(l => JSON.parse(l))
    const drop = events.find((e: any) => e.phase === 'drop-ambiguous')
    assert.ok(drop, `drop-ambiguous event must be logged, got phases: ${events.map((e: any) => e.phase).join(',')}`)
    assert.equal(drop.openBuffers, 2, 'must record how many buffers were open (the risk signal)')
    assert.equal(drop.model, 'deepseek-v4-flash', 'must record the model for provider attribution')
  })

  it('reattach by id → reattach-by-id logged', async () => {
    await runFrames([
      frame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'c0', type: 'function', function: { name: 'grep', arguments: '{"path":"src",' } },
      ] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      // Continuation chunk carries the id → reattach-by-id.
      frame({ choices: [{ delta: { tool_calls: [
        { id: 'c0', function: { arguments: '"pattern":"bar"}' } },
      ] }, finish_reason: null }] }),
    ])
    const logPath = join(workdir, '.rivet', 'tool-stream-obs-test-session.jsonl')
    const events = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const reattach = events.find((e: any) => e.phase === 'reattach-by-id')
    assert.ok(reattach, 'reattach-by-id event must be logged')
    assert.equal(reattach.id, 'c0')
  })

  it('final-flush empty (unparseable args) → final-flush-empty logged + argsTruncated marker', async () => {
    // A tool_call whose arguments never become valid JSON → final flush emits
    // input:{} and logs the event. This is the direct fingerprint of a
    // pollution-induced parse failure reaching the tool layer. The emitted
    // block MUST carry argsTruncated so the pipeline refuses to execute the
    // {} placeholder (session 4df36bcd: truncated bash call ran as {}).
    const blocks = await runFrames([
      frame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'c0', type: 'function', function: { name: 'grep', arguments: '{"path":"src",' } },
      ] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      // [DONE] arrives; args stay incomplete → final flush empty.
    ])
    const logPath = join(workdir, '.rivet', 'tool-stream-obs-test-session.jsonl')
    const events = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const empty = events.find((e: any) => e.phase === 'final-flush-empty')
    assert.ok(empty, 'final-flush-empty event must be logged for the {} tool_use')
    assert.equal(empty.name, 'grep')
    assert.ok(empty.argsLen > 0, 'must record the incomplete args length for diagnosis')

    const tu = blocks.find(b => b.type === 'tool_use' && b.name === 'grep')
    assert.ok(tu, 'the tool_use block must still be emitted (history needs the pair)')
    assert.equal(tu.argsTruncated, true, 'block must be marked argsTruncated for the pipeline')
    assert.deepEqual(tu.input, {})
  })

  it('final-flush empty does NOT leak [tool-arg-parse-failure] to stderr (TUI safety)', async () => {
    // The parse failure must be surfaced to the model via the argsTruncated
    // tool_use block + tool_result error, not by writing directly to stderr
    // where it corrupts the TUI render.
    const origDebug = process.env.RIVET_DEBUG
    delete process.env.RIVET_DEBUG
    const warns: unknown[][] = []
    const origConsoleWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(args) }
    try {
      await runFrames([
        frame({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'leak-check', type: 'function', function: { name: 'grep', arguments: '{"path":"src",' } },
        ] }, finish_reason: null }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ])
      const leaked = warns.some(args =>
        args.some(a => typeof a === 'string' && a.includes('[tool-arg-parse-failure]')),
      )
      assert.equal(leaked, false, '[tool-arg-parse-failure] must not be written to console.warn in non-debug mode')
    } finally {
      console.warn = origConsoleWarn
      if (origDebug !== undefined) process.env.RIVET_DEBUG = origDebug
    }
  })

  it('healthy parse → no argsTruncated marker on the block', async () => {
    const blocks = await runFrames([
      frame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'c9', type: 'function', function: { name: 'grep', arguments: '{"path":"src","pattern":"x"}' } },
      ] }, finish_reason: 'tool_calls' }] }),
    ])
    const tu = blocks.find(b => b.type === 'tool_use' && b.id === 'c9')
    assert.ok(tu)
    assert.equal(tu.argsTruncated, undefined, 'clean parse must not set the marker')
  })

  it('healthy stream (every chunk has index, parses cleanly) → no event log written', async () => {
    // A brand-new session id so it gets its own (nonexistent) log file.
    const healthy = { ...CONFIG, sessionId: 'obs-healthy-session' }
    const client = new OpenAIClient(healthy)
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frame({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'h0', type: 'function', function: { name: 'grep', arguments: '{"path":"src","pattern":"x"}' } },
        ] }, finish_reason: 'tool_calls' }] })))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    await (client as any).parseStreamFromReader(
      new Response(stream).body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: () => {} },
    )
    const logPath = join(workdir, '.rivet', 'tool-stream-obs-healthy-session.jsonl')
    assert.ok(!existsSync(logPath), 'a healthy stream must NOT create an event log (no noise)')
  })
})
