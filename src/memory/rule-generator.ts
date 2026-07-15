/**
 * Rule generator — **disabled since Wave 1（知识重构）**.
 *
 * 曾按"相似观察 ≥3 次"自动落 `.rivet/rules/auto-*.md`，无互斥校验，
 * 实际产出过五条互相矛盾的规则（项目同时"用 jest/vitest/node:test/biome/eslint"）。
 * 规则生成职能移交 postSession essence-gate（LLM 准入闸，见 src/memory/essence-gate.ts）。
 *
 * 函数签名保留（返回 null 的 no-op），供旧调用方与测试平滑过渡。
 */

export function maybeGenerateRule(_cwd: string, _observationText: string): string | null {
  return null
}

export function processObservationForRuleGeneration(cwd: string, observationText: string): string | null {
  return maybeGenerateRule(cwd, observationText)
}
