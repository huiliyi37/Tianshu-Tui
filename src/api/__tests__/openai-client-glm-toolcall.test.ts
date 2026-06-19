import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

// Regression coverage for the GLM-5.2 streaming tool-call data loss: grep
// received an empty `pattern` (→ "pattern is required") even though the model
// streamed the full arguments. Root cause: `flushToolCalls` ran on
// `finish_reason` while GLM was still streaming trailing argument deltas, and
// the silent `catch { input = {} }` fed an empty object to the tool.
//
// These drive the real SSE reader (parseStreamFromReader), which performs both
// the finish_reason flush and the end-of-stream flush, so the deferral fix is
// exercised exactly as in production.

const GLM_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-5.2',
  maxTokens: 4096,
  providerName: 'glm',
  thinking: 'enabled',
}

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

async function collectToolUses(client: OpenAIClient, frames: string[]): Promise<any[]> {
  const blocks: any[] = []
  const response = new Response(sseStream([...frames, 'data: [DONE]\n\n']))
  await (client as any).parseStreamFromReader(
    response.body!.getReader(),
    { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
  )
  return blocks.filter(b => b.type === 'tool_use')
}

const FULL_PATTERN = 'export function switchAgentRuntime|function switchAgentRuntime'

describe('GLM-5.2 tool-call streaming — grep empty pattern regression', () => {
  it('baseline: reasoning, complete tool_call, separate finish_reason', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { reasoning_content: 'searching switchAgentRuntime' }, finish_reason: null }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'grep', arguments: `{"context_lines":15,"path":"src/bootstrap.ts","pattern":"${FULL_PATTERN}"}` } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].input.pattern, FULL_PATTERN)
  })

  it('finish_reason in the same chunk as complete args', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"path":"src","pattern":"switchAgentRuntime"}' } }] }, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].input.pattern, 'switchAgentRuntime')
  })

  it('REGRESSION: finish_reason arrives before the trailing args chunk', async () => {
    // GLM emits id + name + partial args, fires finish_reason, THEN streams the
    // rest of the arguments. The fix must defer the empty parse and complete it
    // at the end-of-stream flush.
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"context_lines":15,"path":"src/bootstrap.ts","pattern":"export function ' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'switchAgentRuntime|function switchAgentRuntime"}' } }] }, finish_reason: null }] }),
    ])
    assert.equal(tools.length, 1, 'exactly one tool_use block')
    assert.equal(typeof tools[0].input.pattern, 'string', 'pattern must survive')
    assert.equal(tools[0].input.pattern, FULL_PATTERN)
  })

  it('REGRESSION: tc.index omitted on continuation chunks', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"path":"src/bootstrap.ts",' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"pattern":"switchAgentRuntime"}' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].input.pattern, 'switchAgentRuntime')
  })

  it('REGRESSION: two tool calls collide on index 0 — no empty-pattern block', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'grep', arguments: '{"path":"a","pattern":"foo"}' } }] }, finish_reason: null }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"path":"b","pattern":"bar"}' } }] }, finish_reason: 'tool_calls' }] }),
    ])
    for (const t of tools) {
      assert.equal(typeof t.input.pattern, 'string', `block ${t.id} input must keep a string pattern, got ${JSON.stringify(t.input)}`)
      assert.ok((t.input.pattern as string).length > 0, `block ${t.id} pattern must be non-empty`)
    }
  })

  it('genuine no-argument tool call still emits an empty-object input', async () => {
    const tools = await collectToolUses(new OpenAIClient(GLM_CONFIG), [
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'list_tools', arguments: '' } }] }, finish_reason: 'tool_calls' }] }),
    ])
    assert.equal(tools.length, 1)
    assert.deepEqual(tools[0].input, {})
  })
})
