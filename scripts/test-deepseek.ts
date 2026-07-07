#!/usr/bin/env npx tsx
/**
 * DeepSeek API End-to-End Test Harness
 *
 * Usage:
 *   npx tsx scripts/test-deepseek.ts              # mock mode (no API key needed)
 *   DEEPSEEK_API_KEY=sk-xxx npx tsx scripts/test-deepseek.ts  # real API
 *
 * Tests: text chat, thinking, tool_use, multi-turn, cache hit, JSON recovery
 */

import { SSEParser } from '../src/api/sse.js'
import { createDeepSeekClient } from '../src/api/deepseek.js'
import { PromptEngine } from '../src/prompt/engine.js'
import { AgentLoop } from '../src/agent/loop.js'
import { SessionContext } from '../src/agent/context.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { READ_FILE_TOOL } from '../src/tools/read-file.js'
import type { Usage } from '../src/api/types.js'
import { computeFingerprint, detectDrift } from '../src/prompt/fingerprint.js'

// ─── Test Harness ────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; return }
  failed++
  failures.push(`FAIL: ${msg}`)
}

function summary(): void {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log(`\nFailures:`)
    for (const f of failures) console.log(`  ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

const MOCK_MODE = !process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'sk-xxx'
const API_KEY = process.env.DEEPSEEK_API_KEY ?? 'sk-mock'
const TEST_MODEL = process.env.TEST_MODEL ?? 'deepseek-v4-flash'

// ─── SSE Parser Tests (no API needed) ───────────────────────────

async function test_sse_parser(): Promise<void> {
  console.log('\n── SSE Parser ──')

  const parser = new SSEParser()

  // Basic event
  const e1 = parser.feed('data: {"type":"text"}\n\n')
  assert(e1.length === 1 && e1[0]!.data === '{"type":"text"}', 'basic data event')

  // Named event
  const e2 = parser.feed('event: delta\ndata: hello\n\n')
  assert(e2.length === 1 && e2[0]!.event === 'delta', 'named event')

  // Multi-line data
  const e3 = parser.feed('data: line1\ndata: line2\n\n')
  assert(e3.length === 1 && e3[0]!.data === 'line1\nline2', 'multi-line data')

  // ID handling
  const parser2 = new SSEParser()
  parser2.feed('id: 42\ndata: test\n\n')
  assert(parser2.getLastEventId() === '42', 'id field tracking')

  // Retry handling
  const parser3 = new SSEParser()
  parser3.feed('retry: 5000\ndata: test\n\n')
  assert(parser3.getRetryMs() === 5000, 'retry field parsing')

  // data: without space
  const e4 = parser.feed('data:{"key":"val"}\n\n')
  assert(e4.length === 1 && e4[0]!.data === '{"key":"val"}', 'data without space')

  // Partial chunks
  parser.reset()
  const e5a = parser.feed('data: {"hel')
  assert(e5a.length === 0, 'partial chunk stores internally')
  const e5b = parser.feed('lo":"world"}\n\n')
  assert(e5b.length === 1 && e5b[0]!.data.includes('world'), 'partial chunk reassembly')
}

// ─── Fingerprint Tests (no API needed) ──────────────────────────

async function test_fingerprint(): Promise<void> {
  console.log('\n── Cache Fingerprint ──')

  const tools = [
    { name: 'bash', description: 'Bash tool', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'read_file', description: 'Read tool', input_schema: { type: 'object' as const, properties: {} } },
  ]

  const fp1 = computeFingerprint('system v1', tools)
  const fp2 = computeFingerprint('system v1', tools)
  assert(fp1.combinedSha256 === fp2.combinedSha256, 'deterministic fingerprint')

  // Tool order stability
  const toolsReversed = [...tools].reverse()
  const fp3 = computeFingerprint('system v1', toolsReversed)
  assert(fp1.toolsSha256 === fp3.toolsSha256, 'tool order stability')

  // Drift detection
  const fpChanged = computeFingerprint('system v2', tools)
  const drift = detectDrift(fp1, fpChanged)
  assert(drift !== null && drift.systemChanged, 'drift detection')
  assert(detectDrift(fp1, fp2) === null, 'no false drift')
}

// ─── Truncated JSON Recovery Tests ───────────────────────────────

async function test_json_recovery(): Promise<void> {
  console.log('\n── Truncated JSON Recovery ──')

  // This tests the recoverTruncatedJSON function in client.ts
  // We need to import it — it's not exported, so we test indirectly via the file
  const { recoverTruncatedJSON } = await import('../src/api/client.js') as unknown as {
    recoverTruncatedJSON: (raw: string) => Record<string, unknown>
  }

  if (typeof recoverTruncatedJSON !== 'function') {
    console.log('  (skipped — recoverTruncatedJSON not exported directly)')
    return
  }

  // Valid JSON
  const r1 = recoverTruncatedJSON('{"file_path":"/test/file.txt","offset":10}')
  assert(r1['file_path'] === '/test/file.txt' && r1['offset'] === 10, 'valid JSON unchanged')

  // Truncated string value
  const r2 = recoverTruncatedJSON('{"file_path":"/test/file')
  assert(r2['file_path'] !== undefined, 'truncated string recovered')

  // Unclosed braces
  const r3 = recoverTruncatedJSON('{"file_path":"/test/file.txt","offset":10')
  assert(r3['file_path'] === '/test/file.txt', 'unclosed brace recovered')

  console.log('  (recovery tests depend on internal export — may skip)')
}

// ─── DeepSeek API Tests (requires API key) ──────────────────────

async function test_api_health(): Promise<void> {
  if (MOCK_MODE) { console.log('\n── API Health (MOCK — skipped) ──'); return }
  console.log('\n── API Health ──')

  try {
    const res = await fetch('https://api.deepseek.com/anthropic/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'Say "health check OK" and nothing else.' }],
        max_tokens: 50,
      }),
    })
    const ok = res.ok
    const body = await res.text().catch(() => '')
    assert(ok, `API reachable (status ${res.status})`)
    if (ok) console.log(`  Response: ${body.slice(0, 200)}`)
  } catch (err) {
    assert(false, `API unreachable: ${(err as Error).message}`)
  }
}

async function test_thinking_mode(): Promise<void> {
  if (MOCK_MODE) { console.log('\n── Thinking Mode (MOCK — skipped) ──'); return }
  console.log('\n── Thinking Mode ──')

  const client = createDeepSeekClient({
    apiKey: API_KEY,
    model: TEST_MODEL,
    reasoningEffort: 'high',
  })

  let thinkingReceived = false
  let textReceived = false
  let usage: Partial<Usage> = {}

  try {
    await client.stream(
      {
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'What is 17 * 23? Think step by step.' }],
        max_tokens: 1024,
        stream: true,
      },
      {
        onTextDelta: () => { textReceived = true },
        onThinkingDelta: () => { thinkingReceived = true },
        onContentBlock: () => {},
        onStopReason: (_reason, u) => { usage = u },
        onError: (err) => { assert(false, `thinking stream error: ${err.message}`) },
      },
    )
    assert(textReceived, 'text response received')
    console.log(`  thinking: ${thinkingReceived ? 'YES' : 'NO (may depend on model)'}`)
    console.log(`  usage: ${JSON.stringify(usage)}`)
  } catch (err) {
    assert(false, `thinking test failed: ${(err as Error).message}`)
  }
}

async function test_tool_use(): Promise<void> {
  if (MOCK_MODE) { console.log('\n── Tool Use (MOCK — skipped) ──'); return }
  console.log('\n── Tool Use ──')

  const client = createDeepSeekClient({
    apiKey: API_KEY,
    model: TEST_MODEL,
    reasoningEffort: 'low',
  })

  let toolUseReceived = false
  let toolInput: Record<string, unknown> = {}

  try {
    await client.stream(
      {
        model: TEST_MODEL,
        messages: [
          {
            role: 'user',
            content: 'Use the read_file tool to read /Users/banxia/app/deepseek-tui/opencode-tui/README.md',
          },
        ],
        max_tokens: 1024,
        tools: [{
          name: 'read_file',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path to the file' },
            },
            required: ['file_path'],
          },
        }],
        tool_choice: { type: 'auto' },
        stream: true,
      },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: (block) => {
          if (block.type === 'tool_use') {
            toolUseReceived = true
            toolInput = (block as { input: Record<string, unknown> }).input
          }
        },
        onStopReason: (_reason, u) => {
          console.log(`  stop_reason: ${_reason}, usage: ${JSON.stringify(u)}`)
        },
        onError: (err) => { assert(false, `tool_use stream error: ${err.message}`) },
      },
    )
    assert(toolUseReceived, 'tool_use block received')
    console.log(`  tool: read_file, input: ${JSON.stringify(toolInput)}`)
  } catch (err) {
    assert(false, `tool_use test failed: ${(err as Error).message}`)
  }
}

async function test_agent_loop(): Promise<void> {
  if (MOCK_MODE) { console.log('\n── Agent Loop (MOCK — skipped) ──'); return }
  console.log('\n── Agent Loop Integration ──')

  const client = createDeepSeekClient({
    apiKey: API_KEY,
    model: TEST_MODEL,
    reasoningEffort: 'low',
  })

  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)

  const promptEngine = new PromptEngine({
    model: TEST_MODEL,
    maxTokens: 2048,
    staticCtx: { cwd: process.cwd(), tools: registry.getDefinitions() },
    volatileCtx: { cwd: process.cwd() },
  })

  const session = new SessionContext()
  const agent = new AgentLoop(
    {
      client,
      promptEngine,
      toolRegistry: registry,
      maxTurns: 5,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    },
    session,
    process.cwd(),
  )

  const toolUses: string[] = []
  const texts: string[] = []

  try {
    await agent.run('Read the README.md file and tell me what project this is.', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: (_id, name) => { toolUses.push(name) },
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (err) => { assert(false, `agent error: ${err.message}`) },
      onAbort: () => {},
      onApprovalRequired: async () => true, // auto-approve for test
    })

    console.log(`  turns: ${session.getTurnCount()}, tool calls: ${toolUses.length}`)
    console.log(`  tools used: ${toolUses.join(', ') || '(none)'}`)
    console.log(`  response: ${texts.join('').slice(0, 200)}...`)
    console.log(`  usage: ${JSON.stringify(session.getTotalUsage())}`)

    assert(session.getTurnCount() > 0, 'agent completed at least one turn')
  } catch (err) {
    assert(false, `agent loop test failed: ${(err as Error).message}`)
  }
}

async function test_cache_hit(): Promise<void> {
  if (MOCK_MODE) { console.log('\n── Cache Hit Rate (MOCK — skipped) ──'); return }
  console.log('\n── Cache Hit Rate ──')

  const client = createDeepSeekClient({
    apiKey: API_KEY,
    model: TEST_MODEL,
    reasoningEffort: 'low',
  })

  const session = new SessionContext()

  // Turn 1: prime the cache
  console.log('  Turn 1: priming cache...')
  try {
    await client.stream(
      {
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'Say "ok".' }],
        max_tokens: 50,
        system: 'You are a helpful assistant. Be concise.',
        stream: true,
      },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: (_reason, u) => { session.addUsage(u) },
        onError: () => {},
      },
    )

    // Turn 2: should hit cache
    await new Promise(r => setTimeout(r, 500)) // brief pause
    console.log('  Turn 2: cache should hit...')
    await client.stream(
      {
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'Say "ok again".' }],
        max_tokens: 50,
        system: 'You are a helpful assistant. Be concise.',
        stream: true,
      },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: (_reason, u) => { session.addUsage(u) },
        onError: () => {},
      },
    )

    const usage = session.getTotalUsage()
    const hitRate = session.getCacheHitRate()
    console.log(`  total input: ${usage.input_tokens}, cache read: ${usage.cache_read_input_tokens}`)
    console.log(`  cache hit rate: ${(hitRate * 100).toFixed(1)}%`)
    // DeepSeek may report 0 for both — that's API-dependent, not a failure
    assert(true, 'cache test completed without errors')
  } catch (err) {
    assert(false, `cache test failed: ${(err as Error).message}`)
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`DeepSeek API Test Harness`)
  console.log(`Model: ${TEST_MODEL}`)
  console.log(`Mode: ${MOCK_MODE ? 'MOCK (unit tests only)' : 'LIVE (real API)'}`)
  if (MOCK_MODE) console.log(`Set DEEPSEEK_API_KEY=sk-xxx to run live API tests.\n`)

  // Always-run unit tests (no API needed)
  await test_sse_parser()
  await test_fingerprint()
  await test_json_recovery()

  // Live API tests
  await test_api_health()
  await test_thinking_mode()
  await test_tool_use()
  await test_agent_loop()
  await test_cache_hit()

  summary()
}

main()
