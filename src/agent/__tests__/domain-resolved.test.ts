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
  }, new SessionContext(), TEST_CWD)
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
  return { agent, callbacks, resolutions }
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

test('the same AgentLoop emits at most once across consecutive domain binds', () => {
  const { agent, callbacks, resolutions } = makeObservedAgent({
    defaultDomain: 'auto',
    domainKeywordRouting: true,
  })
  agent.bindSessionDomain('对账插桩定位这个偏差', callbacks)
  agent.bindSessionDomain('按计划实现用户注册', callbacks)

  assert.equal(resolutions.length, 1)
  assert.equal(resolutions[0]!.key, 'kaiyang')
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
