import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Self-recognition — does this cwd reach 天枢's own body, or the world's project?
 *
 * 天枢 is a terminal coding agent. Most of the time he stands in a developer's
 * repo (the world): there the project is correctly external, and he serves as a
 * guest carrying his own self (emissary form). Only when he stands in his own
 * source — his body — is the cwd himself (home / self-evolution form).
 *
 * Selfhood is DECLARED, not guessed: the `.rivet/SELF` marker exists only in
 * 天枢's true source. Absent it, cwd is the world. This keeps production — where
 * developers never have the marker — always 'world', and makes self-evolution a
 * privileged mode that activates only on the real body.
 *
 * Pure + session-constant: the result is stable for a given cwd within a session,
 * so it is safe to render into the FROZEN volatile prefix (prefix-cache safe —
 * same class as rivetMd; never a per-turn value).
 */
export type CwdRelation = 'self' | 'world'

/** The marker that declares a directory to be 天枢's own body. */
export const SELF_MARKER_PATH = ['.rivet', 'SELF'] as const

export function detectCwdRelation(cwd: string): CwdRelation {
  try {
    return existsSync(join(cwd, ...SELF_MARKER_PATH)) ? 'self' : 'world'
  } catch {
    // Filesystem unreachable / permission denied → treat as world (guest).
    // Fail toward 'world': never claim a directory as self without proof.
    return 'world'
  }
}
