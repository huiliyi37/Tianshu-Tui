#!/usr/bin/env tsx
/**
 * 摘要侧路缓存命中率验证脚本 v2（生产路径版，2026-08-09）
 *
 * v1（裸 fetch 单消息）的问题：与生产侧路形态完全不同，测不出真实数值。
 * 本版对齐生产两条路径：
 *   1. 主请求走 PromptEngine.buildOaiRequest（frozen base + appendix + 边界合并，
 *      与 verify-cache-hit-rate.ts 同一生产构造路径）
 *   2. 侧路摘要请求复用主请求完整消息前缀再追加摘要指令——与 llm-speculation.ts
 *      的侧路形态同构（该引擎注释明说复用前缀 ≈ near-100% prefix cache hit）
 *
 * 用法：
 *   ./node_modules/.bin/tsx scripts/verify-summary-cache-hit-rate.ts [run-text-file]
 *   PROBE_ROUNDS=N    对话轮数（默认 3，每轮发一次侧路摘要请求）
 *   PROBE_MODEL=...   模型（默认 deepseek-v4-flash，生产 cheap 档）
 *
 * key 解析顺序：DEEPSEEK_API_KEY 环境变量 → ~/.rivet/config.json provider.providers.deepseek.apiKey
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PromptEngine } from '../src/prompt/engine.js'
import { createVolatileSnapshot } from '../src/prompt/volatile-snapshot.js'
import { stableStringify } from '../src/api/stable-json.js'
import type { OaiMessage } from '../src/api/oai-types.js'

function resolveKey(): string {
  const env = process.env.DEEPSEEK_API_KEY
  if (env) return env
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.rivet/config.json'), 'utf8'))
    const key = cfg?.provider?.providers?.deepseek?.apiKey
    if (typeof key === 'string' && key.length > 0) return key
  } catch { /* fallthrough */ }
  return ''
}

// ── 工具定义（最小集，与生产同构——工具定义属于 system 前缀的一部分） ──
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

interface TurnResult {
  kind: 'main' | 'summary'
  turn: number
  inputTokens: number
  cacheHit: number
  cacheMiss: number
  hitRate: string
  content: string
}

async function main() {
  const key = resolveKey()
  if (!key) {
    console.error('❌ 未找到 DeepSeek API key（环境变量 DEEPSEEK_API_KEY 或 ~/.rivet/config.json）')
    process.exit(1)
  }
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
  const model = process.env.PROBE_MODEL ?? 'deepseek-v4-flash'
  const maxTokens = Number(process.env.PROBE_MAX_TOKENS ?? 512)
  const rounds = Number(process.env.PROBE_ROUNDS ?? 3)

  let runText = 'The user asks me to design a system for capturing high-quality lessons from errors: agents act freely, review gates catch errors, and post-fix reflection distills structural insights (not behavioral cautions) into knowledge stores for future context injection. The trigger should be post-fix, not pre-fix; the selection gate high-bar; the injection contextual, not prompt-level.'
  const fileArg = process.argv[2]
  if (fileArg) {
    if (!existsSync(fileArg)) { console.error(`❌ 文件不存在: ${fileArg}`); process.exit(1) }
    runText = readFileSync(fileArg, 'utf8').trim()
  }

  // 生产构造路径：PromptEngine + volatile snapshot（与 verify-cache-hit-rate.ts 相同）
  const snapshot = createVolatileSnapshot({ cwd: process.cwd() })
  const engine = new PromptEngine({
    model,
    maxTokens: 1024,
    staticCtx: { tools: TOOLS },
    volatileCtx: snapshot,
  })
  const CONTEXT_WINDOW = 128_000

  const SUMMARY_PROMPT = (text: string): string =>
    `以下是模型一段思考（chain-of-thought）的全文。请用一句话（≤60 tokens）给出这段思考的核心结论，跟随思考内容的语言。只输出摘要本身，不要任何前缀。\n\n思考全文：\n${text.slice(0, 6000)}`

  const conversation: OaiMessage[] = []
  const PROMPTS = ['你好，介绍一下你自己', '读一下 package.json 的内容', '这个项目用了什么技术栈']
  const results: TurnResult[] = []

  console.log(`🧊 摘要侧路缓存验证（生产路径版）— ${rounds} 轮对话 + 每轮侧路摘要`)
  console.log(`   Model: ${model} | max_tokens: ${maxTokens} | 摘要输入 ${runText.length} chars`)
  console.log('')

  async function call(messages: OaiMessage[], kind: 'main' | 'summary', turn: number): Promise<TurnResult> {
    const request = engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: stableStringify({
        model,
        messages: request.messages,
        max_tokens: kind === 'summary' ? maxTokens : 128,
        stream: false,
      }),
    })
    if (!res.ok) { const b = await res.text(); throw new Error(`API ${res.status}: ${b.slice(0, 200)}`) }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
    }
    const usage = data.usage
    if (!usage) throw new Error('响应无 usage')
    const hit = usage.prompt_cache_hit_tokens ?? 0
    const miss = usage.prompt_cache_miss_tokens ?? 0
    const total = hit + miss
    const hitRate = total > 0 ? (hit / total * 100).toFixed(1) : '0.0'
    const content = data.choices?.[0]?.message?.content?.trim() ?? ''
    return { kind, turn, inputTokens: usage.prompt_tokens, cacheHit: hit, cacheMiss: miss, hitRate, content }
  }

  for (let turn = 1; turn <= rounds; turn++) {
    // 主请求：递增对话（生产形态）
    conversation.push({ role: 'user', content: PROMPTS[(turn - 1) % PROMPTS.length]! })
    process.stdout.write(`Turn ${turn} 主请求... `)
    const main = await call(conversation, 'main', turn)
    results.push(main)
    console.log(`→ hit ${main.cacheHit.toLocaleString()} / miss ${main.cacheMiss.toLocaleString()} = ${main.hitRate}`)
    conversation.push({ role: 'assistant', content: main.content.slice(0, 200) || '（空）' })

    // 侧路摘要请求：复用主请求完整消息前缀 + 追加摘要指令（llm-speculation 同构）
    process.stdout.write(`Turn ${turn} 侧路摘要... `)
    const summary = await call([...conversation, { role: 'user', content: SUMMARY_PROMPT(runText) }], 'summary', turn)
    results.push(summary)
    console.log(`→ hit ${summary.cacheHit.toLocaleString()} / miss ${summary.cacheMiss.toLocaleString()} = ${summary.hitRate}${summary.content ? '' : ' ⚠️ 正文为空'}`)

    await new Promise(r => setTimeout(r, 800))
  }

  console.log('')
  console.log('┌──────┬──────────┬────────────┬───────────┬───────────┬──────────┐')
  console.log('│ Turn │ 请求类型  │ Input Tkns │ Cache Hit │ Cache Miss│ Hit Rate │')
  console.log('├──────┼──────────┼────────────┼───────────┼───────────┼──────────┤')
  for (const r of results) {
    console.log(`│  ${r.turn}   │ ${r.kind === 'main' ? '主请求' : '侧路摘要'} │ ${String(r.inputTokens).padStart(10)} │ ${String(r.cacheHit).padStart(9)} │ ${String(r.cacheMiss).padStart(9)} │ ${r.hitRate.padStart(8)} │`)
  }
  console.log('└──────┴──────────┴────────────┴───────────┴───────────┴──────────┘')

  const summaries = results.filter(r => r.kind === 'summary' && r.turn > 1)
  if (summaries.length > 0) {
    const hit = summaries.reduce((s, r) => s + r.cacheHit, 0)
    const miss = summaries.reduce((s, r) => s + r.cacheMiss, 0)
    const rate = hit + miss > 0 ? (hit / (hit + miss) * 100).toFixed(1) : '0.0'
    console.log(`\n📊 侧路摘要（Turn 2+）平均命中率: ${rate}%`)
    console.log('   关键：侧路请求复用主前缀 → 摘要落地生产后缓存表现与主会话同源')
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
