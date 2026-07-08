/**
 * 诊断脚本：检查会话 JSONL 中 tool_call ↔ tool_result 的配对完整性。
 *
 * 用法：
 *   npx tsx scripts/diagnose-tool-orphans.ts ~/.rivet/sessions/<slug>/<id>.jsonl
 *
 * 输出：
 *   - 每一对 tool_call → tool_result 的匹配状态
 *   - 邻接违规（tool 结果不在 assistant 紧后）
 *   - 汇总统计
 */

import { readFileSync, existsSync } from 'fs'
import { strict as assert } from 'node:assert'

// ─── types (mirrors oai-types.ts) ───

interface OaiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OaiAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OaiToolCall[]
  reasoning_content?: string
}

interface OaiToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

interface OaiUserMessage {
  role: 'user'
  content: string
}

interface OaiSystemMessage {
  role: 'system'
  content: string
}

type OaiMessage = OaiAssistantMessage | OaiToolMessage | OaiUserMessage | OaiSystemMessage

// ─── JSONL 解析 ───

function parseJsonl(filePath: string): OaiMessage[] {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`)
  }
  const raw = readFileSync(filePath, 'utf-8')
  const messages: OaiMessage[] = []
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue
    try {
      // 去掉 checksum 后缀: `|hex` (session-persist.ts appendChecksum 格式)
      const pipeIdx = line.lastIndexOf('|')
      const jsonPart = pipeIdx > 0 && /^[0-9a-f]{8,}$/.test(line.slice(pipeIdx + 1))
        ? line.slice(0, pipeIdx)
        : line
      const obj = JSON.parse(jsonPart)
      // 跳过 audit 行（compact_start, compact_end, model_switch 等）
      if (!obj.role) continue
      messages.push(obj as OaiMessage)
    } catch {
      // 跳过格式错误行
      continue
    }
  }
  return messages
}

// ─── 诊断逻辑 ───

interface ToolCallEntry {
  index: number
  id: string
  name: string
  resultIdx: number | null   // tool 消息的索引
  adjacent: boolean           // tool 结果是否紧邻
  resultContent: string | null
  synthetic: boolean           // 是否为合成结果（含 "会话中断" 或 "[recovered]"）
}

interface OrphanResultEntry {
  index: number
  tool_call_id: string
  content: string
}

interface DiagnosticReport {
  filePath: string
  totalMessages: number
  totalToolCalls: number
  totalToolResults: number
  callsWithResult: number     // 有匹配结果的
  callsWithoutResult: number  // 孤儿 tool_call
  callsNotAdjacent: number    // 结果存在但不在紧邻位置
  syntheticResults: number    // 合成结果数
  orphanResults: OrphanResultEntry[]  // 无匹配 tool_call 的 tool 消息
  entries: ToolCallEntry[]
  adjacencyViolations: { toolCallIdx: number; toolCallId: string; toolResultIdx: number; distance: number }[]
}

function diagnose(messages: OaiMessage[]): DiagnosticReport {
  // 搜集所有 tool_call ID 及其索引
  const toolCallIds = new Set<string>()
  let totalToolCalls = 0
  const entries: ToolCallEntry[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolCallIds.add(tc.id)
        totalToolCalls++
        entries.push({
          index: i,
          id: tc.id,
          name: tc.function?.name ?? '?',
          resultIdx: null,
          adjacent: false,
          resultContent: null,
          synthetic: false,
        })
      }
    }
  }

  // 搜集所有 tool 消息及其索引
  const toolResultMap = new Map<string, { index: number; content: string }[]>()
  let totalToolResults = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'tool' && 'tool_call_id' in m) {
      totalToolResults++
      const arr = toolResultMap.get(m.tool_call_id) ?? []
      arr.push({ index: i, content: m.content })
      toolResultMap.set(m.tool_call_id, arr)
    }
  }

  // 匹配 tool_call → tool_result
  let callsWithResult = 0
  let callsWithoutResult = 0
  let syntheticResults = 0
  const adjacencyViolations: DiagnosticReport['adjacencyViolations'] = []

  // 按 tool_call 的 assistant 索引分组，计算每个 tool_call 期望的邻接位置
  // 邻接：tool 结果在 assistant 之后，且中间没有非-tool 消息
  let expectedResultIdx = new Map<number, number>() // toolCallMsgIdx → next expected result idx offset
  const consumed = new Set<number>() // 已消费的 tool 消息索引

  for (const entry of entries) {
    // 找到匹配的 tool 消息
    const results = toolResultMap.get(entry.id) ?? []

    // 找第一个未消费的匹配结果
    const match = results.find(r => !consumed.has(r.index))
    if (match) {
      consumed.add(match.index)

      // 检查是否合成结果
      const isSynthetic = match.content.includes('会话中断') || match.content.includes('[recovered]')

      // 检查邻接：结果必须紧接在其 assistant 消息之后
      // 即：在 entry.index 和 match.index 之间，只能有 tool 消息（属于同一批）
      let adjacent = true
      for (let j = entry.index + 1; j < match.index; j++) {
        const mid = messages[j]!
        if (mid.role !== 'tool') {
          adjacent = false
          break
        }
      }

      entry.resultIdx = match.index
      entry.adjacent = adjacent
      entry.resultContent = match.content.slice(0, 120)
      entry.synthetic = isSynthetic

      callsWithResult++
      if (isSynthetic) syntheticResults++

      if (!adjacent) {
        adjacencyViolations.push({
          toolCallIdx: entry.index,
          toolCallId: entry.id,
          toolResultIdx: match.index,
          distance: match.index - entry.index - 1,
        })
      }
    } else {
      callsWithoutResult++
    }
  }

  // 孤儿 tool 结果（无匹配 tool_call）
  const orphanResults: OrphanResultEntry[] = []
  for (const [id, results] of toolResultMap) {
    if (!toolCallIds.has(id)) {
      for (const r of results) {
        if (!consumed.has(r.index)) {
          orphanResults.push({ index: r.index, tool_call_id: id, content: r.content.slice(0, 120) })
        }
      }
    }
  }

  return {
    filePath: '',
    totalMessages: messages.length,
    totalToolCalls,
    totalToolResults,
    callsWithResult,
    callsWithoutResult,
    callsNotAdjacent: adjacencyViolations.length,
    syntheticResults,
    orphanResults,
    entries,
    adjacencyViolations,
  }
}

// ─── 输出 ───

function printReport(report: DiagnosticReport): void {
  const { entries, adjacencyViolations, orphanResults } = report

  console.log(`\n═══════════════════════════════════════════`)
  console.log(`  会话 JSONL 诊断报告`)
  console.log(`═══════════════════════════════════════════`)
  console.log(`  文件: ${report.filePath}`)
  console.log(`  总消息数: ${report.totalMessages}`)
  console.log(`  tool_calls 总数: ${report.totalToolCalls}`)
  console.log(`  tool 结果总数: ${report.totalToolResults}`)
  console.log(`  已匹配: ${report.callsWithResult}  |  孤儿 tool_call: ${report.callsWithoutResult}`)
  console.log(`  合成结果: ${report.syntheticResults}`)
  console.log(`  邻接违规: ${report.callsNotAdjacent}`)
  console.log(`  孤儿 tool 结果 (无匹配 tool_call): ${orphanResults.length}`)

  if (entries.length === 0) {
    console.log(`\n  ✓ 没有 tool_call，无需检查。`)
    return
  }

  // 按行号排序输出
  console.log(`\n  ── tool_call 明细 ──`)
  for (const e of entries) {
    const status = e.resultIdx === null
      ? '❌ 孤儿'
      : e.synthetic
        ? '⚠️  合成'
        : e.adjacent
          ? '✓'
          : '↗  乱序'
    const toolName = e.name.padEnd(16)
    const preview = e.resultContent
      ? ` → "${e.resultContent.slice(0, 80)}${e.resultContent.length > 80 ? '…' : ''}"`
      : ' → (无结果)'
    console.log(`  L${String(e.index).padStart(4)}  ${status}  ${toolName}  id=${e.id.slice(0, 12)}${preview}`)
  }

  if (adjacencyViolations.length > 0) {
    console.log(`\n  ── 邻接违规 (结果存在但不在紧邻位置) ──`)
    for (const v of adjacencyViolations) {
      console.log(`  tool_call@L${v.toolCallIdx} (${v.toolCallId.slice(0, 12)}) → result@L${v.toolResultIdx}  距离=${v.distance} 条消息`)
    }
  }

  if (orphanResults.length > 0) {
    console.log(`\n  ── 孤儿 tool 结果 (无匹配 tool_call) ──`)
    for (const r of orphanResults) {
      console.log(`  L${String(r.index).padStart(4)}  tool_call_id=${r.tool_call_id.slice(0, 16)}  "${r.content.slice(0, 80)}"`)
    }
  }

  // 汇总判断
  const hasIssues = report.callsWithoutResult > 0 || report.callsNotAdjacent > 0 || orphanResults.length > 0
  console.log(`\n  ── 判定 ──`)
  if (!hasIssues) {
    console.log(`  ✓ 所有 tool_call 都有匹配结果且位置正确。`)
    console.log(`    如果 prompt engine 仍报"会话中断"，请检查 runResumePreflightOai 在 buildOaiRequest 中的行为。`)
  } else {
    console.log(`  ⚠ 发现问题:`)
    if (report.callsWithoutResult > 0) {
      console.log(`    - ${report.callsWithoutResult} 个孤儿 tool_call（assistant 有 tool_calls 但没有 tool 结果）`)
      console.log(`      → 这些在 prompt engine 每轮都会被注入合成结果"会话中断导致工具结果丢失"`)
    }
    if (report.callsNotAdjacent > 0) {
      console.log(`    - ${report.callsNotAdjacent} 个 tool 结果不在紧邻位置`)
      console.log(`      → 会触发 runResumePreflightOai 的全量重建（破坏前缀缓存）`)
    }
    if (orphanResults.length > 0) {
      console.log(`    - ${orphanResults.length} 个孤儿 tool 结果（tool 消息无对应 tool_call）`)
      console.log(`      → loadOai 的 repairOrphanToolCalls 会剥离它们`)
    }
  }
  console.log(`═══════════════════════════════════════════\n`)
}

// ─── 验证：用单元测试确保诊断逻辑正确 ───

function runSelfTests(): void {
  console.log('[self-test] 运行自检…')

  // 测试 1：干净会话
  {
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'edit X' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'success' },
      { role: 'user', content: 'done' },
    ]
    const r = diagnose(msgs)
    assert.equal(r.callsWithoutResult, 0, 'no orphans expected')
    assert.equal(r.callsNotAdjacent, 0, 'no adjacency violations expected')
    assert.equal(r.entries[0]!.adjacent, true, 'should be adjacent')
    assert.equal(r.entries[0]!.synthetic, false, 'should not be synthetic')
  }

  // 测试 2：孤儿 tool_call
  {
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'edit X' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      // 没有 tool 结果 → 孤儿
      { role: 'user', content: 'next' },
    ]
    const r = diagnose(msgs)
    assert.equal(r.callsWithoutResult, 1, 'should have 1 orphan')
  }

  // 测试 3：合成结果检测
  {
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'edit X' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '会话中断导致工具结果丢失——该写入操作很可能已经成功执行' },
      { role: 'user', content: 'next' },
    ]
    const r = diagnose(msgs)
    assert.equal(r.entries[0]!.synthetic, true, 'should detect synthetic result')
  }

  // 测试 4：乱序结果
  {
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'edit X' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'user', content: 'next turn' },        // 中间有 user 消息
      { role: 'tool', tool_call_id: 't1', content: 'late result' },
    ]
    const r = diagnose(msgs)
    assert.equal(r.callsWithoutResult, 0, 'result exists')
    assert.equal(r.callsNotAdjacent, 1, 'should be non-adjacent')
    assert.equal(r.entries[0]!.adjacent, false, 'should not be adjacent')
  }

  console.log('[self-test] ✓ 全部通过\n')
}

// ─── main ───

const filePath = process.argv[2]
if (!filePath) {
  console.log('用法: npx tsx scripts/diagnose-tool-orphans.ts <会话.jsonl>')
  console.log('示例: npx tsx scripts/diagnose-tool-orphans.ts ~/.rivet/sessions/proj-abc123/sess-456.jsonl')
  console.log('')
  runSelfTests()
  process.exit(0)
}

runSelfTests()

try {
  const messages = parseJsonl(filePath)
  const report = diagnose(messages)
  report.filePath = filePath
  printReport(report)
} catch (err) {
  console.error('诊断失败:', (err as Error).message)
  process.exit(1)
}
