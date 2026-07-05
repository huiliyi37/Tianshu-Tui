/**
 * verify-declaration.ts — A3/A4: generate the project's machine-readable
 * verify declaration from the A0 fingerprint, single-sourced config → md.
 *
 * Authoritative source: `verify` block in `<cwd>/.rivet-config.json`.
 * `.rivet.md`'s Stack section is RENDERED from the same fingerprint/declaration
 * (one direction only) so the human-readable text can't silently drift from
 * what the gates actually run. Hand-edits to .rivet-config.json win: existing
 * verify keys are never overwritten, only missing ones are filled.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectProjectFingerprint, fingerprintToVerifyConfig, type ProjectFingerprint } from '../repo/project-fingerprint.js'
import { invalidateVerifyConfig } from '../config/verify-config.js'
import type { VerifyConfig } from '../config/schema.js'

export interface VerifyDeclarationResult {
  fingerprint: ProjectFingerprint
  /** Effective verify block after merge (existing keys + fingerprint fill). */
  verify: VerifyConfig
  /** True when .rivet-config.json was created or its verify block changed. */
  wrote: boolean
  /** Keys newly filled from the fingerprint (empty when everything was declared). */
  filledKeys: string[]
}

const CONFIG_FILE = '.rivet-config.json'

/**
 * Ensure `<cwd>/.rivet-config.json` carries a verify declaration derived from
 * the project fingerprint. Never overwrites existing keys; never writes when
 * the fingerprint found nothing (unknown project → no file churn).
 */
export function ensureVerifyDeclaration(cwd: string): VerifyDeclarationResult {
  const fingerprint = detectProjectFingerprint(cwd)
  const detected = fingerprintToVerifyConfig(fingerprint)

  const configPath = join(cwd, CONFIG_FILE)
  let raw: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      // Malformed project config — do not clobber a file the user may want to
      // fix by hand. Report the detection without writing.
      return { fingerprint, verify: detected, wrote: false, filledKeys: [] }
    }
  }

  const existing = (raw.verify ?? {}) as Record<string, string>
  const filledKeys: string[] = []
  const merged: Record<string, string> = { ...existing }
  for (const [key, value] of Object.entries(detected)) {
    if (!merged[key]) {
      merged[key] = value
      filledKeys.push(key)
    }
  }

  if (filledKeys.length === 0) {
    return { fingerprint, verify: merged, wrote: false, filledKeys }
  }

  writeFileSync(configPath, JSON.stringify({ ...raw, verify: merged }, null, 2) + '\n', 'utf-8')
  invalidateVerifyConfig()
  return { fingerprint, verify: merged, wrote: true, filledKeys }
}

/**
 * Render the `.rivet.md` Stack section from the fingerprint + declaration.
 * Single direction (config → md): this text is generated, and says so.
 */
export function renderRivetMdStack(fp: ProjectFingerprint, verify: VerifyConfig): string {
  const line = (label: string, value?: string): string => `- ${label}: ${value ?? ''}`
  return [
    '## Stack',
    '',
    '<!-- Generated from .rivet-config.json `verify` by /init — edit that file and re-run /init, do not hand-edit these lines. -->',
    line('Language', fp.language === 'unknown' ? '' : fp.language),
    line('Build', verify.build),
    line('Test', verify.test),
    ...(verify.typecheck ? [line('Typecheck', verify.typecheck)] : []),
    ...(verify.lint ? [line('Lint', verify.lint)] : []),
  ].join('\n')
}

/** Replace (or append) the `## Stack` section of an existing .rivet.md body. */
export function upsertStackSection(rivetMdBody: string, stackSection: string): string {
  const stackRe = /## Stack[\s\S]*?(?=\n## |$)/
  if (stackRe.test(rivetMdBody)) {
    return rivetMdBody.replace(stackRe, stackSection + '\n\n')
  }
  return rivetMdBody.trimEnd() + '\n\n' + stackSection + '\n'
}
