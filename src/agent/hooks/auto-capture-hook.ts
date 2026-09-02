/**
 * 记忆形成侧 hook：postTool 缓冲「重要操作」候选 + postSession 模型判断冲销。
 *
 * 分工：
 * - postTool：启发式预筛（isImportantOperation），把候选压入会话级缓冲，
 *   零 LLM 调用、零阻断——真正的重要性判断延后到会话末批量做。
 * - postSession：把缓冲里的候选送一次侧路 LLM（runGateCompletion），模型自主
 *   判断哪些值得记 + 截取摘要，写回 LTM（auto-capture 源）。LLM 不可用/超时
 *   fail-closed：不写，绝不回退正则。
 *
 * 成本控制：一次会话至多一次侧路调用（候选为空则跳过）；缓冲上限防膨胀。
 */

import type { PostToolRuntimeHook, PostSessionRuntimeHook } from '../runtime-hooks.js'
import {
  isImportantOperation, buildCapturePrompt, parseCaptureOutput, applyCaptureVerdicts,
  autoCaptureEnabled, type CaptureCandidate,
} from '../../memory/auto-capture.js'

const MAX_CANDIDATES = 12

export interface AutoCaptureHookDeps {
  cwd: string
  sessionId?: string
  /** 侧路 LLM 调用（廉价路由）；实现方负责 usage 落账 + 有界返回。 */
  complete: (prompt: string, timeoutMs: number) => Promise<string>
  /** 内层预算。默认 12s。 */
  timeoutMs?: number
}

export interface AutoCaptureHooks {
  postTool: PostToolRuntimeHook
  postSession: PostSessionRuntimeHook
}

/**
 * 记忆形成侧 hook 对。postTool 缓冲候选，postSession 判冲销。
 */
export function createAutoCaptureHooks(deps: AutoCaptureHookDeps): AutoCaptureHooks {
  const buffer: CaptureCandidate[] = []
  const enabled = autoCaptureEnabled()

  return {
    postTool: {
      phase: 'postTool',
      name: 'memory-auto-capture',
      run(_ctx, tool) {
        if (!enabled) return
        if (buffer.length >= MAX_CANDIDATES) return
        const candidate = isImportantOperation(tool, deps.cwd)
        if (!candidate) return
        // 防：同一工具重复写同一目标只取一次（去重）。
        const key = `${candidate.tool}:${candidate.summary}`
        if (buffer.some(c => `${c.tool}:${c.summary}` === key)) return
        buffer.push(candidate)
      },
    },
    postSession: {
      phase: 'postSession',
      name: 'memory-auto-capture',
      async run() {
        if (!enabled || buffer.length === 0) return
        const candidates = buffer.splice(0)
        const prompt = buildCapturePrompt(candidates, deps.sessionId)
        let raw: string
        try {
          raw = await deps.complete(prompt, deps.timeoutMs ?? 12_000)
        } catch {
          return // fail-closed：LLM 不可用不写
        }
        const verdicts = parseCaptureOutput(raw, candidates.length)
        if (!verdicts) return // fail-closed：输出不可解析不写
        applyCaptureVerdicts(deps.cwd, deps.sessionId, candidates, verdicts)
      },
    },
  }
}
