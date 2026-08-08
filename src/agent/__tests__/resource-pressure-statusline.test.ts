import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Writable cwd: AgentLoop turn-cache telemetry fire-and-forgets a mkdir under
// cwd; an unwritable sentinel leaks an unhandledRejection onto later tests.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-statusline-cwd-'))
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'

/**
 * Wave A: resource_pressure trigger 经 onStatusLine 推送给 TUI（只展示不
 * 自动改配置）；资源恢复后推送 null 清除。阈值与 classifyResourcePressure
 * 一致（heap ≥75% warn / ≥90% error；cooldown 期间不报 heap）。
 */
describe('AgentLoop resource pressure status line', () => {
  function makeAgent(
    heapRatio: () => number,
    opts: { cooldown?: boolean; onStatusLine?: (text: string | null) => void } = {},
  ): AgentLoop {
    const registry = new ToolRegistry()
    const engine = new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: TEST_CWD },
    })
    const session = new SessionContext()
    return new AgentLoop({
      client: {
        stream: async () => { throw new Error('no stream in statusline test') },
      } as never,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      resourceSensorOptions: {
        memoryLimitBytes: 1_000,
        // heapUsed 直接按百分比映射（limit 1000）——ratio 即百分比
        memoryUsage: () => ({ rss: 950, heapUsed: 1000 * heapRatio() }),
        initialMemoryCooldownSamples: opts.cooldown ? 5 : 0,
      },
      onStatusLine: opts.onStatusLine,
    }, session, TEST_CWD)
  }

  it('high heap fires status line text (warn ≥75%, error ≥90%)', () => {
    const seen: Array<string | null> = []
    let ratio = 0.95
    const agent = makeAgent(() => ratio, { onStatusLine: t => seen.push(t) })

    agent.refreshReliabilityDecision()
    assert.equal(seen.length, 1)
    assert.ok(seen[0]!.includes('Memory CRITICAL'), `expected critical text, got: ${seen[0]}`)
    assert.ok(seen[0]!.includes('95%'))

    ratio = 0.8
    agent.refreshReliabilityDecision()
    assert.equal(seen.length, 2)
    assert.ok(seen[1]!.includes('Memory 80%'), `expected warn text, got: ${seen[1]}`)
  })

  it('resource recovery clears the status line with null', () => {
    const seen: Array<string | null> = []
    let ratio = 0.95
    const agent = makeAgent(() => ratio, { onStatusLine: t => seen.push(t) })

    agent.refreshReliabilityDecision()
    assert.ok(seen[0] !== null)

    ratio = 0.1
    agent.refreshReliabilityDecision()
    assert.equal(seen.length, 2)
    assert.equal(seen[1], null, 'recovery must clear the status line')
  })

  it('no pressure never touches the status line', () => {
    const seen: Array<string | null> = []
    const agent = makeAgent(() => 0.1, { onStatusLine: t => seen.push(t) })

    agent.refreshReliabilityDecision()
    assert.equal(seen.length, 0)
  })

  it('cooldown suppresses heap status line (only disk would show)', () => {
    const seen: Array<string | null> = []
    const agent = makeAgent(() => 0.95, { cooldown: true, onStatusLine: t => seen.push(t) })

    agent.refreshReliabilityDecision()
    // 无 disk sample（未传 sessionPersistPath）→ 无状态行，也不推送 null
    assert.equal(seen.length, 0)
  })

  it('unchanged pressure text is not re-pushed (dedup)', () => {
    const seen: Array<string | null> = []
    const agent = makeAgent(() => 0.95, { onStatusLine: t => seen.push(t) })

    agent.refreshReliabilityDecision()
    agent.refreshReliabilityDecision()
    assert.equal(seen.length, 1, 'same pressure text must not re-push')
  })
})
