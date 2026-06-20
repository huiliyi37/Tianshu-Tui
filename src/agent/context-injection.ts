
import type { OaiMessage } from '../api/oai-types.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { ContextAnchor } from '../context/types.js'
import { createContextLedger } from '../context/ledger.js'
import { AnchorRegistry } from '../context/anchor-registry.js'
import { claimProposalFromAnchor } from '../context/claims.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import { selectEvictionCandidates } from '../context/claim-budget.js'
import { extractKeywords } from './playbook.js'
import type { PlaybookStore } from './playbook-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { AdvisoryBus } from './advisory-bus.js'
import type { SessionContext } from './context.js'
import type { PromptEngine } from '../prompt/engine.js'

export interface ContextInjectionDeps {
  session: SessionContext
  promptEngine: PromptEngine
  contextWindow: number
  getSessionId: () => string | undefined
  getTranscriptPath: () => string | undefined
  getSessionMemoryState: () => import('../context/types.js').LedgerSessionMemoryState | undefined
  getMessages: () => OaiMessage[]
  getRecentToolHistory: () => ToolHistoryEntry[]
  getRepairHintTracker: () => RepairHintTracker
  getContextClaimStore: () => ContextClaimStore | undefined
  getPlaybookStore: () => PlaybookStore | undefined
  /** Project root for recall-gate evidence verification (optional). */
  getCwd?: () => string
  /** A1: unified advisory bus for corrective signal collection */
  advisoryBus?: AdvisoryBus
}

export class ContextInjectionController {
  private userAnchors: ContextAnchor[] = []
  private anchorRegistry = new AnchorRegistry(2_000)

  constructor(private deps: ContextInjectionDeps) {}

  reset(): void {
    this.userAnchors = []
  }

  addAnchor(kind: ContextAnchor['kind'], text: string): void {
    this.userAnchors.push({ kind, text, sourceRoundIndex: -1, salience: 1.0 })
    this.refreshLedger()
  }

  refreshPlaybookLessons(_userInput: string): void {
    // Playbook injection disabled — lessons are low-signal noise (14/16 entries
    // have useCount=0) and their per-turn keyword re-query causes habituation
    // tracker churn → consolidatedBlock mutation → prefix cache break.
    // Re-enable with useCount>0 + importance>=0.5 filtering when content quality improves.
  }

  recordUserInputClaims(userInput: string): void {
    const contextClaimStore = this.deps.getContextClaimStore()
    const sessionId = this.deps.getSessionId()
    if (!contextClaimStore || !sessionId) return

    const before = this.anchorRegistry.getAnchors().length
    const turn = this.deps.session.getTurnCount()
    this.anchorRegistry.processUserMessage(userInput, turn)
    const anchors = this.anchorRegistry.getAnchors().slice(before)
    const createdAt = Date.now()

    for (const anchor of anchors) {
      const proposal = claimProposalFromAnchor(anchor, {
        actor: 'user',
        sessionId,
        turn,
        eventId: `turn-${turn}:user-input`,
        createdAt,
      })
      contextClaimStore.propose(proposal)
    }
  }

  refreshActiveClaims(): void {
    const contextClaimStore = this.deps.getContextClaimStore()
    if (!contextClaimStore) {
      this.deps.promptEngine.updateActiveClaims([])
      return
    }

    contextClaimStore.promoteEligibleClaims(Date.now(), this.deps.getCwd?.())

    const toEvict = selectEvictionCandidates(contextClaimStore.listActiveClaims())
    for (const claim of toEvict) {
      contextClaimStore.updateClaimStatus(claim.id, 'stale', 'budget eviction')
    }

    this.deps.promptEngine.updateActiveClaims(contextClaimStore.listActiveClaims())
  }

  refreshRepairHint(): void {
    const hint = this.deps.getRepairHintTracker().getHint()
    // A1: route through advisory bus — suppress legacy <repair-hint> block
    // to avoid double-rendering the same content in one turn.
    this.deps.promptEngine.setRepairHint(null)
    if (hint && this.deps.advisoryBus) {
      this.deps.advisoryBus.submit({
        key: 'repair-hint',
        priority: 0.8,
        category: 'repair',
        content: hint,
      })
    }
  }

  setCerebellarHint(level: 'none' | 'hint' | 'gate' | 'escalate'): void {
    if (level !== 'none') {
      const msg = `Prediction error rate elevated (${level}). Mental model may be stale — verify assumptions before proceeding.`
      // A6: redirect cerebellar hint to A1 bus instead of dead-end promptEngine setter
      this.deps.advisoryBus?.submit({
        key: 'cerebellar',
        priority: level === 'escalate' ? 0.9 : level === 'gate' ? 0.85 : 0.7,
        category: 'cerebellar',
        content: msg,
      })
      return
    }
    // 'none' → hint cleared; advisory bus auto-expires by key on next build
  }

  clearCerebellarHint(): void {
    // Advisory bus auto-expires by key on next build; no explicit clear needed
  }

  refreshLedger(): void {
    const ledger = createContextLedger(
      this.deps.getSessionId() ?? 'session',
      this.deps.getTranscriptPath() ?? '',
      this.deps.getMessages(),
      this.deps.contextWindow,
      this.deps.getSessionMemoryState(),
      this.userAnchors,
    )
    this.deps.session.setContextLedger(ledger)
  }
}
