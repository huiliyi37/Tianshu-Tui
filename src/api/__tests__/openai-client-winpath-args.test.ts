import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

// Regression: models writing Windows paths emit raw backslashes in tool_call
// argument JSON (`"F:\智慧项目\src"`), which are invalid JSON escapes. Before
// the escape-repair pass, the whole buffer failed to parse and the call was
// flushed as input:{} + argsTruncated → the pipeline refused execution and the
// model looped re-emitting the same broken call (Windows desktop "write_file
// 卡住/创建不成功" reports). The stream layer must now repair and execute.

const CONFIG: OpenAIClientConfig = {
  baseUrl: 'x', apiKey: 'x', model: 'deepseek-v4-flash', maxTokens: 4096,
  sessionId: 'winpath-args-test',
}

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

describe('openai-client Windows-path tool arguments', () => {
  it('repairs raw-backslash Windows paths instead of flushing argsTruncated {}', async () => {
    // arguments contains literal `\智` and `\x` — invalid JSON escapes.
    const rawArgs = '{"file_path":"F:\\智慧项目\\hardware-saas\\src\\app.ts","content":"export {}\\n"}'
    assert.throws(() => JSON.parse(rawArgs), 'precondition: args must be invalid JSON as-is')
    const blocks = await runFrames([
      frame({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'w0', type: 'function', function: { name: 'write_file', arguments: rawArgs } },
      ] }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
    const toolUse = blocks.find(b => b.type === 'tool_use')
    assert.ok(toolUse, 'tool_use block emitted')
    assert.equal(toolUse.argsTruncated, undefined, 'must not be marked truncated')
    assert.equal(toolUse.input.file_path, 'F:\\智慧项目\\hardware-saas\\src\\app.ts')
    assert.equal(toolUse.input.content, 'export {}\n', 'valid \\n escape preserved')
  })
})
