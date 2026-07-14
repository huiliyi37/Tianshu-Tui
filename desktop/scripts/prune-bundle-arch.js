#!/usr/bin/env node
/**
 * prune-bundle-arch.js — drop non-target-arch Node / esbuild / ast-grep from a
 * Resources (or staging) tree so each packaged .app only ships one architecture.
 *
 * Usage:
 *   node desktop/scripts/prune-bundle-arch.js <resourcesRoot> [triple]
 *
 * resourcesRoot layout:
 *   <root>/node-runtime/<os>-<arch>/…
 *   <root>/rivet-runtime/node_modules/@esbuild/…
 *   <root>/rivet-runtime/node_modules/@ast-grep/…
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} [triple] e.g. aarch64-apple-darwin
 * @returns {'arm64'|'x64'}
 */
export function resolveKeepArch(triple) {
  const t = (triple || process.env.TAURI_ENV_TARGET_TRIPLE || '').trim()
  if (t) {
    const tok = t.split('-')[0]
    if (tok === 'aarch64' || tok === 'arm64') return 'arm64'
    if (tok === 'x86_64' || tok === 'i686') return 'x64'
  }
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

/**
 * @param {string} resourcesRoot
 * @param {'arm64'|'x64'} keep
 * @returns {string[]} absolute paths to delete
 */
export function planPrunePaths(resourcesRoot, keep) {
  const drop = keep === 'arm64' ? 'x64' : 'arm64'
  /** @type {string[]} */
  const out = []

  const nodeRoot = join(resourcesRoot, 'node-runtime')
  if (existsSync(nodeRoot)) {
    for (const name of readdirSync(nodeRoot)) {
      if (name === '.gitkeep') continue
      // darwin-x64 / win-x64 / linux-arm64 …
      if (name.endsWith(`-${drop}`)) out.push(join(nodeRoot, name))
    }
  }

  const nm = join(resourcesRoot, 'rivet-runtime', 'node_modules')
  const es = join(nm, '@esbuild')
  if (existsSync(es)) {
    for (const name of readdirSync(es)) {
      if (name.includes(drop)) out.push(join(es, name))
    }
  }
  const ag = join(nm, '@ast-grep')
  if (existsSync(ag)) {
    for (const name of readdirSync(ag)) {
      if (name.includes(drop)) out.push(join(ag, name))
    }
  }
  return out.filter((p) => existsSync(p))
}

/**
 * @param {string} resourcesRoot
 * @param {'arm64'|'x64'} keep
 */
export function pruneBundleArch(resourcesRoot, keep) {
  for (const p of planPrunePaths(resourcesRoot, keep)) {
    rmSync(p, { recursive: true, force: true })
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const root = process.argv[2]
  const keep = resolveKeepArch(process.argv[3] || '')
  if (!root) {
    console.error('usage: prune-bundle-arch.js <resourcesRoot> [triple]')
    process.exit(2)
  }
  const plan = planPrunePaths(root, keep)
  console.log(`[prune-bundle-arch] keep=${keep} removing ${plan.length} path(s)`)
  for (const p of plan) console.log(`  - ${p}`)
  pruneBundleArch(root, keep)
}
