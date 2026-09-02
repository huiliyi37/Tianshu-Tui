import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  memoryBackfillEnabled, collectBackfillCandidates, runMemoryBackfill,
  loadBackfillLedger, type BackfillLedger,
} from '../backfill.js'
import { readMemoryEntries } from '../unified-memory.js'

let cwd: string
let sessionDir: string
const HOUR = 3_600_000

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'rivet-backfill-'))
  mkdirSync(join(cwd, '.rivet', 'knowledge'), { recursive: true })
  sessionDir = join(cwd, 'sessions')
  mkdirSync(sessionDir)
  return () => rmSync(cwd, { recursive: true, force: true })
})

function seedSession(id: string, ageHours: number, transcript = 'x'.repeat(300)): string {
  const path = join(sessionDir, `${id}.jsonl`)
  writeFileSync(path, transcript)
  const at = new Date(Date.now() - ageHours * HOUR)
  utimesSync(path, at, at)
  return path
}

const fakeTranscript = [
  JSON.stringify({ role: 'user', content: '帮我把构建脚本的输出目录改成 dist2' }),
  JSON.stringify({ role: 'assistant', content: '已改 package.json 与 tsup 配置，构建验证通过' }),
].join('\n')

describe('memory backfill', () => {
  it('is opt-in (default off)', () => {
    assert.equal(memoryBackfillEnabled(undefined), false)
    assert.equal(memoryBackfillEnabled('1'), true)
    assert.equal(memoryBackfillEnabled('on'), true)
    assert.equal(memoryBackfillEnabled('0'), false)
  })

  it('selects idle non-worker sessions and respects ledger exclusions', () => {
    seedSession('active', 0.5)          // 闲置 <1h → 跳过（可能自己会巩固）
    seedSession('done-before', 2)       // ledger 已 done → 跳过
    seedSession('worker-batch-0-x', 2)  // worker 派生 → 跳过
    seedSession('too-old', 24 * 20)     // >14 天 → staleIds 永久跳过
    seedSession('fresh', 2)
    seedSession('current-session', 2)

    const ledger: BackfillLedger = { version: 1, sessions: { 'done-before': { status: 'done', at: 1 } } }
    const { candidates, staleIds } = collectBackfillCandidates(sessionDir, 'current-session', ledger)
    assert.deepEqual(candidates.map(c => c.sessionId), ['fresh'])
    assert.deepEqual(staleIds, ['too-old'])
  })

  it('consolidates via side-path LLM, writes source=backfill, ledger idempotent', async () => {
    seedSession('sess-old', 2, fakeTranscript)
    const calls: string[] = []
    const complete = async (prompt: string) => {
      calls.push(prompt)
      return JSON.stringify({
        summary: '会话把构建输出目录从 dist 改为 dist2，同步更新了 tsup 配置并通过构建验证。',
        procedures: [{ name: '改构建输出目录', whenToUse: '需要调整产物目录时', steps: ['改 package.json', '跑构建验证'] }],
      })
    }
    const first = await runMemoryBackfill({
      cwd, sessionDir, currentSessionId: 'current',
      complete,
      readTranscript: () => [
        { role: 'user', content: '帮我把构建脚本的输出目录改成 dist2，现在的目录结构太乱了，顺带把 tsup 的配置也一起调整一下，确保构建产物能正确生成。' },
        { role: 'assistant', content: '已改 package.json 与 tsup 配置，输出目录从 dist 迁到 dist2，构建验证通过，产物清单核对无误，可以继续后续部署流程。' },
        { role: 'user', content: '另外把 .gitignore 里的旧 dist 目录条目清掉，免得新目录被意外忽略，再把 README 里的构建说明同步更新一下。' },
        { role: 'assistant', content: '已同步更新 .gitignore 与 README 构建说明段落，旧的 dist 条目已移除，新目录 dist2 的说明与示例命令都核对过了。' },
      ],
    })
    assert.equal(first.processed, 1)
    assert.equal(calls.length, 1)
    const entries = readMemoryEntries(cwd)
    assert.ok(entries.length >= 2)
    assert.ok(entries.every(e => e.source === 'backfill'))
    assert.ok(entries.some(e => e.topic === 'session-summary'))
    assert.ok(entries.some(e => e.topic === 'procedure' && e.sessionId === 'sess-old'))
    assert.equal(loadBackfillLedger(cwd).sessions['sess-old']?.status, 'done')

    // 第二轮：ledger done → 零调用、零写入（幂等）。
    const second = await runMemoryBackfill({
      cwd, sessionDir, currentSessionId: 'current', complete,
      readTranscript: () => [{ role: 'user', content: 'x' }],
    })
    assert.equal(second.processed, 0)
    assert.equal(calls.length, 1)
  })

  it('fail-closed: LLM failure records attempts, never writes', async () => {
    seedSession('sess-flaky', 2, fakeTranscript)
    const complete = async () => { throw new Error('llm unavailable') }
    for (let i = 0; i < 3; i++) {
      await runMemoryBackfill({
        cwd, sessionDir, currentSessionId: 'current', complete,
        readTranscript: () => [{ role: 'user', content: 'x'.repeat(250) }],
      })
    }
    assert.equal(readMemoryEntries(cwd).length, 0)
    const rec = loadBackfillLedger(cwd).sessions['sess-flaky']
    assert.equal(rec?.status, 'error')
    assert.equal(rec?.attempts, 3)
    // 超过重试上限后不再入选。
    const { candidates } = collectBackfillCandidates(sessionDir, 'current', loadBackfillLedger(cwd))
    assert.deepEqual(candidates, [])
  })

  it('skips too-short transcripts permanently', async () => {
    seedSession('sess-tiny', 2, 'short')
    const result = await runMemoryBackfill({
      cwd, sessionDir, currentSessionId: 'current',
      complete: async () => { throw new Error('should not be called') },
      readTranscript: () => [{ role: 'user', content: 'hi' }],
    })
    assert.equal(result.processed, 0)
    assert.equal(loadBackfillLedger(cwd).sessions['sess-tiny']?.status, 'skipped')
  })
})
