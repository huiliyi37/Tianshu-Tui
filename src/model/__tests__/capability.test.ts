import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recommendModelForTask } from '../capability.js'

describe('model capability routing', () => {
  const cards = [
    { model: 'cheap-long', toolUseReliability: 0.6, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.4, contextWindow: 1000000, cacheEconomics: 'strong' as const, recommendedTasks: ['summarize'] },
    { model: 'tool-strong', toolUseReliability: 0.95, jsonStability: 0.9, editSuccessRate: 0.85, testRepairRate: 0.7, contextWindow: 128000, cacheEconomics: 'medium' as const, recommendedTasks: ['edit'] },
  ]

  it('prefers tool reliable model for edits', () => {
    assert.equal(recommendModelForTask('code_edit', cards).model, 'tool-strong')
  })

  it('prefers long context model for summarization', () => {
    assert.equal(recommendModelForTask('repo_summarization', cards).model, 'cheap-long')
  })
})
