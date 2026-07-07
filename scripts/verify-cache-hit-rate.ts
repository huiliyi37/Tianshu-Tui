#!/usr/bin/env tsx
/**
 * 冰鉴缓存命中率验证脚本
 *
 * 模拟 5 轮对话，记录每轮的 cache hit/miss tokens。
 * 用法：
 *   ./node_modules/.bin/tsx scripts/verify-cache-hit-rate.ts
 *
 * 需要环境变量：
 *   DEEPSEEK_API_KEY — DeepSeek API key
 *   DEEPSEEK_BASE_URL — (可选) 默认 https://api.deepseek.com
 */

import { PromptEngine } from '../src/prompt/engine.js'
import { createVolatileSnapshot } from '../src/prompt/volatile-snapshot.js'
import { canonicalizeRequest } from '../src/api/request-freezer.js'
import { getProviderProfile } from '../src/api/provider-profile.js'
import { stableStringify } from '../src/api/stable-json.js'
import type { Message, Usage } from '../src/api/types.js'

const API_KEY = process.env.DEEPSEEK_API_KEY
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

if (!API_KEY) {
  console.error('❌ 需要设置 DEEPSEEK_API_KEY 环境变量')
  process.exit(1)
}

// ── 工具定义（最小集） ──────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'bash',
    description: 'Run a shell command',
    input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
  },
]

// ── PromptEngine 初始化 ─────────────────────────────────────────

const cwd = process.cwd()
const snapshot = createVolatileSnapshot({ cwd })

const engine = new PromptEngine({
  model: 'deepseek-chat',
  maxTokens: 1024,
  staticCtx: { tools: TOOLS },
  volatileCtx: snapshot,
})

// ── 模拟对话 ────────────────────────────────────────────────────

interface TurnResult {
  turn: number
  prompt: string
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  hitRate: string
  outputTokens: number
  prefixStable: boolean
}

const results: TurnResult[] = []
const conversationMessages: Message[] = []

const PROMPTS = [
  '你好，介绍一下你自己',
  '读一下 package.json 的内容',
  '这个项目用了什么技术栈',
  '解释一下 src/prompt/engine.ts 的作用',
  '总结一下我们刚才的对话',
]

const profile = getProviderProfile('deepseek', 128_000)

async function sendTurn(turn: number, userText: string): Promise<TurnResult> {
  // 添加 user 消息
  conversationMessages.push({ role: 'user', content: userText })

  // 构建请求
  const request = engine.buildRequest(conversationMessages)

  // 检查前缀稳定性：第一个 volatile block 是否和上一轮一样
  let prefixStable = true
  if (turn > 1) {
    const prevReq = engine.buildRequest(conversationMessages.slice(0, -1))
    const vol0Current = (request.messages[0] as { content: string }).content
    const vol0Prev = (prevReq.messages[0] as { content: string }).content
    prefixStable = vol0Current === vol0Prev
  }

  // Canonicalize（strip cache_control, stable JSON）
  const canonical = canonicalizeRequest(
    { ...request, stream: true },
    profile,
    ['cache_control'],
  )

  // 发送 API 请求（非流式，简化解析）
  const body = stableStringify(canonical)

  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: stableStringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: canonical.system },
        ...canonical.messages,
      ],
      max_tokens: 256,
      stream: false,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`API ${response.status}: ${err.slice(0, 200)}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { role: string; content: string } }>
    usage: {
      prompt_tokens: number
      completion_tokens: number
      prompt_cache_hit_tokens?: number
      prompt_cache_miss_tokens?: number
    }
  }

  const usage = data.usage
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0
  const cacheMiss = usage.prompt_cache_miss_tokens ?? 0
  const total = cacheHit + cacheMiss
  const hitRate = total > 0 ? (cacheHit / total * 100).toFixed(1) : '0.0'

  // 添加 assistant 回复到对话
  const assistantText = data.choices[0]?.message?.content ?? ''
  conversationMessages.push({ role: 'assistant', content: assistantText })

  return {
    turn,
    prompt: userText.slice(0, 30),
    inputTokens: usage.prompt_tokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    hitRate: `${hitRate}%`,
    outputTokens: usage.completion_tokens,
    prefixStable,
  }
}

// ── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('🧊 冰鉴缓存验证 — 5 轮对话测试')
  console.log(`   Provider: DeepSeek (${BASE_URL})`)
  console.log(`   Model: deepseek-chat`)
  console.log(`   Volatile snapshot gitStatus: ${snapshot.gitStatus ? '✅ captured' : '⚠️ empty'}`)
  console.log('')

  for (let i = 0; i < PROMPTS.length; i++) {
    process.stdout.write(`Turn ${i + 1}: "${PROMPTS[i]!.slice(0, 25)}..." `)

    try {
      const result = await sendTurn(i + 1, PROMPTS[i]!)
      results.push(result)
      console.log(
        `→ hit: ${result.cacheHitTokens.toLocaleString()} / miss: ${result.cacheMissTokens.toLocaleString()} ` +
        `= ${result.hitRate} ${result.prefixStable ? '🔒' : '⚠️ prefix changed'}`
      )
    } catch (err) {
      console.log(`→ ❌ ${(err as Error).message}`)
      break
    }

    // 等 1 秒让 DeepSeek 缓存写入
    await new Promise(r => setTimeout(r, 1000))
  }

  // ── 结果表格 ──────────────────────────────────────────────────

  console.log('')
  console.log('┌──────┬────────────────────────────────┬────────────┬───────────┬───────────┬──────────┬────────┐')
  console.log('│ Turn │ Prompt                         │ Input Tkns │ Cache Hit │ Cache Miss│ Hit Rate │ Prefix │')
  console.log('├──────┼────────────────────────────────┼────────────┼───────────┼───────────┼──────────┼────────┤')

  for (const r of results) {
    const prompt = r.prompt.padEnd(30).slice(0, 30)
    const input = r.inputTokens.toLocaleString().padStart(10)
    const hit = r.cacheHitTokens.toLocaleString().padStart(9)
    const miss = r.cacheMissTokens.toLocaleString().padStart(9)
    const rate = r.hitRate.padStart(8)
    const prefix = r.prefixStable ? '  🔒  ' : '  ⚠️  '
    console.log(`│  ${r.turn}   │ ${prompt} │ ${input} │ ${hit} │ ${miss} │ ${rate} │${prefix}│`)
  }

  console.log('└──────┴────────────────────────────────┴────────────┴───────────┴───────────┴──────────┴────────┘')

  // ── 总结 ──────────────────────────────────────────────────────

  if (results.length >= 2) {
    const turn2Plus = results.slice(1)
    const totalHit = turn2Plus.reduce((s, r) => s + r.cacheHitTokens, 0)
    const totalMiss = turn2Plus.reduce((s, r) => s + r.cacheMissTokens, 0)
    const totalRate = totalHit + totalMiss > 0
      ? (totalHit / (totalHit + totalMiss) * 100).toFixed(1)
      : '0.0'
    const allPrefixStable = turn2Plus.every(r => r.prefixStable)

    console.log('')
    console.log(`📊 Turn 2+ 平均缓存命中率: ${totalRate}%`)
    console.log(`🔒 前缀稳定性: ${allPrefixStable ? '全部稳定 ✅' : '存在不稳定 ⚠️'}`)
    console.log(`🎯 目标: ≥ 60% (合格) / ≥ 80% (良好) / ≥ 90% (优秀)`)

    const rate = parseFloat(totalRate)
    if (rate >= 90) console.log('✅ 优秀 — 冰鉴缓存引擎运行正常')
    else if (rate >= 80) console.log('✅ 良好 — 缓存工作正常，长会话会更高')
    else if (rate >= 60) console.log('⚠️ 合格 — 缓存基本工作，可能有优化空间')
    else if (rate >= 20) console.log('⚠️ 偏低 — 缓存有效但命中率不及预期')
    else console.log('❌ 缓存可能未生效 — 检查前缀稳定性')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
