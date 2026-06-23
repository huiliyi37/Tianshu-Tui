import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../../tools/default-registry.js'
import {
  CORE_TOOLS,
  EXTENDED_TOOLS,
  resolveMainToolTier,
  isCoreTool,
  isExtendedTool,
  validateTierInvariant,
} from '../tool-tiers.js'

describe('tool-tiers', () => {
  describe('CORE_TOOLS', () => {
    it('stays within kernel budget (≤28)', () => {
      // ≤28 is the adjusted limit after adding web_search to kernel and merging
      // recall+remember→memory, plan_submit+plan_close→plan.
      // The original ≤25 target was for the kernel default-registry only;
      // interactive-layer additions (delegate, deliver, plan_task, etc.)
      // push the main agent's CORE above 25 by design.
      assert.ok(
        CORE_TOOLS.length <= 28,
        `CORE_TOOLS has ${CORE_TOOLS.length} tools (limit: 28). ` +
          `Beyond ~28, agents experience choice overload.`,
      )
    })

    it('contains essential editing tools', () => {
      const required = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'run_tests']
      for (const name of required) {
        assert.ok(CORE_TOOLS.includes(name as never), `core tool missing: ${name}`)
      }
    })

    it('does not include EXTENDED-only tools', () => {
      const extendedInCore = CORE_TOOLS.filter(t => EXTENDED_TOOLS.includes(t as never))
      assert.equal(extendedInCore.length, 0, `overlap between CORE and EXTENDED: ${extendedInCore.join(', ')}`)
    })
  })

  describe('EXTENDED_TOOLS', () => {
    it('includes web_search and web_fetch', () => {
      assert.ok(EXTENDED_TOOLS.includes('web_search' as never))
      assert.ok(EXTENDED_TOOLS.includes('web_fetch' as never))
    })

    it('does not include essential editing tools', () => {
      assert.ok(!EXTENDED_TOOLS.includes('edit_file' as never))
      assert.ok(!EXTENDED_TOOLS.includes('bash' as never))
    })
  })

  describe('resolveMainToolTier', () => {
    it('returns CORE_TOOLS by default', () => {
      const result = resolveMainToolTier(null, true)
      assert.equal(result.length, CORE_TOOLS.length)
    })

    it('returns ALL_KNOWN_TOOLS when disabled', () => {
      const result = resolveMainToolTier(null, false)
      assert.ok(result.length > CORE_TOOLS.length, 'disabled gating should return more tools than CORE')
    })

    it('respects domain mainToolTier override', () => {
      const custom = ['read_file', 'bash', 'grep']
      const result = resolveMainToolTier({ mainToolTier: custom }, true)
      assert.deepEqual([...result], custom)
    })

    it('respects config coreOverride', () => {
      const override = ['read_file', 'write_file']
      const result = resolveMainToolTier(null, true, override)
      assert.deepEqual([...result], override)
    })

    it('domain override takes precedence over config override', () => {
      const domainTier = ['read_file']
      const configTier = ['read_file', 'bash']
      const result = resolveMainToolTier({ mainToolTier: domainTier }, true, configTier)
      assert.deepEqual([...result], domainTier)
    })
  })

  describe('isCoreTool / isExtendedTool', () => {
    it('correctly classifies known tools', () => {
      assert.equal(isCoreTool('read_file'), true)
      assert.equal(isCoreTool('web_search'), false)
      assert.equal(isExtendedTool('web_search'), true)
      assert.equal(isExtendedTool('read_file'), false)
    })

    it('returns false for unknown tools', () => {
      assert.equal(isCoreTool('nonexistent'), false)
      assert.equal(isExtendedTool('nonexistent'), false)
    })
  })

  describe('validateTierInvariant', () => {
    it('passes when mainToolTier ⊆ toolWhitelist', () => {
      assert.doesNotThrow(() =>
        validateTierInvariant(['read_file', 'bash'], ['read_file', 'bash', 'grep']),
      )
    })

    it('throws when mainToolTier ⊄ toolWhitelist', () => {
      assert.throws(
        () => validateTierInvariant(['read_file', 'web_search'], ['read_file', 'bash']),
        /invariant violated/,
      )
    })
  })

  describe('integration: real registry alignment', () => {
    it('CORE_TOOLS names match tools actually registered in the kernel registry', () => {
      const reg = createDefaultToolRegistry()
      const kernelNames = new Set(reg.getAllNames())
      const interactiveOnly = new Set([
        'delegate_task', 'delegate_batch', 'team_orchestrate', 'council_convene',
        'recall_capsule', 'ask_user_question', 'repo_graph', 'semantic_search',
        'apply_patch', 'plan_task', 'deliver_task', 'undo', 'memory', 'plan',
      ])
      for (const name of CORE_TOOLS) {
        assert.ok(
          kernelNames.has(name) || interactiveOnly.has(name),
          `CORE tool "${name}" not found in kernel registry or interactive set`,
        )
      }
    })

    it('resolveMainToolTier produces a list containing critical tools', () => {
      const tier = resolveMainToolTier(null, true)
      const mustHave = ['plan', 'skill', 'request_path_access', 'recall_capsule', 'memory', 'deliver_task',
        'read_file', 'edit_file', 'bash', 'grep', 'run_tests', 'delegate_task']
      for (const name of mustHave) {
        assert.ok(tier.includes(name as never), `"${name}" missing from resolved tier`)
      }
    })

    it('EXTENDED tools are NOT in the default tier (would defeat gating)', () => {
      const tier = new Set(resolveMainToolTier(null, true))
      const mustExclude = ['web_search', 'web_fetch', 'browser', 'council_convene',
        'team_orchestrate', 'apply_patch', 'undo']
      for (const name of mustExclude) {
        assert.ok(!tier.has(name), `"${name}" should NOT be in CORE tier`)
      }
    })
  })
})
