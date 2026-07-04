/**
 * Dead-End Detector — postTool 检测"同一文件反复 edit→verify-fail"死路循环
 * (主控工作流缺口 A,2026-07-04)。
 *
 * 核查修正(相对天枢原提案):编辑工具本身几乎不会失败——写盘成功但语义
 * 错误的失败挂在**验证**路径(classifyFailure)。所以信号不是"edit 连续
 * 失败",而是:同一文件 edit → verify fail → edit → verify fail,循环 ≥2
 * 次且中间无 verify pass。这是"盲改"的客观签名:模型在没有新诊断信息的
 * 情况下反复改同一处。
 *
 * 与 stigmergy-hook 的 dead-end 沉积互补:那边管 bash 同命令反复失败
 * (命令级),这边管 edit→verify 循环(文件级)。排除判据同源
 * (2026-07-02 收紧):timeout / environment 类失败不算语义失败。
 *
 * 出生即可测(因果账本):expect = tool_appears(诊断类工具, 2 轮)——
 * 采纳 = 停止盲改转向诊断(read/grep/git diff),自动进 holdout lift
 * 与跨会话效能信息素。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'
import { VERIFY_BASH_RE } from './self-verify-hook.js'
import { WRITE_TOOL_NAMES, extractWriteFilePaths } from '../../tools/write-tool-helpers.js'

export interface DeadEndDetectorDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** stigmergy 沉积(file target dead-end 信息素,跨会话经 signal-consumer 复用) */
  deposit?: (deposit: PheromoneDeposit) => Promise<void>
}

/** 触发阈值:同文件 edit→verify-fail 循环次数 */
const CYCLE_THRESHOLD = 2

/** 诊断类工具 — expect 谓词与触发内容共用(采纳 = 转向这些工具) */
const DIAGNOSIS_TOOLS = ['read_file', 'grep', 'glob', 'semantic_search', 'lsp_goto_definition', 'lsp_find_references']

interface FileCycleState {
  /** 完成的 edit→verify-fail 循环数 */
  cycles: number
  /** 最近一次 edit 之后是否还没等到验证结果(防止一次失败计多次) */
  editPending: boolean
  /** 本会话已对该文件触发过(一次性,不重复告警) */
  fired: boolean
}

function isVerifyEvent(tool: RuntimeToolEvent): boolean {
  if (tool.name === 'run_tests') return true
  if (tool.name === 'bash') {
    const cmd = (tool.input?.command as string) ?? tool.target ?? ''
    return VERIFY_BASH_RE.test(cmd)
  }
  return false
}

/** timeout / 环境类失败不算语义失败(与 stigmergy dead-end 收紧同判据) */
function isNonSemanticFailure(tool: RuntimeToolEvent): boolean {
  return tool.failureClass === 'timeout' || tool.failureClass === 'env_missing'
}

export function createDeadEndDetectorHook(
  deps: DeadEndDetectorDeps,
): PostToolRuntimeHook & { getCycleCount: (file: string) => number } {
  const files = new Map<string, FileCycleState>()

  function stateFor(file: string): FileCycleState {
    let s = files.get(file)
    if (!s) {
      s = { cycles: 0, editPending: false, fired: false }
      files.set(file, s)
    }
    return s
  }

  const hook: PostToolRuntimeHook & { getCycleCount: (file: string) => number } = {
    phase: 'postTool',
    name: 'dead-end-detector',
    getCycleCount(file: string) { return files.get(file)?.cycles ?? 0 },
    async run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> {
      // ── 编辑:标记所有被修改文件进入"等待验证"───────────────
      if (WRITE_TOOL_NAMES.has(tool.name) && tool.success) {
        for (const file of extractWriteFilePaths(tool.name, tool.input as Record<string, unknown> | undefined)) {
          stateFor(file).editPending = true
        }
        return
      }

      if (!isVerifyEvent(tool)) return

      // ── 验证通过:全部清零(死路解除)────────────────────────
      if (tool.success) {
        files.clear()
        return
      }

      // 非语义失败(timeout/缺命令)不构成死路证据
      if (isNonSemanticFailure(tool)) return

      // ── 验证失败:所有 pending 文件各记一次循环 ────────────────
      for (const [file, s] of files) {
        if (!s.editPending) continue
        s.editPending = false
        s.cycles++

        if (s.cycles >= CYCLE_THRESHOLD && !s.fired) {
          s.fired = true
          deps.advisoryBus.submit({
            key: 'dead-end-file',
            priority: 0.7,
            category: 'dead_end',
            tier: 'operational',
            content: `同一文件 ${file} 已 ${s.cycles} 次「编辑→验证失败」且中间无一次通过——这是盲改信号。停止在原处继续改:先用 read_file/grep/git diff 重新诊断失败根因,或回退本轮改动换一条实现路径,或把改动拆成更小的可验证步骤。`,
            ttl: 2,
            // 采纳 = 停止盲改转向诊断类动作(2 轮内出现 read/grep 等)
            expect: { kind: 'tool_appears', tools: DIAGNOSIS_TOOLS, withinTurns: 2 },
            channel: 'system-reminder',
          })
          // 文件级 dead-end 信息素:跨会话经 signal-consumer 复用
          try {
            await deps.deposit?.({ path: file, signal: 'dead-end', strength: 0.8 })
          } catch { /* stigmergy 沉积 best-effort */ }
        }
      }
    },
  }

  return hook
}
