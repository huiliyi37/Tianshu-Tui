#!/usr/bin/env tsx
/**
 * Task C · 跨 user message（fresh 边界验证）
 *
 * Phase 1: read + edit 链路（sessionState 变化）
 * Phase 2: 第二条 user message（验证 fresh 边界刷新不破坏 prefix）
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx ./node_modules/.bin/tsx scripts/verify-task-c-fresh-boundary.ts
 */

import { ArtifactStore } from '../src/artifact/store.js'
import { SessionStateManager } from '../src/agent/session-state.js'
import { summarizeFileContent } from '../src/artifact/summarize.js'
import { stableStringify } from '../src/api/stable-json.js'
import { readFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const API_KEY = process.env.DEEPSEEK_API_KEY
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
if (!API_KEY) { console.error('❌ DEEPSEEK_API_KEY required'); process.exit(1) }

const CWD = process.cwd()

const SYSTEM_BASE = `You are a coding assistant. Use tools to read and edit files. Be concise. Call one tool at a time.`

const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Edit a file (dry run)', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'read_section', description: 'Read lines from artifact', parameters: { type: 'object', properties: { artifact_id: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['artifact_id', 'start_line', 'end_line'] } } },
]

const artifactDir = mkdtempSync(join(tmpdir(), 'rivet-task-c-'))
const artifactStore = new ArtifactStore(artifactDir, 'task-c-session')
const sessionState = new SessionStateManager('task-c-session')

// ── Tool execution ──────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'read_file') {
    const filePath = input.file_path as string
    const absPath = filePath.startsWith('/') ? filePath : join(CWD, filePath)
    if (!existsSync(absPath)) return `Error: File not found: ${absPath}`
    const stat = statSync(absPath)
    if (stat.isDirectory()) return `Error: ${absPath} is a directory, not a file.`
    if (stat.size > 100_000) return `Error: File too large (${stat.size} bytes).`
    const raw = readFileSync(absPath, 'utf-8')
    const { summary, sections } = summarizeFileContent(raw, filePath)
    const artifactId = await artifactStore.save({ tool: 'read_file', target: filePath, rawContent: raw, summary, sections })
    sessionState.trackFileRead(filePath, artifactId)
    return `[artifact:${artifactId}] ${summary}\nUse read_section("${artifactId}", startLine, endLine) to expand.`
  }
  if (name === 'edit_file') {
    sessionState.trackFileModified(input.file_path as string)
    return `[DRY RUN] Would edit ${input.file_path}`
  }
  if (name === 'read_section') {
    const content = await artifactStore.readLines(input.artifact_id as string, input.start_line as number, input.end_line as number)
    return content ?? `Error: Artifact not found`
  }
  return 'Unknown tool'
}

// ── API ─────────────────────────────────────────────────────────

type OaiMsg = { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string }
const messages: OaiMsg[] = []

interface TurnStats { turn: number; phase: string; inputTokens: number; cacheHit: number; cacheMiss: number; hitRate: string; stateChars: number }
const allStats: TurnStats[] = []

// Track frozen volatile suffix per user-message index (mimics engine.ts cachedFreshForUser)
const frozenUserSuffixes = new Map<number, string>()

async function callApi(turnLabel: number, phase: string): Promise<{ text: string; toolCalls: any[] | null; stats: TurnStats }> {
  const stateBlock = sessionState.renderForVolatile()

  // Mimic Rivet's cachedFreshForUser: freeze the volatile suffix on first send.
  // Tool turns reuse the frozen suffix — only a NEW user message gets fresh state.
  const apiMessages: typeof messages = []
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') { lastUserIdx = i; break }
  }

  if (lastUserIdx >= 0 && !frozenUserSuffixes.has(lastUserIdx)) {
    frozenUserSuffixes.set(lastUserIdx, stateBlock)
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const suffix = frozenUserSuffixes.get(i)
    if (msg.role === 'user' && suffix) {
      apiMessages.push({ ...msg, content: `${msg.content}\n\n<context-update>\n${suffix}\n</context-update>` })
    } else {
      apiMessages.push(msg)
    }
  }

  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: stableStringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: SYSTEM_BASE }, ...apiMessages], tools: TOOLS, tool_choice: 'auto', max_tokens: 1024, stream: false }),
  })

  if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const data = await response.json() as any
  const usage = data.usage
  const hit = usage.prompt_cache_hit_tokens ?? 0
  const miss = usage.prompt_cache_miss_tokens ?? 0
  const hitRate = (hit + miss) > 0 ? (hit / (hit + miss) * 100).toFixed(1) : '0.0'

  return {
    text: data.choices[0].message.content ?? '',
    toolCalls: data.choices[0].message.tool_calls ?? null,
    stats: { turn: turnLabel, phase, inputTokens: usage.prompt_tokens, cacheHit: hit, cacheMiss: miss, hitRate: `${hitRate}%`, stateChars: stateBlock.length },
  }
}

async function runPhase(phase: string, startTurn: number, maxTurns: number): Promise<number> {
  let turn = startTurn
  while (turn - startTurn < maxTurns) {
    turn++
    process.stdout.write(`  Turn ${turn} [${phase}]: `)
    const { text, toolCalls, stats } = await callApi(turn, phase)
    allStats.push(stats)

    if (!toolCalls || toolCalls.length === 0) {
      console.log(`done — hit: ${stats.hitRate} | state: ${stats.stateChars}ch`)
      messages.push({ role: 'assistant', content: text })
      break
    }

    console.log(`${toolCalls.length} tool(s) — hit: ${stats.hitRate} | state: ${stats.stateChars}ch`)
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls })

    for (const tc of toolCalls) {
      const input = JSON.parse(tc.function.arguments)
      const result = await executeTool(tc.function.name, input)
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
      process.stdout.write(`    → ${tc.function.name}: ${result.slice(0, 60)}...\n`)
    }
    await new Promise(r => setTimeout(r, 800))
  }
  return turn
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('🔄 Task C · 跨 user message fresh 边界验证')
  console.log('')

  // Phase 1
  console.log('━━━ Phase 1: read + edit ━━━')
  messages.push({ role: 'user', content: `读一下 ${CWD}/src/agent/session-state.ts，然后假装修改第 50 行的一个 typo（dry run）。每次只调用一个工具。` })
  const lastTurn = await runPhase('phase1', 0, 8)

  // Phase 2 — second user message
  console.log('')
  console.log('━━━ Phase 2: 第二条 user message ━━━')
  messages.push({ role: 'user', content: '再检查一遍刚才改的那个文件是否还有其他问题。告诉我你的 session state 里追踪了哪些文件。' })
  await runPhase('phase2', lastTurn, 6)

  // Results
  console.log('')
  console.log('┌──────┬─────────┬────────────┬───────────┬───────────┬──────────┬───────────┐')
  console.log('│ Turn │ Phase   │ Input Tkns │ Cache Hit │ Cache Miss│ Hit Rate │ State Len │')
  console.log('├──────┼─────────┼────────────┼───────────┼───────────┼──────────┼───────────┤')
  for (const s of allStats) {
    console.log(`│  ${String(s.turn).padStart(2)}  │ ${s.phase.padEnd(7)} │ ${String(s.inputTokens).padStart(10)} │ ${String(s.cacheHit).padStart(9)} │ ${String(s.cacheMiss).padStart(9)} │ ${s.hitRate.padStart(8)} │ ${String(s.stateChars).padStart(9)} │`)
  }
  console.log('└──────┴─────────┴────────────┴───────────┴───────────┴──────────┴───────────┘')

  const p1Stats = allStats.filter(s => s.phase === 'phase1')
  const p2Stats = allStats.filter(s => s.phase === 'phase2')

  if (p1Stats.length >= 2 && p2Stats.length >= 1) {
    const p1Last = p1Stats[p1Stats.length - 1]!
    const p2First = p2Stats[0]!

    console.log('')
    console.log('📊 边界分析：')
    console.log(`   Phase 1 最后一轮: ${p1Last.hitRate} (state: ${p1Last.stateChars}ch)`)
    console.log(`   Phase 2 第一轮:   ${p2First.hitRate} (state: ${p2First.stateChars}ch)`)

    const p2Rate = parseFloat(p2First.hitRate)
    if (p2Rate >= 70) console.log('   ✅ Fresh 边界正常 — 第二条 message 仍有高 cache hit')
    else if (p2Rate >= 50) console.log('   ⚠️ 轻微下降 — fresh 重建导致部分 miss（可接受）')
    else console.log('   ❌ 严重下降 — sessionState 在 user message 边界破坏了 prefix')

    if (p2Stats.length >= 2) {
      const p2Second = p2Stats[1]!
      console.log(`   Phase 2 第二轮:   ${p2Second.hitRate} ${parseFloat(p2Second.hitRate) >= parseFloat(p2First.hitRate) ? '✅ 恢复递增' : ''}`)
    }
  }

  console.log('')
  console.log('📋 最终 SessionState:')
  console.log(sessionState.renderForVolatile())
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
