/**
 * Disk I/O boundary for provider API keys (0600 secrets file).
 *
 * config.json holds only a `keyRef` pointer; the actual key lives in
 * `secrets.json` next to it. Mirrors the TokenStore write pattern
 * (src/auth/token-store.ts) but hardens mode on every write — writeFileSync's
 * `mode` only applies at creation, so we chmod after rename too.
 *
 * Reads are fail-open: a missing/corrupt store yields undefined and the
 * caller's existing fallback chain (env vars, friendly error) takes over.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { rivetHome, userConfigPath } from './paths.js'

interface SecretsFile {
  version: 1
  keys: Record<string, string>
}

/** Secrets live next to config.json (honors RIVET_CONFIG_PATH / RIVET_HOME). */
export function secretsPath(base?: string): string {
  if (base) return join(base, 'secrets.json')
  try {
    return join(dirname(userConfigPath()), 'secrets.json')
  } catch {
    return join(rivetHome(), 'secrets.json')
  }
}

function readStore(base?: string): SecretsFile | undefined {
  try {
    const raw = readFileSync(secretsPath(base), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SecretsFile>
    if (parsed.version !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) return undefined
    return { version: 1, keys: parsed.keys as Record<string, string> }
  } catch {
    return undefined
  }
}

function writeStore(store: SecretsFile, base?: string): void {
  const path = secretsPath(base)
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(tmpPath, path)
  chmodSync(path, 0o600)
}

export function readSecret(keyRef: string, base?: string): string | undefined {
  const store = readStore(base)
  const value = store?.keys[keyRef]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function writeSecret(keyRef: string, value: string, base?: string): void {
  const store = readStore(base) ?? { version: 1 as const, keys: {} }
  store.keys[keyRef] = value
  writeStore(store, base)
}

export function deleteSecret(keyRef: string, base?: string): void {
  const store = readStore(base)
  if (!store || !(keyRef in store.keys)) return
  delete store.keys[keyRef]
  if (Object.keys(store.keys).length === 0) {
    try { unlinkSync(secretsPath(base)) } catch { /* already gone */ }
    return
  }
  writeStore(store, base)
}

/** 展示安全的短指纹——用于标记共用同一 key 的条目，不打印密钥材料。 */
export function secretFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export function fingerprintForKeyRef(keyRef: string, base?: string): string | undefined {
  const value = readSecret(keyRef, base)
  return value ? secretFingerprint(value) : undefined
}
