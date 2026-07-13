/**
 * Vision bridge service tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import { describeImages } from '../vision-service.js'

function makeMockClient(text: string): StreamClient {
  return {
    async stream(request: OaiChatRequest, callbacks: StreamCallbacks) {
      // Verify the request carries the image parts.
      const userMsg = request.messages.find(m => m.role === 'user')
      assert.ok(userMsg, 'user message should exist')
      assert.ok(Array.isArray(userMsg.content), 'user message should be multimodal')
      const imageParts = userMsg.content.filter(p => p.type === 'image_url')
      assert.equal(imageParts.length, 1, 'one image_url part')

      callbacks.onTextDelta(text)
      callbacks.onStopReason('stop', {})
    },
  }
}

test('describeImages sends images and returns streamed text', async () => {
  const client = makeMockClient('A terminal screenshot showing a dark theme.')
  const result = await describeImages(client, ['data:image/png;base64,abc'])
  assert.equal(result, 'A terminal screenshot showing a dark theme.')
})

test('describeImages uses custom prompt', async () => {
  let capturedPrompt = ''
  const client: StreamClient = {
    async stream(request, callbacks) {
      const userMsg = request.messages.find(m => m.role === 'user')
      const textPart = Array.isArray(userMsg?.content)
        ? userMsg.content.find(p => p.type === 'text')
        : undefined
      capturedPrompt = textPart?.text ?? ''
      callbacks.onTextDelta('ok')
      callbacks.onStopReason('stop', {})
    },
  }
  await describeImages(client, ['data:image/png;base64,abc'], { prompt: 'What color is this?' })
  assert.equal(capturedPrompt, 'What color is this?')
})

test('describeImages returns empty for no images', async () => {
  const client = makeMockClient('should not be called')
  const result = await describeImages(client, [])
  assert.equal(result, '')
})

test('describeImages propagates errors', async () => {
  const client: StreamClient = {
    async stream(_request, callbacks) {
      callbacks.onError(new Error('vision model failed'))
    },
  }
  await assert.rejects(describeImages(client, ['data:image/png;base64,abc']), /vision model failed/)
})
