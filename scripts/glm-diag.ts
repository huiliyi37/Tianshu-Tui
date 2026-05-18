/**
 * Quick GLM API diagnostic — run with:
 *   ZHIPU_API_KEY=your.key npx tsx scripts/glm-diag.ts
 */
const apiKey = process.env.ZHIPU_API_KEY
if (!apiKey) {
  console.error('Set ZHIPU_API_KEY env var')
  process.exit(1)
}

const body = {
  model: 'glm-5.1',
  messages: [
    { role: 'user', content: '搜索今天的重大科技新闻' },
  ],
  stream: true,
  thinking: { type: 'enabled', clear_thinking: false },
  tools: [{
    type: 'web_search',
    web_search: {
      enable: true,
      search_engine: 'search_pro_quark',
      search_result: true,
      count: 10,
      content_size: 'high',
    },
  }],
}

// GLM Coding Plan uses the dedicated coding endpoint, not the general API
const baseUrl = process.env.GLM_CODING_URL || 'https://open.bigmodel.cn/api/coding/paas/v4'
console.log('[1] Request URL:', `${baseUrl}/chat/completions`)
console.log('[2] Request body:', JSON.stringify(body, null, 2))

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'Connection': 'keep-alive',
  },
  body: JSON.stringify(body),
})

console.log('[3] Response status:', res.status, res.statusText)
console.log('[4] Response headers:', Object.fromEntries(res.headers.entries()))

if (!res.ok) {
  const errBody = await res.text()
  console.error('[ERROR BODY]', errBody)
  process.exit(1)
}

const reader = res.body?.getReader()
if (!reader) {
  console.error('[ERROR] No response body reader')
  process.exit(1)
}

const decoder = new TextDecoder()
let buffer = ''
let chunkCount = 0

console.log('[5] Reading SSE stream...')

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    chunkCount++
    if (chunkCount <= 10) {
      console.log(`[6] Raw line #${chunkCount}:`, trimmed.slice(0, 200))
    }

    // Try both data: and data: formats
    let payload = ''
    if (trimmed.startsWith('data:')) {
      payload = trimmed.slice(5).trimStart()
    } else {
      console.log(`[!] Unexpected line format #${chunkCount}:`, trimmed.slice(0, 100))
      continue
    }

    if (payload === '[DONE]') {
      console.log('[7] Stream complete: [DONE] received')
      break
    }

    try {
      const parsed = JSON.parse(payload)
      if (chunkCount <= 10) {
        const choice = parsed.choices?.[0]
        if (choice) {
          const delta = choice.delta ?? choice.message
          const keys = Object.keys(delta ?? {}).filter(k => delta[k])
          console.log(`[8] Chunk #${chunkCount} keys:`, keys)
          if (delta?.content) console.log(`    content: "${delta.content.slice(0, 100)}"`)
          if (delta?.reasoning_content) console.log(`    reasoning: "${delta.reasoning_content.slice(0, 100)}"`)
          if (choice.finish_reason) console.log(`    finish_reason: ${choice.finish_reason}`)
        }
      }
    } catch {
      console.log(`[!] JSON parse failed for chunk #${chunkCount}:`, payload.slice(0, 100))
    }
  }
}

// Residual buffer
if (buffer.trim()) {
  const trimmed = buffer.trim()
  console.log('[9] Residual buffer:', trimmed.slice(0, 200))
}

console.log(`[10] Total chunks received: ${chunkCount}`)
