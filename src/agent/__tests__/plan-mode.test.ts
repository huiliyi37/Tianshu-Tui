import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkPlanMode, PLAN_MODE_ALLOWED_TOOLS } from '../plan-mode.js'
import { createDefaultToolRegistry } from '../../tools/default-registry.js'
import { WEB_SEARCH_TOOL } from '../../tools/web-search.js'
import { createRepoGraphTool } from '../../tools/repo-graph.js'
import { createRecallTool } from '../../tools/recall.js'
import type { ContextClaimStore } from '../../context/claim-store.js'

describe('checkPlanMode', () => {
  it('off state allows all tools', () => {
    assert.deepEqual(checkPlanMode('off', 'write_file'), { allowed: true })
    assert.deepEqual(checkPlanMode('off', 'bash'), { allowed: true })
    assert.deepEqual(checkPlanMode('off', 'edit_file'), { allowed: true })
  })

  it('planning state allows read-only exploration tools', () => {
    const allowedTools = ['read_file', 'read_section', 'grep', 'glob', 'repo_map',
      'inspect_project', 'related_tests', 'diff', 'todo', 'plan_close',
      'repo_graph', 'web_fetch', 'web_search', 'recall']
    for (const tool of allowedTools) {
      assert.deepEqual(checkPlanMode('planning', tool), { allowed: true }, `${tool} should be allowed`)
    }
  })

  it('planning state blocks write tools', () => {
    const blockedTools = ['write_file', 'edit_file', 'bash', 'run_tests']
    for (const tool of blockedTools) {
      const result = checkPlanMode('planning', tool)
      assert.equal(result.allowed, false, `${tool} should be blocked`)
      assert.ok(result.reason, `${tool} should have a reason`)
      assert.ok(result.reason!.includes('Plan Mode'), `${tool} reason should mention Plan Mode`)
    }
  })

  it('planning state blocks delegation and delivery tools', () => {
    const blockedTools = ['delegate_task', 'delegate_batch', 'deliver_task']
    for (const tool of blockedTools) {
      const result = checkPlanMode('planning', tool)
      assert.equal(result.allowed, false, `${tool} should be blocked in plan mode`)
      assert.ok(result.reason!.includes('Plan Mode'), `${tool} reason should mention Plan Mode`)
    }
  })

  it('PLAN_MODE_ALLOWED_TOOLS excludes write and delegation tools', () => {
    assert.ok(PLAN_MODE_ALLOWED_TOOLS instanceof Set)
    assert.ok(PLAN_MODE_ALLOWED_TOOLS.has('read_file'))
    assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has('write_file'))
    assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has('delegate_task'))
    assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has('delegate_batch'))
    assert.ok(!PLAN_MODE_ALLOWED_TOOLS.has('deliver_task'))
  })

  // Drift guard: every whitelisted tool must resolve to a real registered tool.
  // This previously broke when web_search was listed here but never registered
  // anywhere (orphan). web_search/repo_graph/recall live in the interactive
  // (bootstrap) layer, not the kernel default-registry.
  it('every PLAN_MODE_ALLOWED_TOOLS entry resolves to a registered tool', () => {
    const defaultNames = createDefaultToolRegistry([], { desktopTools: true, browserTool: true })
      .getDefinitions()
      .map(d => d.name)
    const interactiveNames = [
      WEB_SEARCH_TOOL.definition.name,
      createRepoGraphTool(() => null).definition.name,
      createRecallTool({} as ContextClaimStore).definition.name,
    ]
    const available = new Set([...defaultNames, ...interactiveNames])
    for (const tool of PLAN_MODE_ALLOWED_TOOLS) {
      assert.ok(
        available.has(tool),
        `PLAN_MODE_ALLOWED_TOOLS references "${tool}" but no tool registers it (orphan/drift)`,
      )
    }
  })
})
