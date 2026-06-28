/**
 * TDD Gate — pure decision function for test-first enforcement.
 *
 * Consumed by the tool-pipeline layer before edit/write tools execute.
 * The agent loop itself never imports this — it only sees the
 * `{ block: true, reason }` that tool-pipeline returns as an error.
 *
 * Three levels, driven by {@link TddGateState}:
 * - **L0 allow** — no files modified, or verification already happened.
 * - **L1 suggest** — edits without verification, but under the block threshold.
 * - **L2 block** — edits without verification at/over the threshold (enforce mode).
 *
 * Ported from oh-my-pi (Claude Code) Phase 7 TDD gate. Our tool names differ
 * (edit_file/write_file vs edit/write), but the decision logic is identical.
 */

import type { TddGateState } from './evidence.js'
import type { ImmuneContextHint } from './immune-context.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TddGateConfig {
  /** Master switch. When false, the gate never blocks or suggests. */
  enabled: boolean
  /**
   * `"suggest"` — only emit aside advice; never block.
   * `"enforce"` — block edits once the threshold is reached.
   */
  mode: 'suggest' | 'enforce'
  /**
   * Number of edits-without-tests after which the gate hard-blocks (in enforce
   * mode). The real-world data from oh-my-pi shows models will run 10+ edits
   * without ever testing — a threshold of 3 stops the streak at the 3rd edit
   * while leaving a 2-edit exploration window.
   */
  threshold: number
}

export interface TddGateDecision {
  action: 'allow' | 'suggest' | 'block'
  /** Present for suggest/block; human-readable guidance the model can act on. */
  message?: string
}

// ---------------------------------------------------------------------------
// Edit tool set
// ---------------------------------------------------------------------------

/** Tools that modify files — consumed by the gate to decide intervention. */
export const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'hash_edit'])

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default config: enabled, enforce, block after 3 consecutive unverified edits. */
export const DEFAULT_TDD_GATE_CONFIG: TddGateConfig = {
  enabled: true,
  mode: 'enforce',
  threshold: 3,
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const BLOCK_MESSAGE = (edits: number) =>
  `TDD Gate: ${edits} edits without a test run. Write a failing test first (run_tests should fail = RED), then edit. Run your test command to clear this gate.`

const SUGGEST_MESSAGE = (edits: number) =>
  `TDD discipline: ${edits} edit(s) made, 0 verifications. Consider running tests before more edits.`

const SUGGEST_FAILED_MESSAGE = (count: number) =>
  `TDD discipline: ${count} verification(s) failed. Fix the failing tests before continuing to edit.`

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

/**
 * Decide whether a tool call should be allowed, suggested-against, or blocked.
 *
 * Pure: no I/O, no state, no side effects. The caller owns the EvidenceTracker
 * and passes a snapshot via `gateState`.
 *
 * @param gateState  Snapshot from `EvidenceTracker.getGateState()`.
 * @param toolName   Name of the tool about to execute (e.g. "edit_file", "bash").
 * @param config     Gate config (typically from env RIVET_TDD_GATE).
 */
export function evaluateTddGate(
  gateState: TddGateState,
  toolName: string,
  config: TddGateConfig,
): TddGateDecision {
  // Gate disabled entirely → never intervene.
  if (!config.enabled) return { action: 'allow' }

  // The gate only governs edit/write tools. Reads, bash, search, etc. pass through.
  if (!EDIT_TOOLS.has(toolName)) return { action: 'allow' }

  // No files modified yet → nothing to verify, let the first edit through cleanly.
  if (gateState.filesModified === 0) return { action: 'allow' }

  // Already verified (at least one test run) → the model is iterating with tests.
  if (gateState.verifications > 0) {
    // But if tests are failing, nudge toward fixing them rather than piling on edits.
    if (gateState.hasFailedTests) {
      return { action: 'suggest', message: SUGGEST_FAILED_MESSAGE(gateState.verifications) }
    }
    return { action: 'allow' }
  }

  // From here: files modified, zero verifications, and this is an edit tool.
  // Apply the graduated threshold.
  if (gateState.editsSinceLastTest >= config.threshold) {
    // suggest mode never blocks — it only advises.
    if (config.mode === 'suggest') {
      return { action: 'suggest', message: SUGGEST_MESSAGE(gateState.editsSinceLastTest) }
    }
    return { action: 'block', message: BLOCK_MESSAGE(gateState.editsSinceLastTest) }
  }

  // Under threshold: advise but don't block (the 2-edit exploration window).
  return { action: 'suggest', message: SUGGEST_MESSAGE(gateState.editsSinceLastTest) }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Parse the TDD gate config from the `RIVET_TDD_GATE` env var.
 *
 * Called once at session construction; the result is held for the session
 * lifetime. Unset → default (enforce). Unknown values → default (enforce).
 */
export function parseTddGateConfig(): TddGateConfig {
  const raw = (process.env.RIVET_TDD_GATE ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled') {
    return { ...DEFAULT_TDD_GATE_CONFIG, enabled: false }
  }
  if (raw === 'suggest' || raw === 'advisory') {
    return { ...DEFAULT_TDD_GATE_CONFIG, mode: 'suggest' }
  }
  // "enforce", "on", "1", "true", or unset → enforce (the default).
  return { ...DEFAULT_TDD_GATE_CONFIG, mode: 'enforce' }
}

// ---------------------------------------------------------------------------
// High-level contract-aware gate (used by turn-step-producer)
// ---------------------------------------------------------------------------

export interface TddGateInput {
  filesRead: Set<string>
  filesModified: Set<string>
  isActionable: boolean
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\./i.test(path) || /[\\/]__tests__[\\/]/i.test(path)
}

/**
 * Check whether the agent is entering an executing phase without having touched
 * a test file. Returns an immune-style hint when a TDD violation is detected.
 */
export function checkTddGate(input: TddGateInput): ImmuneContextHint | null {
  if (!input.isActionable) return null
  if (input.filesModified.size === 0) return null
  if ([...input.filesRead].some(isTestFile)) return null
  return {
    level: 'warning',
    signalKinds: ['tdd_violation'],
    matchedMistakes: [],
    suggestion: 'No test file touched yet. Write tests before implementation.',
  }
}

/**
 * Build a TDD gate hint for the immune → cognitive projection channel.
 *
 * Queries {@link TddGateState} (from EvidenceTracker.getGateState()) and
 * produces an immune hint when edits are accumulating without verification.
 * Pure: no I/O, no state, no side effects.
 *
 * Called from turn-step-producer at turn boundaries; the hint flows through
 * formatImmuneContext → buildCognitiveProjectionParts → promptEngine, appearing
 * as an <immune-signal> block in the next provider request.
 *
 * Complements {@link checkTddGate}: checkTddGate checks "has the agent read
 * any test file?"; this checks "is the agent editing without running tests?"
 * Both produce `tdd_violation` hints via the same immune channel.
 *
 * @returns hint when edits > 0 and verifications === 0, or tests are failing;
 *          null when the gate is disabled or everything is fine.
 */
export function buildTddGateHint(
  state: TddGateState,
  config: TddGateConfig,
): ImmuneContextHint | null {
  if (!config.enabled) return null
  if (state.filesModified === 0) return null

  // Zero verifications: edits accumulating without any test run.
  if (state.verifications === 0 && state.editsSinceLastTest > 0) {
    return {
      level: 'warning',
      signalKinds: ['tdd_violation'],
      matchedMistakes: [],
      suggestion: `${state.editsSinceLastTest} edit(s) without a test run. TDD discipline: run tests (run_tests) before more edits — the test should fail first (RED), then pass after implementation (GREEN).`,
    }
  }

  // Tests were run but failed: nudge to fix before piling on more edits.
  if (state.hasFailedTests) {
    return {
      level: 'warning',
      signalKinds: ['tdd_violation'],
      matchedMistakes: [],
      suggestion: `${state.verifications} verification(s) recorded with failures. Fix the failing tests before continuing to edit.`,
    }
  }

  return null
}
