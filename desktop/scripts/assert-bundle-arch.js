#!/usr/bin/env node
/**
 * assert-bundle-arch.js — fail the build if a packaged Resources tree still
 * contains non-target-arch Node / esbuild / ast-grep.
 *
 * Usage:
 *   node desktop/scripts/assert-bundle-arch.js <resourcesRoot> [triple]
 */
import { fileURLToPath } from 'node:url'
import { planPrunePaths, resolveKeepArch } from './prune-bundle-arch.js'

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (!invokedDirectly) {
  // imported for tests — no side effects
} else {
  const root = process.argv[2]
  const triple = process.argv[3] || ''
  if (!root) {
    console.error('usage: assert-bundle-arch.js <resourcesRoot> [triple]')
    process.exit(2)
  }
  const keep = resolveKeepArch(triple)
  const leftovers = planPrunePaths(root, keep)
  if (leftovers.length > 0) {
    console.error(`[assert-bundle-arch] FAIL keep=${keep}: foreign-arch paths still present:`)
    for (const p of leftovers) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`[assert-bundle-arch] OK keep=${keep} (no foreign-arch runtimes)`)
}
