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
    it('stays under 210 lines (trained-mode dilution guard)', () => {
      // 2026-07-06: 阈值 200→210（有意识、有记录的抬阈，同 tool-count 25→26 先例）。
      // 200 线在 2026-06 已被多次纪律性规则（todo 通用化、action-intent gate、
      // 拒绝读原因等）累计突破到 203，且每条都有独立复盘依据；identity_volume
      // 守卫（≥5%）仍然通过，说明 identity 信号未被稀释。继续加行前先自问：
      // 能否合并/删除现有规则，而不是无脑抬阈值。
      assert.ok(
        lines.length <= 210,
        `BASE_PROMPT is ${lines.length} lines (limit: 210). ` +
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
    it('default tool registry stays under 26 tools', () => {
      const registry = createDefaultToolRegistry()
      const count = registry.getAll().length
      // 2026-07-01: 阈值 25→26，为后台任务控制工具 `job`(list/await/logs/kill) 让出一格。
      // 这是一次「有意识、有记录」的抬阈（guardrail 本意是防止悄悄退化，非绝对禁止增长）：
      // `job` 提供 await 这一主控必需的异步能力，与现有任何工具都不重叠，不属于冗余膨胀。
      assert.ok(
        count <= 26,
        `Default registry has ${count} tools (limit: 26). ` +
          `Beyond ~26, agents experience choice overload and retreat to most-familiar tools ` +
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
