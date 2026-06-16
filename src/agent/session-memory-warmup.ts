import { type P3Integration } from './p3-integration.js'
import { type ImmuneHook } from './immune-hook.js'
import { type PhysarumEngine } from '../repo/physarum-engine.js'
import { type MeridianDb } from '../repo/meridian-db.js'
import { debugLog } from '../utils/debug.js'

/**
 * Dependencies for {@link loadSessionMemories}. The idempotency guard
 * (memoriesWarmed) and the `db` null-check stay on AgentLoop; this function
 * owns only the cross-session DB-loading body (extracted W-L7a).
 */
export interface SessionMemoryWarmupDeps {
  db: MeridianDb
  physarum: PhysarumEngine | undefined
  immuneHook: ImmuneHook
  p3: P3Integration
}

/**
 * Load cross-session learning state off the construction path (S9): physarum
 * edges, immune memories, mistake notebook, tool-pattern miner snapshot, and
 * the reasoning-effort / model-style / plan-cache bandit states. Each restore
 * is independently guarded — a corrupt blob must not abort the rest.
 */
export function loadSessionMemories(deps: SessionMemoryWarmupDeps): void {
  const { db, physarum, immuneHook, p3 } = deps
  physarum?.loadFromDb()
  const physarumLoadStats = physarum?.getLastLoadStats()
  if (physarumLoadStats && physarumLoadStats.discarded > 0) {
    physarum?.cleanupPersistedEdges()
    debugLog(`[physarum] filtered ${physarumLoadStats.discarded} polluted persisted edges; loaded=${physarumLoadStats.loaded}; samples=${JSON.stringify(physarumLoadStats.discardedSamples)}`)
  }
  try { immuneHook.importMemories(db.loadImmuneMemories()) } catch { /* non-critical */ }
  try { p3?.notebook.importEntries(db.loadMistakeEntries()) } catch { /* non-critical */ }
  try {
    const snapshot = db.loadToolPatternMinerSnapshot()
    if (snapshot) p3.miner.importSnapshot(snapshot)
  } catch { /* non-critical */ }
  // T2-02 P1: Restore bandit states from MeridianDb (cross-session learning).
  // effortBandit / bandit are readonly on P3Integration, so we restore them
  // in place via importState rather than reassigning the references.
  try {
    const effortBanditJson = db.loadBanditState('bandit:reasoning_effort')
    if (effortBanditJson) p3.effortBandit.importState(effortBanditJson)
    const modelBanditJson = db.loadBanditState('bandit:model_style')
    if (modelBanditJson) p3.bandit.importState(modelBanditJson)
  } catch { /* non-critical */ }
  // Track B1: Restore PlanCache from MeridianDb
  try {
    const planCacheJson = db.loadBanditState('p3:plan_cache')
    if (planCacheJson) p3.importPlanCache(planCacheJson)
  } catch { /* non-critical */ }
}
