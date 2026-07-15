import type { EvidenceState } from '../evidence.js'
import { persistDream, persistDreamNarrative, cleanupProjectMemory } from '../dream.js'
import { extractCuratedMemoryCandidates } from '../dream.js'
import type { TrajectoryEntry as DreamTrajectoryEntry } from '../dream.js'
import type { TrajectoryEntry } from '../trajectory.js'
import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { FailureJournal } from '../failure-journal.js'
import { distillFromFailures } from '../playbook.js'
import type { PlaybookStore } from '../playbook-store.js'
import type { KnowledgeCandidate } from '../../memory/essence-gate.js'

export interface DreamHookDeps {
  cwd: string
  sessionId: string
  getEvidenceState: () => EvidenceState
  getDecisions: () => string[]
  getTrajectory: () => TrajectoryEntry[]
  getFailureJournal?: () => FailureJournal
  getPlaybookStore?: () => PlaybookStore | undefined
  /**
   * Wave 5（反馈闭环）：dream 蒸馏候选交 essence-gate 统一裁决。
   * 回调存在时跳过 appendProjectMemory 直写——dream 候选经 gate 准入判定后
   * 才进入知识库；project-memory.md 叙事层与 cleanupProjectMemory 保持不变。
   * 回调缺省时保留现状直写（gate 未装配的会话不丢 dream 通道）。
   */
  onKnowledgeCandidates?: (candidates: KnowledgeCandidate[]) => void
}

function toDreamTrajectoryEntry(entry: TrajectoryEntry): DreamTrajectoryEntry {
  return {
    tool: entry.tool,
    target: entry.target,
    status: entry.status.startsWith('retried') || entry.status === 'success' ? 'success' : 'failed',
    error: entry.errorClass,
  }
}

export function createDreamHook(deps: DreamHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'dream-distill',
    run() {
      // Experience distillation runs unconditionally — short sessions with
      // failures should still sediment diagnostic patterns into playbook.
      const journal = deps.getFailureJournal?.()
      const store = deps.getPlaybookStore?.()
      if (journal && store) {
        const entries = journal.getEntries()
        if (entries.length > 0) {
          const patterns = journal.detectPatterns()
          const bullets = distillFromFailures(entries, patterns)
          if (bullets.length > 0) {
            store.addBullets(bullets)
          }
        }
      }

      const evidenceState = deps.getEvidenceState()
      const hasPassedTests = evidenceState.verifications.some(v => v.status === 'passed')
      const hasEnoughFiles = evidenceState.filesModified.size >= 3
      if (!hasPassedTests && !hasEnoughFiles) return

      const cwd = deps.cwd
      const input = {
        filesModified: [...evidenceState.filesModified],
        filesRead: [...evidenceState.filesRead],
        verifications: evidenceState.verifications,
        decisions: deps.getDecisions(),
        trajectoryEntries: deps.getTrajectory().map(toDreamTrajectoryEntry),
        sessionId: deps.sessionId,
      }

      // Wave 5（反馈闭环）：gate 装配时 dream 候选汇入 essence-gate 统一裁决。
      // 候选推送必须同步完成——essence-gate 是同批 postSession 的后序 hook，
      // setImmediate 里推会错过本次 gate 运行。
      if (deps.onKnowledgeCandidates) {
        const dreamCandidates = extractCuratedMemoryCandidates(input.decisions)
        if (dreamCandidates.length > 0) {
          deps.onKnowledgeCandidates(dreamCandidates.map(c => ({
            text: c.claim,
            kind: c.criterion,
            confidence: 0.7,
            origin: 'dream' as const,
            tags: ['dream'],
            sessionId: deps.sessionId,
          })))
        }
        // .md 叙事层照常沉淀（与 gate 的 jsonl 通路解耦）；jsonl 直写被 gate 取代
        setImmediate(() => {
          cleanupProjectMemory(cwd)
          persistDreamNarrative(cwd, input)
        })
        return
      }

      // 回调缺省：保留现状直写（gate 未装配的会话不丢 dream 通道）
      setImmediate(() => {
        cleanupProjectMemory(cwd)
        persistDream(cwd, input)
      })
    },
  }
}
