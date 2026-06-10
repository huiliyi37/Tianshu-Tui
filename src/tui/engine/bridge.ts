/**
 * T9 Bridge — 将 TuiApp 接入现有 AgentLoop。
 *
 * 这是阶段 6 的参考实现。它将 TuiApp 的 AgentCallbacks 接口
 * 桥接到 AgentLoop.run() 的 callback 参数。
 *
 * 使用方式（在 main.tsx 或 main-ansi.ts 中）：
 *
 *   const app = new TuiApp({ stdout, stdin, cols, rows, modelName });
 *   app.registerOverlays();
 *   const bridge = createT9Bridge(app, agent);
 *   await bridge.run(prompt);
 */

import { TuiApp, type AgentCallbacks } from './app.js'

/**
 * 将 TuiApp 回调绑定到 AgentLoop.run() 的参数。
 *
 * 返回一个代理回调对象：它在 AgentLoop 的每个事件上调用 TuiApp
 * 对应的处理器，然后转发给原始回调（如果有）。
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
    onToolResult: (id, name, content, isError, rawPath) => {
      app.callbacks.onToolResult(id, name, content, isError, rawPath)
      original.onToolResult?.(id, name, content, isError, rawPath)
    },
    onCheckpoint: (hash) => {
      app.callbacks.onCheckpoint(hash)
      original.onCheckpoint?.(hash)
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
  }
}
