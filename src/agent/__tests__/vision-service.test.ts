/**
 * Vision bridge service tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import { describeImages, selectVisionPrompt } from '../vision-service.js'

/** 合法占位图：payload ≥64 字符，过 vision-service.ts:97 的截断校验
 *  （cc5f5f3d 起 fail-fast；此前用例的 ',abc' 占位已不合法）。 */
const VALID_IMAGE = 'data:image/png;base64,' + 'A'.repeat(128)

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
  const result = await describeImages(client, [VALID_IMAGE])
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
  await describeImages(client, [VALID_IMAGE], { prompt: 'What color is this?' })
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
  await assert.rejects(describeImages(client, [VALID_IMAGE]), /vision model failed/)
})

/**
 * 真实客户端契约：openai-client（MiniMax/GLM/DeepSeek 等全部 openai 协议 provider 走它）
 * 既逐段发 onTextDelta，又在收流结束时用 onContentBlock 把**同一段完整文本**再发一次。
 * 上面那些用例只调 onTextDelta，所以从没碰到这条路——描述被完整复制一遍的 bug 就是这么
 * 活下来的（实测 MiniMax-M3 一张截图返回 3516 字，一半是复本）。
 */
function makeRealisticClient(text: string, opts: { deltas?: boolean; block?: boolean } = {}): StreamClient {
  const { deltas = true, block = true } = opts
  return {
    async stream(_request, callbacks) {
      if (deltas) {
        for (let i = 0; i < text.length; i += 7) callbacks.onTextDelta(text.slice(i, i + 7))
      }
      if (block) callbacks.onContentBlock({ type: 'text', text })
      callbacks.onStopReason('stop', {})
    },
  }
}

test('describeImages 不把增量和终值块拼成两遍', async () => {
  const desc = '这是一个发布说明弹窗，标题 v2.24.3，右下角有 Got it 按钮。'
  const client = makeRealisticClient(desc)
  const result = await describeImages(client, [VALID_IMAGE])
  assert.equal(result, desc)
})

test('describeImages 在只有增量、没有终值块时退回增量拼接', async () => {
  const desc = 'streamed only'
  const client = makeRealisticClient(desc, { block: false })
  assert.equal(await describeImages(client, [VALID_IMAGE]), desc)
})

test('describeImages 在只有终值块、没有增量时也拿到文本', async () => {
  const desc = 'block only'
  const client = makeRealisticClient(desc, { deltas: false })
  assert.equal(await describeImages(client, [VALID_IMAGE]), desc)
})

test('describeImages 拼接多个终值文本块（codex 逐 part 发）', async () => {
  const client: StreamClient = {
    async stream(_request, callbacks) {
      callbacks.onContentBlock({ type: 'text', text: '第一段。' })
      callbacks.onContentBlock({ type: 'text', text: '第二段。' })
      callbacks.onStopReason('stop', {})
    },
  }
  assert.equal(await describeImages(client, [VALID_IMAGE]), '第一段。第二段。')
})

test('describeImages 截断标记只追加一次，且不因去重丢掉', async () => {
  const client: StreamClient = {
    async stream(_request, callbacks) {
      callbacks.onTextDelta('描述被切断了')
      callbacks.onContentBlock({ type: 'text', text: '描述被切断了' })
      callbacks.onStopReason('length', {})
    },
  }
  const result = await describeImages(client, [VALID_IMAGE])
  assert.equal(result, '描述被切断了\n[图片描述被截断]')
})

test('describeImages 忽略 thinking 块，不把推理当描述', async () => {
  const client: StreamClient = {
    async stream(_request, callbacks) {
      callbacks.onThinkingDelta('让我想想这张图……')
      callbacks.onContentBlock({ type: 'thinking', thinking: '让我想想这张图……' })
      callbacks.onContentBlock({ type: 'text', text: '一只猫。' })
      callbacks.onStopReason('stop', {})
    },
  }
  assert.equal(await describeImages(client, [VALID_IMAGE]), '一只猫。')
})

// ── 阶段5：模式自适应 prompt ─────────────────────────────────────
test('selectVisionPrompt 显式配置 prompt 永远优先', () => {
  assert.equal(selectVisionPrompt('自定义提示', '这个报错怎么回事'), '自定义提示')
})

test('selectVisionPrompt 命中报错/UI 关键词 → 精确转写模式', () => {
  const p = selectVisionPrompt(undefined, '这个报错是什么意思')
  assert.match(p, /逐字转写|一字不差|OCR/)
})

test('selectVisionPrompt 无 UI 关键词 → 通用结构化模式', () => {
  const p = selectVisionPrompt(undefined, '这是我家的猫')
  assert.match(p, /## 文字内容/)
  assert.doesNotMatch(p, /一字不差/)
})

test('describeImages 据 accompanyingText 切精确模式', async () => {
  let capturedPrompt = ''
  const client: StreamClient = {
    async stream(request, callbacks) {
      const userMsg = request.messages.find(m => m.role === 'user')
      const textPart = Array.isArray(userMsg?.content)
        ? userMsg.content.find(p => p.type === 'text')
        : undefined
      capturedPrompt = textPart?.text ?? ''
      callbacks.onContentBlock({ type: 'text', text: 'ok' })
      callbacks.onStopReason('stop', {})
    },
  }
  await describeImages(client, [VALID_IMAGE], { accompanyingText: '终端里这个 traceback' })
  assert.match(capturedPrompt, /逐字转写|OCR/)
})


// data URL fail-fast 校验（cc5f5f3d）自身的覆盖——校验在 client.stream 之前抛错。
test('describeImages 拒绝异常短的 payload（可能被截断）', async () => {
  const client = makeMockClient('should not be called')
  await assert.rejects(
    describeImages(client, ['data:image/png;base64,abc']),
    /图片数据异常短（3 字符）/,
  )
})

test('describeImages 拒绝非 data URL', async () => {
  const client = makeMockClient('should not be called')
  await assert.rejects(
    describeImages(client, ['https://example.com/x.png']),
    /不是 data URL/,
  )
})

test('describeImages 拒绝不支持的 MIME 类型', async () => {
  const client = makeMockClient('should not be called')
  await assert.rejects(
    describeImages(client, ['data:image/svg+xml;base64,' + 'A'.repeat(128)]),
    /图片格式不受视觉模型支持/,
  )
})
