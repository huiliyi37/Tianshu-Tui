/**
 * Void identity — the mark an agent leaves on the constellation.
 *
 * Each session gets an ephemeral numericId, but the *symbol* and *signature*
 * are derived deterministically from the agent's behavior fingerprint
 * (RetrospectFingerprint). Two sessions whose behavior fingerprints are similar
 * resolve to the same symbol — 同气相求 — letting the starmap recognise a
 * returning "kindred" agent without any new persistence mechanism.
 *
 * Recognition reuses fingerprintSimilarity + SessionRegistry.loadFingerprints;
 * nothing here is injected into the system prompt (cache-safe by construction).
 */
import { createHash, randomInt as cryptoRandomInt } from 'node:crypto'
import {
  fingerprintSimilarity,
  type RetrospectFingerprint,
} from './retrospect-fingerprint.js'
import type { AgentMark } from '../constellation/schema.js'

/** Curated terminal-safe glyph set; index chosen deterministically. */
export const VOID_GLYPHS: readonly string[] = [
  '✦', '✧', '✶', '✷', '✸', '✺', '❂', '❉',
  '◈', '◇', '⟡', '⌬', '⚘', '⚙', '⊕', '↻',
]

export interface VoidIdentity {
  /** Per-session ephemeral id (1000–9999). */
  numericId: number
  /** Deterministic symbol from the signature. */
  symbol: string
  /** Stable behavior-fingerprint hash. */
  signature: string
  /** Active star domain (optional at mint time). */
  domain?: string
  /** Render-ready name, e.g. "辅·#7281·⚘". */
  displayName: string
}

/** Canonical, order-independent hash of a behavior fingerprint. */
export function signatureOf(fp: RetrospectFingerprint): string {
  const canonical = JSON.stringify({
    root: [...fp.rootCauseKeywords].map(s => s.toLowerCase()).sort(),
    reco: [...fp.recommendationKeywords].map(s => s.toLowerCase()).sort(),
    stab: fp.stabilityTrend,
    conf: fp.confidenceTrend,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

/** Deterministically pick a glyph from a signature/seed string. */
export function symbolForSignature(signature: string): string {
  const seed = signature.slice(0, 8) || '0'
  const n = parseInt(seed, 16)
  const idx = Number.isFinite(n) ? n % VOID_GLYPHS.length : 0
  return VOID_GLYPHS[idx]!
}

function composeDisplayName(domain: string | undefined, numericId: number, symbol: string): string {
  return domain ? `${domain}·#${numericId}·${symbol}` : `#${numericId}·${symbol}`
}

/**
 * Mint a void identity for a session. The numericId is random (injectable for
 * tests); the signature/symbol are deterministic given the fingerprint, or fall
 * back to a session-derived seed when no fingerprint exists yet.
 */
export function generateVoidIdentity(input: {
  sessionId: string
  fingerprint?: RetrospectFingerprint | null
  domain?: string
  randomInt?: () => number
}): VoidIdentity {
  const numericId = input.randomInt ? input.randomInt() : cryptoRandomInt(1000, 10000)
  const signature = input.fingerprint
    ? signatureOf(input.fingerprint)
    : createHash('sha256').update(input.sessionId).digest('hex').slice(0, 12)
  const symbol = symbolForSignature(signature)
  return {
    numericId,
    symbol,
    signature,
    domain: input.domain,
    displayName: composeDisplayName(input.domain, numericId, symbol),
  }
}

/** Convert a void identity into the persisted AgentMark stamped on milestones. */
export function toAgentMark(identity: VoidIdentity, domain: string): AgentMark {
  return {
    numericId: identity.numericId,
    symbol: identity.symbol,
    domain,
    signature: identity.signature,
  }
}

export interface KinMatch {
  fingerprint: RetrospectFingerprint
  similarity: number
}

/**
 * Find the most similar historical fingerprint above `threshold` — the
 * returning "kindred" agent. Returns null when nothing crosses the bar.
 */
export function recognizeKin(
  current: RetrospectFingerprint,
  historical: readonly RetrospectFingerprint[],
  threshold = 0.5,
): KinMatch | null {
  let best: KinMatch | null = null
  for (const fp of historical) {
    if (fp.sessionId === current.sessionId) continue
    const similarity = fingerprintSimilarity(current, fp)
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { fingerprint: fp, similarity }
    }
  }
  return best
}
