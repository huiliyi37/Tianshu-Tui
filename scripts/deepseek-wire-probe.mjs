#!/usr/bin/env node
/**
 * DeepSeek 线上 wire 行为探测器 — usage 帧位置 + 缓存单元语义实测
 *
 * 背景（2026-07-07）：官方文档与线上行为存在两处不符，涉及计费记账与缓存策略，
 * 结论必须以实测为准。本脚本是当时实测的可复用版本，供行为漂移怀疑时重跑。
 * 完整判读指南见 docs/deepseek-wire-probe-playbook.md。
 *
 * Usage:
 *   node scripts/deepseek-wire-probe.mjs frames [model]   # 帧序列探测（默认 deepseek-v4-flash）
 *   node scripts/deepseek-wire-probe.mjs cache  [model]   # 缓存单元语义五连测（默认 deepseek-v4-pro）
 *   node scripts/deepseek-wire-probe.mjs all              # 两者都跑
 *
 * Key 解析顺序：env DEEPSEEK_API_KEY → ~/.rivet/config.json 的 provider.providers.deepseek.apiKey
 * （2026-07-07 事故：.zshrc 里的 env key 已失效返回 401，现役 key 在 config.json 里）
 *
 * 成本参考（2026-07 价格）：frames ≈ 0.01 元；cache ≈ 0.15 元（v4-pro 4 万 miss token）
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE_URL = 'https://api.deepseek.com/v1'

/** 收集候选 key（env 优先），逐个用免费的 GET /models 预检，取第一把能用的。
 *  2026-07-07 事故：.zshrc 里的 env key 失效返回 401 但看起来格式正常——
 *  预检避免把整组测试浪费在死 key 上。 */
async function resolveKey() {
  const candidates = []
  if (process.env.DEEPSEEK_API_KEY) candidates.push({ key: process.env.DEEPSEEK_API_KEY, source: 'env' })
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.rivet', 'config.json'), 'utf8'))
    const key = cfg?.provider?.providers?.deepseek?.apiKey
    if (key && key !== candidates[0]?.key) candidates.push({ key, source: '~/.rivet/config.json' })
  } catch { /* config 不存在或无 deepseek 条目 */ }
  for (const cand of candidates) {
    const resp = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${cand.key}` } }).catch(() => null)
    if (resp?.ok) return cand
    console.error(`key from ${cand.source} (****${cand.key.slice(-4)}) failed preflight (${resp?.status ?? 'network error'}), trying next`)
  }
  console.error('No working DeepSeek key: set DEEPSEEK_API_KEY or configure ~/.rivet/config.json')
  process.exit(1)
}

const { key: API_KEY, source: KEY_SOURCE } = await resolveKey()

async function post(body) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  })
}

/**
 * 逐帧解析 SSE 流并打印每帧的 usage 分布。
 * quiet 模式只打印带 finish_reason / usage 的帧与 [DONE]。
 * 返回 { usageFires, lastUsage }。
 */
async function streamProbe(label, body, opts = {}) {
  const t0 = Date.now()
  const resp = await post(body)
  console.log(`\n=== ${label} -> ${resp.status}`)
  if (!resp.ok) { console.log((await resp.text()).slice(0, 300)); return null }
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let i = 0
  let usageFires = 0
  let lastUsage = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      // 保活注释行（`: keep-alive`）单独标出 — 它不应被当作数据进展
      if (line.startsWith(':')) { console.log(`#${i++} COMMENT ${line.slice(0, 30)}`); continue }
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') { console.log(`#${i++} [DONE] (+${Date.now() - t0}ms)`); continue }
      const j = JSON.parse(payload)
      const c = j.choices?.[0]
      const hasUsage = j.usage !== undefined && j.usage !== null
      if (hasUsage) { usageFires++; lastUsage = j.usage }
      const usage = j.usage === undefined ? 'absent' : j.usage === null ? 'null'
        : `PRESENT(p=${j.usage.prompt_tokens},c=${j.usage.completion_tokens},hit=${j.usage.prompt_cache_hit_tokens},miss=${j.usage.prompt_cache_miss_tokens},reason=${j.usage.completion_tokens_details?.reasoning_tokens})`
      const kind = c?.delta?.reasoning_content != null ? 'think' : c?.delta?.tool_calls ? 'tool' : c?.delta?.content != null ? 'text' : '-'
      if (opts.quiet && !c?.finish_reason && !hasUsage) { i++; continue }
      console.log(`#${i++} choicesLen=${j.choices?.length ?? 'undef'} kind=${kind} finish=${c?.finish_reason ?? '-'} usage=${usage}`)
    }
  }
  console.log(`>>> usage-bearing frames: ${usageFires}, total frames: ${i}`)
  return { usageFires, lastUsage }
}

// ── 实验一：帧序列（usage 到底在哪一帧、出现几次） ──────────────────────────
// 判读基线（2026-07-07 实测，flash 与 pro 一致）：
//   usage 与 finish_reason 在同一帧（合并帧），[DONE] 前无独立 usage-only 块，
//   每流恰好 1 帧带 usage —— 与官方文档 stream_options.include_usage 描述不符
//   （文档称尾部会有 choices=[] 的独立 usage 块）。openai-client.ts processDelta
//   的合并帧路径（chunk.usage && pendingStopReason）是 DeepSeek 的实际命中路径。
// 若重跑发现 usageFires > 1：双记风险成真，立即给 parseStreamFromReader 加
//   per-attempt usageEmitted 旗标（见 playbook 文档）。
async function runFrames(model) {
  console.log(`\n########## 帧序列探测 model=${model} key=${KEY_SOURCE}`)
  const base = { model, stream: true }

  await streamProbe('非思考 + include_usage', {
    ...base,
    messages: [{ role: 'user', content: 'Say OK' }],
    thinking: { type: 'disabled' }, max_tokens: 8,
    stream_options: { include_usage: true },
  })

  await streamProbe('非思考 无 stream_options', {
    ...base,
    messages: [{ role: 'user', content: 'Say OK' }],
    thinking: { type: 'disabled' }, max_tokens: 8,
  })

  await streamProbe('思考 + include_usage', {
    ...base,
    messages: [{ role: 'user', content: 'Say OK' }],
    thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 512,
    stream_options: { include_usage: true },
  }, { quiet: true })

  await streamProbe('思考 工具调用轮（finish=tool_calls）', {
    ...base,
    messages: [{ role: 'user', content: 'What is the weather in Hangzhou today? You must call the tool.' }],
    thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 1024,
    stream_options: { include_usage: true },
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather of a location',
        parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
      },
    }],
  }, { quiet: true })
}

// ── 实验二：缓存单元语义（落盘粒度、跨请求命中规则） ─────────────────────────
// 判读基线（2026-07-07 实测，v4-pro，约 7.8K token 前缀）：
//   B/C/D/E 全部命中 hit=7808=64×122 —— 64-token 块量化边界，
//   「按固定 token 间隔落盘」在长前缀下主导，实际效果≈旧的块前缀语义；
//   文档例二（同 system 不同 user 第二次不命中）未复现，D 立即 99.7% 命中；
//   尾部不满一块的 token 恒 miss；<64 token 的短 prompt 完全不缓存。
// 若重跑发现 D/E 掉到 0%：文档的「完整单元匹配」语义生效了，
//   compact 锚点复用与 spec 共享前缀的成本模型需要重估。
async function runCache(model) {
  console.log(`\n########## 缓存单元语义五连测 model=${model} key=${KEY_SOURCE}`)

  async function call(label, messages, maxTokens = 64) {
    const resp = await post({
      model,
      thinking: { type: 'disabled' },
      messages, max_tokens: maxTokens, stream: true,
      stream_options: { include_usage: true },
    })
    if (!resp.ok) { console.log(`${label} -> ${resp.status}: ${(await resp.text()).slice(0, 150)}`); return null }
    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let usage = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue
        const j = JSON.parse(line.slice(6))
        if (j.usage) usage = j.usage
      }
    }
    console.log(`${label}: p=${usage.prompt_tokens} hit=${usage.prompt_cache_hit_tokens} miss=${usage.prompt_cache_miss_tokens} hitRate=${(usage.prompt_cache_hit_tokens / usage.prompt_tokens * 100).toFixed(1)}%`)
    return usage
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms))

  // 约 3000 汉字 ≈ 7.8K token 的稳定长前缀。内容完全确定性（无时间戳/随机数），
  // 但每次重跑本测试会命中上次跑时落盘的缓存 —— 改 lore 里的任意字符可强制冷启动。
  const lore = Array.from({ length: 150 }, (_, i) =>
    `条目${i}：星域第${i}区的观测记录显示，信标编号 BX-${i * 7} 在标准历元的相位偏移为 ${i % 60} 弧秒，其伴星光度等级为 ${(i % 9) + 1}，轨道周期约 ${100 + i * 3} 个标准日。`
  ).join('\n')
  const sys = { role: 'system', content: '你是一个星图数据库助手。以下是星域观测数据：\n' + lore }

  console.log('--- A 冷启动（预期全 miss；若命中说明上次跑的缓存还活着）')
  await call('A 冷启动', [sys, { role: 'user', content: '条目3的信标编号是什么？只答编号。' }])

  console.log('--- 等 8s 让缓存落盘（文档称秒级） ---')
  await sleep(8000)

  console.log('--- B 完全相同请求重放（预期命中到最后一个 64-token 块边界）')
  await call('B 同请求重放', [sys, { role: 'user', content: '条目3的信标编号是什么？只答编号。' }])

  console.log('--- C 同前缀多轮追加（Rivet append-only 主形态）')
  await call('C 多轮追加', [
    sys,
    { role: 'user', content: '条目3的信标编号是什么？只答编号。' },
    { role: 'assistant', content: 'BX-21' },
    { role: 'user', content: '条目5的呢？只答编号。' },
  ])

  console.log('--- D 同 system 不同 user（文档例二称第二次不命中——实测立即命中）')
  await call('D 同system不同user', [sys, { role: 'user', content: '条目9的轨道周期是多少？只答数字。' }])

  console.log('--- 等 8s ---')
  await sleep(8000)

  console.log('--- E 第三个不同 user（公共前缀检测路径的对照）')
  await call('E 第三个不同user', [sys, { role: 'user', content: '条目11的光度等级是多少？只答数字。' }])

  console.log('\n判读：hit 若恒为 64 的倍数且 D/E ≈ B → 块量化间隔落盘语义（2026-07-07 基线）；')
  console.log('     D/E 若为 0% → 完整单元匹配语义生效，缓存策略层假设需重估。')
}

const cmd = process.argv[2] ?? 'all'
const model = process.argv[3]
if (cmd === 'frames' || cmd === 'all') await runFrames(model ?? 'deepseek-v4-flash')
if (cmd === 'cache' || cmd === 'all') await runCache(model ?? 'deepseek-v4-pro')
if (!['frames', 'cache', 'all'].includes(cmd)) {
  console.error('Usage: node scripts/deepseek-wire-probe.mjs <frames|cache|all> [model]')
  process.exit(1)
}
