import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MCTSPlanner, type PlanCandidate, type MCTSPlannerOpts } from '../mcts-planner.js'

describe('MCTSPlanner', () => {
  const mockExplore: MCTSPlannerOpts['explore'] = async (prompt, idx) =>
    `Path ${idx}: independent analysis of system design patterns`

  it('generates N candidate paths via expand()', async () => {
    const planner = new MCTSPlanner({ explore: mockExplore, branches: 3 })
    const candidates = await planner.expand('重构 auth 模块')
    assert.equal(candidates.length, 3)
    assert.ok(candidates.every(c => c.text.length > 0))
  })

  it('scores candidates by projection against anchor', () => {
    const planner = new MCTSPlanner({ explore: mockExplore })
    const candidates: PlanCandidate[] = [
      { text: 'auth auth OAuth2 auth token auth', projectionScore: 0 },
      { text: 'analyze token refresh via PKCE flow patterns', projectionScore: 0 },
    ]
    planner.score(candidates, ['auth', 'OAuth2'])
    assert.ok(candidates[0]!.projectionScore > candidates[1]!.projectionScore)
  })

  it('filter removes junk (high projection) candidates', () => {
    const planner = new MCTSPlanner({ explore: mockExplore, threshold: 0.3 })
    const candidates: PlanCandidate[] = [
      { text: 'auth auth auth', projectionScore: 0.8 },
      { text: 'independent idea', projectionScore: 0.05 },
    ]
    const seeds = planner.filter(candidates)
    assert.equal(seeds.length, 1)
    assert.equal(seeds[0]!.text, 'independent idea')
  })

  it('plan() returns all surviving seeds, not just one', async () => {
    let callCount = 0
    const planner = new MCTSPlanner({
      explore: async () => {
        callCount++
        return 'independent design with novel abstractions'
      },
      branches: 4,
    })
    const result = await planner.plan('auth OAuth2', ['auth', 'OAuth2'])
    assert.equal(callCount, 4)
    assert.equal(result.candidates.length, 4)
    assert.ok(result.seeds.length > 0)
    assert.ok(!result.allJunk)
  })

  it('plan() marks allJunk when all candidates are echo', async () => {
    const planner = new MCTSPlanner({
      explore: async () => 'auth auth auth OAuth2 auth auth OAuth2 auth',
      branches: 2,
    })
    const result = await planner.plan('auth OAuth2', ['auth', 'OAuth2'])
    assert.ok(result.allJunk)
    assert.equal(result.seeds.length, 0)
  })
})
