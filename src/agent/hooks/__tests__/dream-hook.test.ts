/**
 * Dream-hook 契约测试（Wave 5 反馈闭环——dream 并入 essence-gate）。
 *
 * 钉死两条曾经断线的通路：
 * 1. 回调分支：候选以 origin='dream' 同步推送（essence-gate 是同批 postSession
 *    的后序 hook），且 project-memory.md 叙事层照常写入、jsonl 不直写。
 * 2. create-runtime-hooks 只在 essenceGate 真实装配时转发回调——gate 缺席时
 *    dream 保留直写，缓冲不积压无消费者的候选。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDreamHook } from '../dream-hook.js'
import { createDefaultRuntimeHooks } from '../../create-runtime-hooks.js'
import type { EvidenceState } from '../../evidence.js'
import type { KnowledgeCandidate } from '../../../memory/essence-gate.js'

const DECISION = 'Architectural invariant: prompt prefix must remain byte-stable across session turns'

function evidenceWithFiles(count: number): EvidenceState {
  return {
    filesRead: new Set(),
    filesModified: new Set(Array.from({ length: count }, (_, i) => `file-${i}.ts`)),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
  }
}

/** setImmediate 队列排空（dream 的 .md 写入在 setImmediate 内）。 */
function flushImmediates(): Promise<void> {
  return new Promise(resolve => setImmediate(() => setImmediate(resolve)))
}

describe('dream-hook', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-dream-hook-'))
  })

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('gate branch: pushes origin=dream candidates synchronously and keeps .md narrative', async () => {
    const received: KnowledgeCandidate[] = []
    const hook = createDreamHook({
      cwd,
      sessionId: 'sess-dream-1',
      getEvidenceState: () => evidenceWithFiles(3),
      getDecisions: () => [DECISION],
      getTrajectory: () => [],
      onKnowledgeCandidates: candidates => received.push(...candidates),
    })

    await hook.run({} as never)

    // 候选同步到达（essence-gate 作为后序 postSession hook 必须能立刻消费）
    assert.equal(received.length, 1)
    assert.equal(received[0]!.origin, 'dream')
    assert.ok(received[0]!.tags?.includes('dream'))
    assert.ok(received[0]!.text.includes('byte-stable'))

    await flushImmediates()

    // .md 叙事层照常沉淀
    const mdPath = join(cwd, '.rivet', 'knowledge', 'project-memory.md')
    assert.ok(existsSync(mdPath), 'project-memory.md narrative must still be written')
    assert.ok(readFileSync(mdPath, 'utf-8').includes('byte-stable'))

    // jsonl 不直写——候选统一由 gate 裁决后入库
    const jsonlPath = join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
    assert.ok(!existsSync(jsonlPath), 'dream must not bypass the gate into memory.jsonl')
  })

  it('direct-write branch: without callback persistDream writes both .md and jsonl', async () => {
    const hook = createDreamHook({
      cwd,
      sessionId: 'sess-dream-2',
      getEvidenceState: () => evidenceWithFiles(3),
      getDecisions: () => [DECISION],
      getTrajectory: () => [],
    })

    await hook.run({} as never)
    await flushImmediates()

    assert.ok(existsSync(join(cwd, '.rivet', 'knowledge', 'project-memory.md')))
    const jsonl = readFileSync(join(cwd, '.rivet', 'knowledge', 'memory.jsonl'), 'utf-8')
    assert.ok(jsonl.includes('byte-stable'), 'gate-less sessions keep the direct jsonl channel')
  })

  it('create-runtime-hooks forwards the callback only when essence-gate is assembled', async () => {
    const baseDeps = {
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => evidenceWithFiles(3),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
    }
    const dreamDeps = (buffer: KnowledgeCandidate[]) => ({
      cwd,
      sessionId: 'sess-dream-3',
      getDecisions: () => [DECISION],
      getTrajectory: () => [],
      onKnowledgeCandidates: (candidates: KnowledgeCandidate[]) => buffer.push(...candidates),
    })

    // gate 缺席：回调不转发 → 直写分支，缓冲为空
    const withoutGate: KnowledgeCandidate[] = []
    const hooksNoGate = createDefaultRuntimeHooks({ ...baseDeps, dream: dreamDeps(withoutGate) })
    const noGateHook = hooksNoGate.find(h => h.name === 'dream-distill')!
    await (noGateHook.run as (ctx: unknown) => Promise<void> | void)({})
    await flushImmediates()
    assert.equal(withoutGate.length, 0, 'no gate = no consumer, dream keeps direct write')

    // gate 装配：回调转发 → 候选进缓冲
    rmSync(join(cwd, '.rivet'), { recursive: true, force: true })
    const withGate: KnowledgeCandidate[] = []
    const hooksWithGate = createDefaultRuntimeHooks({
      ...baseDeps,
      dream: dreamDeps(withGate),
      essenceGate: {
        cwd,
        getCandidates: () => [],
        complete: async () => '[]',
      },
    })
    const withGateHook = hooksWithGate.find(h => h.name === 'dream-distill')!
    await (withGateHook.run as (ctx: unknown) => Promise<void> | void)({})
    await flushImmediates()
    assert.equal(withGate.length, 1, 'assembled gate must receive dream candidates')
    assert.equal(withGate[0]!.origin, 'dream')
  })
})
