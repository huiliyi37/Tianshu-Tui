
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

  refreshPlaybookLessons(userInput: string): void {
    const playbookStore = this.deps.getPlaybookStore()
    if (!playbookStore) return
    const keywords = extractKeywords(`${userInput} ${this.deps.getRecentToolHistory().map(h => `${h.tool} ${h.target}`).join(' ')}`, 12)
    const lessons = playbookStore.query(keywords, 3)
    this.deps.promptEngine.updatePlaybookLessons(lessons)
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
    const activeClaims = contextClaimStore.listActiveClaims()
    const usedAt = Date.now()
    const consumerId = `turn-${this.deps.session.getTurnCount()}:prompt`
    for (const claim of activeClaims) {
      contextClaimStore.recordClaimUsed(claim.id, {
        consumerId,
        consumerKind: 'prompt',
        usedAt,
      })
    }

    const toEvict = selectEvictionCandidates(contextClaimStore.listActiveClaims())
    for (const claim of toEvict) {
      contextClaimStore.updateClaimStatus(claim.id, 'stale', 'budget eviction')
    }

    this.deps.promptEngine.updateActiveClaims(contextClaimStore.listActiveClaims())
  }

  refreshRepairHint(): void {
    this.deps.promptEngine.setRepairHint(this.deps.getRepairHintTracker().getHint())
  }

  setCerebellarHint(level: 'none' | 'hint' | 'gate' | 'escalate'): void {
    if (level !== 'none') {
      this.deps.promptEngine.setCerebellarHint(`Prediction error rate elevated (${level}). Mental model may be stale — verify assumptions before proceeding.`)
      return
    }
    this.deps.promptEngine.setCerebellarHint(null)
  }

  clearCerebellarHint(): void {
    this.deps.promptEngine.setCerebellarHint(null)
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
