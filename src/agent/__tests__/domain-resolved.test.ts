import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import type { AgentCallbacks } from '../loop-types.js'
import type { DomainDriftResult } from '../domain-drift-detector.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-domain-resolved-'))

interface ObservedDomainResolution {
  key: string
  name: string
  matchedKeywords: string[]
  reason: 'keyword' | 'fallback'
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeObservedAgent(
  options: { defaultDomain: string; domainKeywordRouting?: boolean },
): {
  agent: AgentLoop
  session: SessionContext
  callbacks: AgentCallbacks
  resolutions: ObservedDomainResolution[]
} {
  const client: StreamClient = {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta('done')
      cb.onContentBlock(textBlock('done'))
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as StreamClient
  const session = new SessionContext()
  const agent = new AgentLoop({
    client,
    promptEngine: new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: TEST_CWD },
    }),
    toolRegistry: new ToolRegistry(),
    maxTurns: 1,
    contextWindow: 1_000_000,
    defaultDomain: options.defaultDomain,
    ...(options.domainKeywordRouting === undefined
      ? {}
      : { domainKeywordRouting: options.domainKeywordRouting }),
    fsWatcherEnabled: false,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
  const resolutions: ObservedDomainResolution[] = []
  const callbacks: AgentCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onDomainResolved: (resolution: ObservedDomainResolution) => { resolutions.push(resolution) },
  }
  return { agent, session, callbacks, resolutions }
}

async function observeDomainResolution(
  prompt: string,
  options: { defaultDomain: string; domainKeywordRouting?: boolean },
): Promise<ObservedDomainResolution[]> {
  const { agent, callbacks, resolutions } = makeObservedAgent(options)
  await agent.run(prompt, callbacks)
  return resolutions
}

test('Auto emits one detailed resolution when keywords match', async () => {
  const resolutions = await observeDomainResolution('对账插桩测量定位这个偏差', {
    defaultDomain: 'auto',
    domainKeywordRouting: true,
  })
  assert.deepEqual(resolutions, [{
    key: 'kaiyang',
    name: '开阳',
    matchedKeywords: ['对账', '插桩', '测量'],
    reason: 'keyword',
  }])
})

test('Auto emits one fallback resolution when no unique match exists', async () => {
  const resolutions = await observeDomainResolution('帮我看看', {
    defaultDomain: 'auto',
    domainKeywordRouting: true,
  })
  assert.deepEqual(resolutions, [{
    key: 'tianquan',
    name: '天权',
    matchedKeywords: [],
    reason: 'fallback',
  }])
})

test('Auto reports fallback without keyword hits when routing is disabled', async () => {
  const resolutions = await observeDomainResolution('对账插桩测量定位这个偏差', {
    defaultDomain: 'auto',
    domainKeywordRouting: false,
  })
  assert.deepEqual(resolutions, [{
    key: 'tianquan',
    name: '天权',
    matchedKeywords: [],
    reason: 'fallback',
  }])
})

test('explicitly pinned domains do not emit an Auto resolution', async () => {
  const resolutions = await observeDomainResolution('对账插桩测量定位这个偏差', {
    defaultDomain: 'yaoguang',
  })
  assert.deepEqual(resolutions, [])
})

test('explicit session Auto overrides a pinned persistent default', () => {
  const { agent, callbacks, resolutions } = makeObservedAgent({
    defaultDomain: 'qiming',
    domainKeywordRouting: true,
  })

  agent.resetSessionDomain()
  agent.bindSessionDomain('请实现一个用户注册的功能，用很短很短的代码就行。', callbacks)

  assert.equal(agent.getSessionDomain()?.id, 'tianliang')
  assert.equal(agent.domainWasAutoResolved, true)
  assert.ok(agent.driftDetector)
  assert.equal(resolutions.at(0)?.key, 'tianliang')
})

test('an untouched session still follows its persistent default', () => {
  const { agent, callbacks, resolutions } = makeObservedAgent({
    defaultDomain: 'qiming',
    domainKeywordRouting: true,
  })

  agent.bindSessionDomain('请实现一个用户注册的功能', callbacks)

  assert.equal(agent.getSessionDomain()?.id, 'qiming')
  assert.equal(agent.domainWasAutoResolved, false)
  assert.equal(agent.driftDetector, null)
  assert.deepEqual(resolutions, [])
})

test('the same AgentLoop emits at most once across consecutive domain binds', () => {
  const { agent, callbacks, resolutions } = makeObservedAgent({
    defaultDomain: 'auto',
    domainKeywordRouting: true,
  })
  agent.bindSessionDomain('对账插桩定位这个偏差', callbacks)
  agent.bindSessionDomain('按计划实现用户注册', callbacks)

  assert.equal(resolutions.length, 1)
  assert.equal(resolutions[0]!.key, 'kaiyang')
  assert.equal(agent.domainWasAutoResolved, true)
  assert.ok(agent.driftDetector)
})

test('manual domain selection disables drift detection', () => {
  const { agent, callbacks } = makeObservedAgent({
    defaultDomain: 'auto',
    domainKeywordRouting: true,
  })
  agent.bindSessionDomain('按计划实现用户注册', callbacks)
  assert.equal(agent.domainWasAutoResolved, true)

  const domain = agent.getSessionDomain()
  assert.ok(domain)
  agent.setSessionDomain(domain)

  assert.equal(agent.domainWasAutoResolved, false)
  assert.equal(agent.driftDetector, null)
})

test('restoring a persisted Auto resolution keeps drift detection active', () => {
  const { agent, callbacks } = makeObservedAgent({
    defaultDomain: 'auto',
    domainKeywordRouting: true,
  })
  agent.bindSessionDomain('请实现一个用户注册功能', callbacks)
  const domain = agent.getSessionDomain()
  assert.ok(domain)

  agent.setSessionDomain(domain)
  agent.restoreAutoResolvedDomain(domain)

  assert.equal(agent.getSessionDomain()?.id, 'tianliang')
  assert.equal(agent.domainWasAutoResolved, true)
  assert.ok(agent.driftDetector)
})

test('Auto drift emits on one uniquely winning later turn and keeps the active domain', async () => {
  const { agent, session, callbacks } = makeObservedAgent({
    defaultDomain: 'qiming',
    domainKeywordRouting: true,
  })
  const drifts: DomainDriftResult[] = []
  callbacks.onDomainDrift = (drift) => { drifts.push(drift) }

  agent.resetSessionDomain()
  await agent.run('请实现一个用户注册的功能，用很短很短的代码就行。', callbacks)
  assert.equal(agent.getSessionDomain()?.id, 'tianliang')
  assert.equal(agent.domainWasAutoResolved, true)
  assert.ok(agent.driftDetector)

  await agent.run('请审查评估这个方案', callbacks)
  assert.equal(drifts.length, 1)
  const drift = drifts.at(0)
  assert.ok(drift)
  assert.equal(drift.recommendedId, 'tianquan')
  assert.equal(agent.getSessionDomain()?.id, 'tianliang')
  assert.equal(JSON.stringify(session.getMessages()).includes('星域漂移'), false)

  // Same direction is session-deduplicated even when it wins again.
  await agent.run('继续审查', callbacks)
  assert.equal(drifts.length, 1)
  assert.equal(agent.getSessionDomain()?.id, 'tianliang')
})

test('STAR_SOUL=0 does not emit a resolved domain', { concurrency: false }, () => {
  const saved = process.env.STAR_SOUL
  process.env.STAR_SOUL = '0'
  try {
    const { agent, callbacks, resolutions } = makeObservedAgent({
      defaultDomain: 'auto',
      domainKeywordRouting: true,
    })
    agent.bindSessionDomain('对账插桩定位这个偏差', callbacks)

    assert.deepEqual(resolutions, [])
    assert.equal(agent.getSessionDomain(), null)
  } finally {
    if (saved !== undefined) process.env.STAR_SOUL = saved
    else delete process.env.STAR_SOUL
  }
})
