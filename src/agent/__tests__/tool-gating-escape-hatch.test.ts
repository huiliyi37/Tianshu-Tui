import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { gateToolDefinitions } from '../tool-tiers.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ToolDefinition } from '../../api/types.js'

// Covers the two follow-up closures:
//  #2 headless/consistency: gating is applied via one shared gateToolDefinitions
//     (deny-list: only EXTENDED removed; CORE + uncategorized like MCP/LSP kept).
//  #1 escape hatch: AgentLoop.enableTool mounts an EXTENDED tool at a turn
//     boundary, with provider-aware cache-impact reporting, and updateTools()
//     honors the gate (the historical MCP/LSP "revert to full set" bug).

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-tool-gating-'))

function def(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: 'object', properties: {} } } as ToolDefinition
}

function fakeTool(name: string) {
  return { definition: def(name), isEnabled: () => true, execute: async () => ({ content: '' }) }
}

const NOOP_CLIENT = { stream: async () => {} } as unknown as StreamClient

/** read_file = CORE, browser = EXTENDED, mcp_foo = uncategorized (MCP-like). */
function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(fakeTool('read_file') as never)
  r.register(fakeTool('browser') as never)
  r.register(fakeTool('mcp_foo') as never)
  return r
}

function makeAgent(opts: {
  gatingEnabled: boolean
  prefixCacheStrategy?: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  engineSeedFull?: boolean
}): { agent: AgentLoop; engine: PromptEngine; registry: ToolRegistry } {
  const registry = makeRegistry()
  // engineSeedFull simulates the MCP/LSP path where the engine could end up with
  // the FULL set before updateTools re-gates.
  const seedTools = opts.engineSeedFull
    ? registry.getDefinitions()
    : gateToolDefinitions(registry.getDefinitions(), { enabled: opts.gatingEnabled })
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: seedTools },
    volatileCtx: { cwd: TEST_CWD },
  })
  const agent = new AgentLoop({
    client: NOOP_CLIENT,
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 1,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    toolGating: opts.gatingEnabled ? { enabled: true } : undefined,
    prefixCacheStrategy: opts.prefixCacheStrategy ?? 'deepseek-native',
  }, new SessionContext(), TEST_CWD)
  return { agent, engine, registry }
}

function engineToolNames(engine: PromptEngine): string[] {
  return (engine as unknown as { config: { staticCtx: { tools: ToolDefinition[] } } })
    .config.staticCtx.tools.map(t => t.name)
}

describe('gateToolDefinitions', () => {
  const all = [def('read_file'), def('browser'), def('mcp_foo')]

  it('disabled → returns full set (no filtering)', () => {
    const out = gateToolDefinitions(all, { enabled: false }).map(d => d.name)
    assert.deepEqual(out.sort(), ['browser', 'mcp_foo', 'read_file'])
  })

  it('deny-list default → removes EXTENDED, keeps CORE + uncategorized (MCP)', () => {
    const out = gateToolDefinitions(all, { enabled: true }).map(d => d.name)
    assert.ok(out.includes('read_file'), 'CORE kept')
    assert.ok(out.includes('mcp_foo'), 'uncategorized/MCP kept (regression guard)')
    assert.ok(!out.includes('browser'), 'EXTENDED removed')
  })

  it('CORE web_search survives gating (migrated from EXTENDED — regression guard)', () => {
    // web_search/web_fetch moved from EXTENDED to CORE; the gate must NOT drop them.
    const out = gateToolDefinitions([def('read_file'), def('web_search'), def('web_fetch')], { enabled: true }).map(d => d.name)
    assert.ok(out.includes('web_search'), 'web_search is CORE now — must not be gated out')
    assert.ok(out.includes('web_fetch'), 'web_fetch is CORE now — must not be gated out')
    assert.ok(out.includes('read_file'))
  })

  it('extraCore exempts a named EXTENDED tool', () => {
    const out = gateToolDefinitions(all, { enabled: true, extraCore: ['browser'] }).map(d => d.name)
    assert.ok(out.includes('browser'))
  })

  it('mountedExtras exempts a runtime-mounted EXTENDED tool', () => {
    const out = gateToolDefinitions(all, { enabled: true, mountedExtras: ['browser'] }).map(d => d.name)
    assert.ok(out.includes('browser'))
  })

  it('coreOverride switches to allow-list (drops uncategorized)', () => {
    const out = gateToolDefinitions(all, { enabled: true, coreOverride: ['read_file'] }).map(d => d.name)
    assert.deepEqual(out, ['read_file'])
  })

  it('domainTier takes precedence over coreOverride', () => {
    const out = gateToolDefinitions(all, {
      enabled: true,
      domainTier: ['mcp_foo'],
      coreOverride: ['read_file'],
    }).map(d => d.name)
    assert.deepEqual(out, ['mcp_foo'])
  })
})

describe('AgentLoop tool gating + escape hatch', () => {
  it('getActiveToolNames reflects deny-list gate (CORE + MCP, no EXTENDED)', () => {
    const { agent } = makeAgent({ gatingEnabled: true })
    const names = agent.getActiveToolNames()
    assert.ok(names.includes('read_file'))
    assert.ok(names.includes('mcp_foo'))
    assert.ok(!names.includes('browser'))
  })

  it('updateTools honors the gate — never re-adds EXTENDED (MCP/LSP revert bug)', () => {
    // engine seeded with FULL set (as the MCP/LSP path would), then updateTools re-gates.
    const { agent, engine } = makeAgent({ gatingEnabled: true, engineSeedFull: true })
    assert.ok(engineToolNames(engine).includes('browser'), 'precondition: engine started full')
    agent.updateTools()
    const names = engineToolNames(engine)
    assert.ok(!names.includes('browser'), 'updateTools must NOT re-add EXTENDED')
    assert.ok(names.includes('read_file') && names.includes('mcp_foo'))
  })

  it('enableTool mounts an EXTENDED tool and reports prefix-cache impact (deepseek)', () => {
    const { agent, engine } = makeAgent({ gatingEnabled: true, prefixCacheStrategy: 'deepseek-native' })
    const res = agent.enableTool('browser')
    assert.equal(res.status, 'mounted')
    assert.equal(res.cacheImpact, 'prefix-invalidated')
    assert.equal(res.prefixCacheStrategy, 'deepseek-native')
    assert.ok(agent.getActiveToolNames().includes('browser'), 'now visible to main agent')
    assert.ok(engineToolNames(engine).includes('browser'), 'engine refreshed with mounted tool')
  })

  it('enableTool reports no cache penalty for non-prefix-cache providers', () => {
    const { agent } = makeAgent({ gatingEnabled: true, prefixCacheStrategy: 'none' })
    const res = agent.enableTool('browser')
    assert.equal(res.status, 'mounted')
    assert.equal(res.cacheImpact, 'none')
  })

  it('enableTool is idempotent (already-active on second call)', () => {
    const { agent } = makeAgent({ gatingEnabled: true })
    assert.equal(agent.enableTool('browser').status, 'mounted')
    assert.equal(agent.enableTool('browser').status, 'already-active')
  })

  it('enableTool rejects CORE tools as not-extended (already visible)', () => {
    const { agent } = makeAgent({ gatingEnabled: true })
    assert.equal(agent.enableTool('read_file').status, 'not-extended')
  })

  it('enableTool treats uncategorized/MCP as not-extended (already visible)', () => {
    const { agent } = makeAgent({ gatingEnabled: true })
    assert.equal(agent.enableTool('mcp_foo').status, 'not-extended')
  })

  it('enableTool reports unknown for unregistered tools', () => {
    const { agent } = makeAgent({ gatingEnabled: true })
    assert.equal(agent.enableTool('does_not_exist').status, 'unknown')
  })

  it('enableTool reports gating-off when gating is disabled', () => {
    const { agent } = makeAgent({ gatingEnabled: false })
    assert.equal(agent.enableTool('browser').status, 'gating-off')
  })
})
