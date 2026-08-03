#!/usr/bin/env npx tsx
/**
 * 任务分类闸门验证脚本 — 可复用
 *
 * 模拟轻查询场景，测量 system prompt 自重和 token 消耗，
 * 验证 task-classification 修复效果。
 *
 * 用法:
 *   npx tsx scripts/verify-task-classification.ts
 *
 * 需要 DEEPSEEK_API_KEY（从 ~/.rivet/config.json 自动读取，
 * 或手动设置环境变量）
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { PromptEngine } from '../src/prompt/engine.js'
import { createVolatileSnapshot } from '../src/prompt/volatile-snapshot.js'
import { createDefaultToolRegistry } from '../src/tools/default-registry.js'
import { stableStringify } from '../src/api/stable-json.js'

// ── API Key ───────────────────────────────────────────────

const API_KEY = process.env.DEEPSEEK_API_KEY ?? (() => {
  try {
    const cfg = JSON.parse(readFileSync(`${homedir()}/.rivet/config.json`, 'utf8'))
    return cfg.provider?.providers?.deepseek?.apiKey ?? ''
  } catch { return '' }
})()

if (!API_KEY) {
  console.error('❌ 需要 DEEPSEEK_API_KEY（自动读取 ~/.rivet/config.json 失败，请手动设置）')
  process.exit(1)
}

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'

// ── 全量工具注册 ─────────────────────────────────────────

const registry = createDefaultToolRegistry()
const tools = registry.getDefinitions()
console.log(`🔧 工具数: ${tools.length}`)

// ── PromptEngine ──────────────────────────────────────────

const engine = new PromptEngine({
  model: 'deepseek-chat',
  maxTokens: 256,        // 轻查询不需要长回复
  staticCtx: { tools },
  volatileCtx: createVolatileSnapshot({ cwd: process.cwd() }),
})

// ── 模拟轻查询 ────────────────────────────────────────────

const LIGHT_QUERIES = [
  '看看最近有什么提交',
  '当前项目进度怎么样了',
  '显示最近的 git log',
]

async function run() {
  for (let i = 0; i < LIGHT_QUERIES.length; i++) {
    const q = LIGHT_QUERIES[i]!
    console.log(`\n── Turn ${i + 1}: "${q}" ──`)

    const request = engine.buildOaiRequest(
      [{ role: 'user', content: q }],
      undefined,
      1_000_000,
    )

    const body = stableStringify({
      model: 'deepseek-chat',
      messages: request.messages,
      max_tokens: 256,
      stream: false,
    })

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body,
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`  ❌ API ${res.status}: ${err.slice(0, 200)}`)
      continue
    }

    const data = await res.json() as {
      usage: {
        prompt_tokens: number
        completion_tokens: number
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
      choices: Array<{ message: { content: string } }>
    }

    const u = data.usage
    const hit = u.prompt_cache_hit_tokens ?? 0
    const miss = u.prompt_cache_miss_tokens ?? 0
    const total = hit + miss
    const rate = total > 0 ? (hit / total * 100).toFixed(1) : '0.0'

    console.log(`  prompt: ${u.prompt_tokens.toLocaleString()} tokens`)
    console.log(`  cache:  hit=${hit.toLocaleString()} miss=${miss.toLocaleString()} (${rate}%)`)
    console.log(`  reply:  ${data.choices[0]?.message?.content?.slice(0, 120) ?? '(空)'}...`)
  }

  console.log(`\n✅ 完成 — ${LIGHT_QUERIES.length} 轮轻查询验证`)
  console.log('   Turn 1 的 prompt_tokens 即为全量工具集下的 system prompt 自重')
}

run().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})
