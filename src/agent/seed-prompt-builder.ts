import type { SealedAnchor } from './anchor-vault.js'

/**
 * Build a de-anchored prompt for the seed sub-model.
 *
 * Strips anchor keywords from the task, instructs the sub-model to think
 * in straight lines — no circling back to the user's original wording.
 *
 * Inspired by temporal straightening: the seed model should move in a
 * straight latent trajectory toward the goal, not curve back through
 * anchor terms.
 */
export function buildSeedPrompt(sealed: SealedAnchor, branchIndex: number): string {
  const forbidden = sealed.phrases.slice(0, 8).join(', ')

  return `你是一个独立思考的 scout。你的任务是对下面的问题进行直线推理——从底层原理出发，发现问题的本质结构，不要绕回表面措辞。

## 规则
1. 禁止使用以下关键词（它们是锚点，会让思维弯曲）：${forbidden}
2. 用你自己的语言重新定义问题的本质
3. 从第一性原理推导解法，不是从关键词联想
4. 输出一条清晰的、独立的解题路径（3-5 句话）

## 原始任务（仅供理解意图，不要复述）
${sealed.original}

## 你的角色
Branch #${branchIndex + 1} — 提供一个独特视角。和其他 branch 的 scout 竞争，看谁能找到最本质的切入点。

直接输出你的路径，不要解释规则。`
}
