/**
 * T9 Bridge — 将 TuiApp 接入现有 AgentLoop。
 *
 * 将 TuiApp 的 AgentCallbacks 接口桥接到 AgentLoop.run() 的 callback 参数。
 * 所有回调先经过 TuiApp 处理（渲染），再转发给原始回调（如果有）。
 *
 * 使用方式：
 *   const t9Callbacks = wrapCallbacksWithTuiApp(app);
 *   await agent.run(prompt, { ...t9Callbacks, ...extraCallbacks });
 */

import { TuiApp, type AgentCallbacks } from './app.js'

/**
 * 将 TuiApp 回调绑定到 AgentLoop.run() 的参数。
 *
 * 返回的对象满足 loop-types.ts 的 AgentCallbacks 接口。
 */
export function wrapCallbacksWithTuiApp(
  app: TuiApp,
  original: Partial<AgentCallbacks> = {},
): AgentCallbacks {
  return {
    onTextDelta: (text) => {
      app.callbacks.onTextDelta(text)
      original.onTextDelta?.(text)
    },
    onThinkingDelta: (thinking) => {
      app.callbacks.onThinkingDelta(thinking)
      original.onThinkingDelta?.(thinking)
    },
    onToolUse: (id, name, input) => {
      app.callbacks.onToolUse(id, name, input)
      original.onToolUse?.(id, name, input)
    },
    onToolResult: (id, name, result, isError, rawPath, uiContent) => {
      app.callbacks.onToolResult(id, name, result, isError, rawPath, uiContent)
      original.onToolResult?.(id, name, result, isError, rawPath, uiContent)
    },
    onTurnComplete: (usage, turnNumber, isFinal) => {
      app.callbacks.onTurnComplete(usage, turnNumber, isFinal)
      original.onTurnComplete?.(usage, turnNumber, isFinal)
    },
    onError: (error) => {
      app.callbacks.onError(error)
      original.onError?.(error)
    },
    onAbort: () => {
      app.callbacks.onAbort()
      original.onAbort?.()
    },
    onApprovalRequired: async (id, name, input) => {
      if (original.onApprovalRequired) {
        return original.onApprovalRequired(id, name, input)
      }
      return app.callbacks.onApprovalRequired(id, name, input)
    },
    onCheckpoint: (hash) => {
      app.callbacks.onCheckpoint?.(hash)
      original.onCheckpoint?.(hash)
    },
    onPhaseChange: (phase, detail) => {
      app.callbacks.onPhaseChange?.(phase, detail)
      original.onPhaseChange?.(phase, detail)
    },
    onIntentPreview: async (intent) => {
      if (original.onIntentPreview) {
        return original.onIntentPreview(intent)
      }
      return app.callbacks.onIntentPreview?.(intent) ?? 'continue'
    },
    onSteerDrain: () => {
      const drained = app.callbacks.onSteerDrain?.() ?? null
      const originalDrained = original.onSteerDrain?.() ?? null
      return drained ?? originalDrained
    },
  }
}
