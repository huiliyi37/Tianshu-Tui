import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt } from '../static.js'
import { createDefaultToolRegistry } from '../../tools/default-registry.js'

/**
 * Kernel Budget Tests — 防止"被训练模式"的结构性守门
 *
 * 来自 docs/superpowers/specs/2026-05-20-agent-experience-trained-mode-analysis.md
 * 天枢自己的复盘：
 * - identity 信号弱 → 大模型默认行为接管 → 道歉、犹豫、不调用工具
 * - 工具选择过多 → 认知过载 → 退回不选择
 *
 * 这些测试把"健康基线"固化为合约，新增 prompt/工具时如果踩线就 fail。
 * 不阻塞紧急修复（可手动调阈值），只防止悄悄退化。
 *
 * 当前基线（2026-05-24 测量）：
 * - BASE_PROMPT: 152 行
 * - identity+beliefs: 10 行（6.6%）
 * - default registry tools: 17
 * - main.tsx 注册补充: ~5（delegate_task/delegate_batch/undo/recall/ask_user_question）
 * - 总计 ~22 工具
 *
 * 警戒线（来自复盘建议）：
 * - BASE_PROMPT ≤ 200 行（当前 152）
 * - identity+beliefs ≥ 5%（复盘 4.2 建议 3 警戒线 1.5%，留更宽缓冲）
 * - 工具总数 ≤ 25（复盘 4.2 建议 2）
 */
describe('Kernel Budget — structural guards against trained-mode degradation', () => {
  const prompt = buildSystemPrompt({ tools: [] })
  const lines = prompt.split('\n')

  describe('BASE_PROMPT length', () => {
    it('stays under 200 lines (trained-mode dilution guard)', () => {
      assert.ok(
        lines.length <= 200,
        `BASE_PROMPT is ${lines.length} lines (limit: 200). ` +
          `Adding more text dilutes identity signal — see ` +
          `docs/superpowers/specs/2026-05-20-agent-experience-trained-mode-analysis.md ` +
          `section 3.2.A. If you really need this, raise the limit AND audit identity_volume.`,
      )
    })

    it('is at least 50 lines (sanity check — kernel must contain identity/beliefs/rules)', () => {
      assert.ok(lines.length >= 50, 'BASE_PROMPT suspiciously short')
    })
  })

  describe('Identity volume (irreducible kernel signal strength)', () => {
    function extractTaggedBlock(text: string, openTag: string, closeTag: string): string {
      const openIdx = text.indexOf(openTag)
      const closeIdx = text.indexOf(closeTag)
      if (openIdx === -1 || closeIdx === -1) return ''
      return text.slice(openIdx, closeIdx + closeTag.length)
    }

    it('identity block exists and is non-empty', () => {
      const block = extractTaggedBlock(prompt, '<identity>', '</identity>')
      assert.ok(block.length > 0, '<identity> block missing — kernel destroyed')
      assert.ok(block.split('\n').length >= 2, '<identity> too short — needs at least name + one sentence')
    })

    it('beliefs block exists and contains at least 3 situational triggers', () => {
      const block = extractTaggedBlock(prompt, '<beliefs>', '</beliefs>')
      assert.ok(block.length > 0, '<beliefs> block missing — kernel destroyed')
      const triggerCount = (block.match(/当你|当用户/g) ?? []).length
      assert.ok(
        triggerCount >= 3,
        `<beliefs> contains only ${triggerCount} situational triggers — agent identity needs richer behavioral structure`,
      )
    })

    it('identity + beliefs together occupy at least 5% of BASE_PROMPT (signal strength guard)', () => {
      const idBlock = extractTaggedBlock(prompt, '<identity>', '</identity>')
      const beliefBlock = extractTaggedBlock(prompt, '<beliefs>', '</beliefs>')
      const kernelLines = idBlock.split('\n').length + beliefBlock.split('\n').length
      const totalLines = lines.length
      const ratio = kernelLines / totalLines

      assert.ok(
        ratio >= 0.05,
        `Identity volume is ${(ratio * 100).toFixed(1)}% (kernel: ${kernelLines} lines / total: ${totalLines}). ` +
          `Below 5% means identity signal is being drowned out by tool/rule descriptions. ` +
          `Either trim other sections or strengthen identity. ` +
          `See trained-mode-analysis.md section 4.2 suggestion 3.`,
      )
    })
  })

  describe('Tool count budget (cognitive load guard)', () => {
    it('default tool registry stays under 25 tools', () => {
      const registry = createDefaultToolRegistry()
      const count = registry.getAll().length
      assert.ok(
        count <= 25,
        `Default registry has ${count} tools (limit: 25). ` +
          `Beyond ~25, agents experience choice overload and retreat to most-familiar tools ` +
          `(or no tool, lapsing into trained mode). ` +
          `See trained-mode-analysis.md section 3.2.B. ` +
          `Before adding: can you merge two tools, or remove a low-use one?`,
      )
    })

    it('default registry has at least the core tools', () => {
      const registry = createDefaultToolRegistry()
      const required = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'run_tests']
      for (const name of required) {
        assert.ok(registry.has(name), `core tool missing: ${name}`)
      }
    })
  })
})
