/**
 * Vision bridge — describes images through a dedicated multimodal model.
 *
 * When the primary model does not support vision, user-supplied image data URLs
 * are routed here to produce a text description, which is then prepended to the
 * primary prompt so the main model still receives the image content.
 */

import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest, OaiContentPart } from '../api/oai-types.js'

const DEFAULT_VISION_PROMPT = '请用中文详细描述这张图片的内容、文字、界面元素和可能的用途。'

export interface DescribeImagesOptions {
  /** Prompt template for the vision model. */
  prompt?: string
  /** Max output tokens for the description. */
  maxTokens?: number
  /** Abort signal. */
  signal?: AbortSignal
}

/**
 * Send one or more images to a multimodal model and return a text description.
 *
 * The client is assumed to be already configured with the correct provider and
 * model (e.g. built by create-agent-config's vision bridge). This function wraps
 * the streaming interface into a one-shot completion.
 */
export async function describeImages(
  client: StreamClient,
  images: string[],
  options: DescribeImagesOptions = {},
): Promise<string> {
  if (images.length === 0) return ''

  const prompt = options.prompt ?? DEFAULT_VISION_PROMPT
  const parts: OaiContentPart[] = [{ type: 'text', text: prompt }]
  for (const url of images) {
    parts.push({ type: 'image_url', image_url: { url } })
  }

  const request: OaiChatRequest = {
    model: '', // client already binds the model
    messages: [{ role: 'user', content: parts }],
    max_tokens: options.maxTokens ?? 1024,
    stream: true,
  }

  const chunks: string[] = []
  let error: Error | undefined
  let stopReason = ''

  await client.stream(
    request,
    {
      onTextDelta: (text) => { chunks.push(text) },
      onThinkingDelta: () => { /* vision models rarely stream reasoning; ignore */ },
      onContentBlock: (block) => {
        if (block.type === 'text' && block.text) chunks.push(block.text)
      },
      onStopReason: (reason) => { stopReason = reason },
      onError: (err) => { error = err },
    },
    options.signal,
  )

  if (error) throw error
  if (stopReason === 'length') {
    chunks.push('\n[图片描述被截断]')
  }

  return chunks.join('').trim()
}
