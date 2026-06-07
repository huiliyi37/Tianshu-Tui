/**
 * Domain Lesson Precipitation — extract lessons from worker results (V3 Component B-write).
 *
 * Called after coordinator completes a delegation. Inspects worker result
 * evidence to extract domain-specific lessons, then deposits them into
 * DomainKnowledgeStore.
 *
 * Mirrors dream.ts distillation pattern: high-gate (only high-confidence
 * evidence), but operates per-domain rather than per-session.
 *
 * Lesson kind mapping (from spec §3.3):
 *   - defect_pattern:  failure-classifier categorized failures
 *   - invariant:       codebase constraints discovered during execution
 *   - adversarial_input: inputs that caused errors or unexpected behavior
 *   - selection_rule:  trade-off decisions and their outcomes
 *   - reframe:         perspective shifts discovered during exploration
 */

import type { WorkerResult } from './work-order.js'
import type { DomainKnowledgeStore, DomainLessonKind } from './domain-knowledge-store.js'
import { starDomainRegistry } from './star-domain-registry.js'

/** Input for precipitation */
export interface PrecipitateInput {
  domainId: string
  results: WorkerResult[]
  /** Task objective for context extraction */
  objective: string
}

// ─── Lesson extraction rules ────────────────────────────────────

interface ExtractedLesson {
  kind: DomainLessonKind
  text: string
  evidence: string
}

/** Extract lessons from a single worker result */
function extractLessonsFromResult(result: WorkerResult, objective: string): ExtractedLesson[] {
  const lessons: ExtractedLesson[] = []

  // 1. Failure patterns → defect_pattern
  if (result.status === 'failed') {
    const errMsg = result.summary ?? 'unknown failure'
    const rootCause = errMsg.split('\n')[0]?.slice(0, 150) ?? errMsg.slice(0, 150)
    lessons.push({
      kind: 'defect_pattern',
      text: `此类任务常见失败模式: ${rootCause}`,
      evidence: `objective="${objective.slice(0, 80)}" summary="${errMsg.slice(0, 100)}"`,
    })
  }

  // 2. Evidence-based invariant extraction from successful results
  if (result.status === 'passed') {
    // File read patterns → invariants about codebase structure
    if (result.examinedFiles && result.examinedFiles.length > 3) {
      const dirs = new Set(result.examinedFiles.map(f => f.split('/').slice(0, -1).join('/')))
      if (dirs.size > 0) {
        const topDir = [...dirs][0]!
        lessons.push({
          kind: 'invariant',
          text: `相关代码集中在 ${topDir}/ 目录`,
          evidence: `files=${result.examinedFiles.slice(0, 5).join(',')}`,
        })
      }
    }

    // Verification patterns → invariants about test expectations
    if (result.verification) {
      const cmd = result.verification.command
      lessons.push({
        kind: 'invariant',
        text: `验证命令: ${cmd.slice(0, 120)}`,
        evidence: `command=${cmd}`,
      })
    }

    // File modification patterns → structural invariants
    if (result.changedFiles.length > 0) {
      const exts = new Set(result.changedFiles.map(f => {
        const parts = f.split('.')
        return parts.length > 1 ? `.${parts[parts.length - 1]}` : ''
      }))
      if (exts.size > 0) {
        lessons.push({
          kind: 'invariant',
          text: `修改涉及 ${[...exts].join(', ')} 文件`,
          evidence: `files=${result.changedFiles.slice(0, 5).join(',')}`,
        })
      }
    }
  }

  // 3. Blocked results → adversarial_input or selection_rule
  if (result.status === 'blocked') {
    const errMsg = result.summary
    if (errMsg.includes('scope') || errMsg.includes('outside') || errMsg.includes('missing')) {
      lessons.push({
        kind: 'adversarial_input',
        text: `scope 限制触发: ${errMsg.split('\n')[0]?.slice(0, 120) ?? errMsg.slice(0, 120)}`,
        evidence: `objective="${objective.slice(0, 80)}"`,
      })
    }
  }

  return lessons
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Precipitate domain lessons from worker results.
 *
 * Extracts structured lessons from result evidence and deposits them
 * into the domain knowledge store. Non-blocking (deposits are debounced).
 *
 * @returns number of lessons deposited
 */
export function precipitateDomainLessons(
  store: DomainKnowledgeStore,
  input: PrecipitateInput,
): number {
  // Validate domain exists in registry
  if (!starDomainRegistry.has(input.domainId)) return 0

  let count = 0
  for (const result of input.results) {
    const lessons = extractLessonsFromResult(result, input.objective)
    for (const lesson of lessons) {
      store.deposit({
        domainId: input.domainId,
        kind: lesson.kind,
        text: lesson.text,
        evidence: lesson.evidence,
      })
      count++
    }
  }
  return count
}
