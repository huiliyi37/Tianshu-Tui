import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupIntoWaves, topologicalOrder, validateTaskGraph, type TaskGraph } from '../task-graph.js'

describe('task-graph', () => {
  it('validates dangling dependencies', () => {
    const graph: TaskGraph = {
      mission: 'test',
      createdAt: Date.now(),
      nodes: [
        { id: 'T1', title: 'a', objective: 'a', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: ['missing'], riskTier: 'low' },
      ],
    }
    const v = validateTaskGraph(graph)
    assert.equal(v.valid, false)
    assert.equal(v.dangling.length, 1)
  })

  it('orders nodes topologically', () => {
    const graph: TaskGraph = {
      mission: 'test',
      createdAt: Date.now(),
      nodes: [
        { id: 'T2', title: 'b', objective: 'b', profile: 'patcher', kind: 'patch_proposal', files: [], dependsOn: ['T1'], riskTier: 'low' },
        { id: 'T1', title: 'a', objective: 'a', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      ],
    }
    const order = topologicalOrder(graph)
    assert.equal(order.indexOf('T1') < order.indexOf('T2'), true)
  })

  it('groups into waves', () => {
    const graph: TaskGraph = {
      mission: 'test',
      createdAt: Date.now(),
      nodes: [
        { id: 'T1', title: 'a', objective: 'a', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
        { id: 'T2', title: 'b', objective: 'b', profile: 'patcher', kind: 'patch_proposal', files: [], dependsOn: ['T1'], riskTier: 'low' },
        { id: 'T3', title: 'c', objective: 'c', profile: 'verifier', kind: 'verify', files: [], dependsOn: ['T2'], riskTier: 'low' },
      ],
    }
    const waves = groupIntoWaves(graph)
    assert.equal(waves.length, 3)
    assert.deepEqual(waves[0], ['T1'])
  })
})
