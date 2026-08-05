import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { firePrefixPrewarm } from '../prefix-prewarm.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'

const HISTORY: OaiMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
]

describe('firePrefixPrewarm (P3)', () => {
  it('builds the request with sidePath history + a trailing ping, max_tokens=1', async () => {
    let capturedMessages: OaiMessage[] = []
    let capturedRequest: OaiChatRequest | undefined
    const client = {
      stream: mock.fn(async (request: OaiChatRequest) => { capturedRequest = request }),
    }
    let result: { ok: boolean; elapsedMs: number; error?: string } | undefined

    firePrefixPrewarm({
      client,
      getMessages: () => HISTORY,
      buildRequest: messages => {
        capturedMessages = messages
        return { model: 'deepseek-v4-flash', messages, max_tokens: 999_999 }
      },
      onResult: r => { result = r },
    })

    // fire-and-forget: give the microtask queue a turn to settle the .then()
    await new Promise(r => setTimeout(r, 0))

    assert.equal(capturedMessages.length, HISTORY.length + 1, 'must append exactly one synthetic ping after the real history')
    assert.deepEqual(capturedMessages.slice(0, HISTORY.length), HISTORY, 'real history must be passed through untouched (byte-stable prefix)')
    assert.equal(capturedMessages[HISTORY.length]!.role, 'user', 'the synthetic ping must be a user message (valid trailing role)')
    assert.equal(capturedRequest?.max_tokens, 1, 'must override max_tokens to 1 regardless of what buildRequest returned')
    assert.equal(client.stream.mock.calls.length, 1)
    assert.equal(result?.ok, true)
  })

  it('does not throw and reports failure via onResult when buildRequest throws', () => {
    let result: { ok: boolean; error?: string } | undefined
    assert.doesNotThrow(() => {
      firePrefixPrewarm({
        client: { stream: mock.fn(async () => {}) },
        getMessages: () => HISTORY,
        buildRequest: () => { throw new Error('boom') },
        onResult: r => { result = r },
      })
    })
    assert.equal(result?.ok, false)
    assert.ok(result?.error?.includes('boom'))
  })

  it('does not throw and reports failure via onResult when client.stream rejects', async () => {
    let result: { ok: boolean; error?: string } | undefined
    firePrefixPrewarm({
      client: { stream: mock.fn(async () => { throw new Error('network down') }) },
      getMessages: () => HISTORY,
      buildRequest: messages => ({ model: 'deepseek-v4-flash', messages }),
      onResult: r => { result = r },
    })
    await new Promise(r => setTimeout(r, 0))
    assert.equal(result?.ok, false)
    assert.ok(result?.error?.includes('network down'))
  })

  it('is fire-and-forget: returns synchronously without waiting for client.stream', () => {
    let streamResolved = false
    const client = {
      stream: () => new Promise<void>(resolve => {
        setTimeout(() => { streamResolved = true; resolve() }, 50)
      }),
    }
    firePrefixPrewarm({
      client,
      getMessages: () => HISTORY,
      buildRequest: messages => ({ model: 'deepseek-v4-flash', messages }),
    })
    // If firePrefixPrewarm awaited internally, streamResolved would already be true here.
    assert.equal(streamResolved, false, 'must return before the underlying stream() settles')
  })
})
