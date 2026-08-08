/**
 * 工具描述中文化守卫 — 内置工具的模型-facing 文本（definition.description +
 * input_schema 字段描述）必须为中文，防回潮。2026-07 全量中文化分波期间，
 * 未译工具列入 PENDING_LOCALE 豁免，随 Wave 推进清空（最终该集合应为空）。
 *
 * 口径：
 * - definition.description：CJK ≥ 10 个字符，或占比 > 5%。
 * - schema 字段描述（递归 properties/items）：长度 ≥ 12 字符的必须含 CJK；
 *   短于 12 字符的碎片（如枚举拼接）放行。
 * - 保持英文的元素（工具名/字段名/enum 值/代码示例）不属于 description 文本面。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../default-registry.js'

const PENDING_LOCALE: ReadonlySet<string> = new Set([
  // 全量中文化已完成——豁免清单已清空
])

const CJK_RE = /[一-鿿]/
const cjkCount = (s: string): number => (s.match(/[一-鿿]/g) ?? []).length

interface ToolDefLike {
  name: string
  description?: string
  input_schema?: { properties?: Record<string, unknown> }
}

/** 递归收集 schema 里所有 description 文本（properties + items 下钻一层层）。 */
function collectFieldDescriptions(schema: unknown, out: string[] = []): string[] {
  if (!schema || typeof schema !== 'object') return out
  const node = schema as { description?: unknown; properties?: Record<string, unknown>; items?: unknown }
  if (typeof node.description === 'string' && node.description.length > 0) out.push(node.description)
  if (node.properties) for (const v of Object.values(node.properties)) collectFieldDescriptions(v, out)
  if (node.items) collectFieldDescriptions(node.items, out)
  return out
}

/** 交互层/条件注册的工具模块（注册表覆盖不到的），按导出扫描定义。 */
const EXTRA_TOOL_MODULES = [
  '../delegate-task.js',
  '../delegate-batch.js',
  '../ask-user-question.js',
  '../memory.js',
  '../../agent/deliver-task.js',
  '../team-orchestrate.js',
  '../council-convene.js',
  '../plan-task.js',
  '../attack-case.js',
  '../semantic-search.js',
  '../repo-graph.js',
  '../undo.js',
  '../recall-general.js',
  '../record-general-finding.js',
  '../recall-capsule.js',
  '../update-goal.js',
  '../sandbox-exec-tool.js',
  '../session-vitals.js',
  '../apply-patch.js',
  '../browser-debug/tool.js',
  // schedule 三工具按 isSchedulerAvailable() 条件注册（CLI 无调度器时不入表），
  // 注册表枚举扫不到，必须按模块导出扫——否则门控一加，英文描述就失去守卫。
  '../schedule/tool.js',
  '../../lsp/tools.js',
] as const

function extractDefinition(value: unknown): ToolDefLike | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { definition?: ToolDefLike; name?: string; description?: string }
  if (v.definition && typeof v.definition.name === 'string') return v.definition
  if (typeof v.name === 'string' && typeof v.description === 'string') return v as ToolDefLike
  return null
}

async function collectAllDefinitions(): Promise<ToolDefLike[]> {
  const defs = new Map<string, ToolDefLike>()
  for (const d of createDefaultToolRegistry([], {
    preset: 'full', desktopTools: true, browserTool: true, computerUse: true, proEnabled: true,
  }).getDefinitions()) {
    defs.set(d.name, d as ToolDefLike)
  }
  for (const path of EXTRA_TOOL_MODULES) {
    const mod = await import(path)
    for (const [exportName, exported] of Object.entries(mod)) {
      let def = extractDefinition(exported)
      // 工厂导出（createXxxTool）：用空参/空对象尝试实例化，失败即跳过——
      // 只取 definition 文本，绝不触发 execute。
      if (!def && typeof exported === 'function' && /^create[A-Za-z]*Tool$/.test(exportName)) {
        for (const args of [[], [{}]] as const) {
          try { def = extractDefinition((exported as (...a: unknown[]) => unknown)(...args)) } catch { /* dep-hungry factory — skip */ }
          if (def) break
        }
      }
      if (def && !defs.has(def.name)) defs.set(def.name, def)
    }
  }
  return [...defs.values()]
}

describe('工具描述中文化守卫', () => {
  it('非豁免工具的 definition.description 必须为中文', async () => {
    const defs = await collectAllDefinitions()
    const violations: string[] = []
    for (const d of defs) {
      if (PENDING_LOCALE.has(d.name)) continue
      const desc = d.description ?? ''
      const zh = cjkCount(desc)
      if (!(zh >= 10 || zh / desc.length > 0.05)) {
        violations.push(`${d.name}（CJK ${zh}/${desc.length}）`)
      }
    }
    assert.deepEqual(violations, [], `英文描述残留：\n${violations.join('\n')}`)
  })

  it('非豁免工具的 schema 字段描述（≥12 字符）必须含 CJK', async () => {
    const defs = await collectAllDefinitions()
    const violations: string[] = []
    for (const d of defs) {
      if (PENDING_LOCALE.has(d.name)) continue
      for (const fd of collectFieldDescriptions(d.input_schema)) {
        if (fd.length >= 12 && !CJK_RE.test(fd)) {
          violations.push(`${d.name}: "${fd.slice(0, 60)}…"`)
        }
      }
    }
    assert.deepEqual(violations, [], `英文字段描述残留：\n${violations.join('\n')}`)
  })

  it('覆盖面自检：收集到的工具定义 ≥ 50（防收集逻辑静默漏面）', async () => {
    const defs = await collectAllDefinitions()
    assert.ok(defs.length >= 50, `只收集到 ${defs.length} 个定义，收集逻辑可能漏面`)
  })

  it('豁免清单已清空（全量中文化完成）', () => {
    assert.ok(PENDING_LOCALE.size === 0, `PENDING_LOCALE 仍有 ${PENDING_LOCALE.size} 项——翻译未完成`)
  })
})
