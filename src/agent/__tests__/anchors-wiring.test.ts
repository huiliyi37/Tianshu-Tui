import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { maybeExtractAnchors } from '../loop-factory.js'
import { proRegistry } from '../../api/pro-registry.js'
import type { ContentBlock } from '../../api/types.js'

/**
 * 锚点写入侧接线集成测试（spec 3c 动作 B · 缺口 2 验证）：
 * extractor 注册 → maybeExtractAnchors → engine.getExcludedPathAnchorCount 增长
 * 的完整行为链。触发点（loop-factory addAssistantBlocks 包装）由
 * loop-factory.ts:1103 的一行包装保证，此处测行为链。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-anchors-wiring-'))

function makeAgent(providerName: string): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-flash',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: {
      stream: async () => { throw new Error('not used') },
    } as never,
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    providerName,
  }, session, TEST_CWD)
}

const thinkingBlocks: ContentBlock[] = [
  { type: 'thinking', thinking: '可能是A，但A不是最优。排除B路径。选C。' },
  { type: 'text', text: '选C' },
]

describe('锚点写入侧接线（extractor 注册 → 提取 → engine 追加）', () => {
  it('spark provider + extractor 注册：thinking block 触发锚点提取', () => {
    const agent = makeAgent('deepseek-spark')
    const fakeExtractor = (reasoning: string) =>
      reasoning.includes('不是') ? ['已排除：A 不是最优', '已排除：B 路径'] : []
    proRegistry.registerAnchorExtractor('deepseek-spark', fakeExtractor)
    try {
      assert.equal(agent.config.promptEngine.getExcludedPathAnchorCount(), 0, '初始无锚点')
      maybeExtractAnchors(agent, thinkingBlocks)
      assert.equal(agent.config.promptEngine.getExcludedPathAnchorCount(), 2,
        '排除句应提取为 2 条锚点')
    } finally {
      proRegistry.registerAnchorExtractor('deepseek-spark', () => [])
    }
  })

  it('非 spark / extractor 未注册：零行为差异（开源无感）', () => {
    const agent = makeAgent('deepseek') // 非 spark：注册表查不到 extractor
    maybeExtractAnchors(agent, thinkingBlocks)
    assert.equal(agent.config.promptEngine.getExcludedPathAnchorCount(), 0,
      '非 spark 不得提取锚点')
  })

  it('无 thinking block：不提取', () => {
    const agent = makeAgent('deepseek-spark')
    const fakeExtractor = () => ['x']
    proRegistry.registerAnchorExtractor('deepseek-spark', fakeExtractor)
    try {
      maybeExtractAnchors(agent, [{ type: 'text', text: '只有文本' }])
      assert.equal(agent.config.promptEngine.getExcludedPathAnchorCount(), 0,
        '无推理块不提取')
    } finally {
      proRegistry.registerAnchorExtractor('deepseek-spark', () => [])
    }
  })

  it('去重：重复提取同一锚点不重复追加', () => {
    const agent = makeAgent('deepseek-spark')
    const fakeExtractor = () => ['锚点X']
    proRegistry.registerAnchorExtractor('deepseek-spark', fakeExtractor)
    try {
      maybeExtractAnchors(agent, thinkingBlocks)
      maybeExtractAnchors(agent, thinkingBlocks)
      assert.equal(agent.config.promptEngine.getExcludedPathAnchorCount(), 1,
        'appendExcludedPathAnchors 去重——同锚点只入一次')
    } finally {
      proRegistry.registerAnchorExtractor('deepseek-spark', () => [])
    }
  })
})
