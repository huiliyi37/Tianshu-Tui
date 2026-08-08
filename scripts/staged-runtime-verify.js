/**
 * staged-runtime-verify.js — prove that `dist/node_modules` actually holds the
 * staged payload, not just its directory skeleton.
 *
 * Why this exists (2026-08-04 留痕):
 *   A desktop package run on 2026-08-03 died somewhere inside stage-runtime-deps
 *   and left `dist/node_modules` with 65 directories and **zero files**, plus an
 *   empty `dist/native`. Nothing downstream noticed:
 *     - `npm run build` is just tsup, so `dist/*.js` kept refreshing daily and
 *       the tree looked current;
 *     - assert-runtime-imports checks import *specifiers* against an allowlist,
 *       and `web-tree-sitter` is on that allowlist — payload is never inspected;
 *     - the runtime hook pipeline isolates hook errors, so meridian-index failed
 *       303 times over two days without surfacing anywhere.
 *   The staging script itself was fine (untouched for 9 days, and a plain re-run
 *   restored all 321 files). The gap was that an interrupted run is
 *   indistinguishable from a successful one.
 *
 * Two independent signals, because a run can break either way:
 *   - marker  — written at the start of staging, removed only on success. Catches
 *               interruptions that leave a *partially populated* tree.
 *   - payload — a staged package directory containing no files at any depth.
 *               Catches the skeleton-only shape actually observed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Sentinel filename inside `dist/node_modules` while staging is in flight. */
export const STAGING_MARKER = '.staging-incomplete'

function markerPath(distDir) {
  return join(distDir, 'node_modules', STAGING_MARKER)
}

/**
 * Mark staging as in flight. Call right after `dist/node_modules` is created.
 * @param {string} distDir absolute path to dist/
 * @param {string} stage short label for the phase being entered
 */
export function writeStagingMarker(distDir, stage) {
  const dir = join(distDir, 'node_modules')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    markerPath(distDir),
    JSON.stringify({ stage, startedAt: new Date().toISOString(), pid: process.pid }, null, 2),
  )
}

/** Clear the marker. Call only after staging fully succeeded. */
export function clearStagingMarker(distDir) {
  rmSync(markerPath(distDir), { force: true })
}

/** Files at any depth under `dir`. Short-circuits on the first hit. */
function hasAnyFile(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  const subdirs = []
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) subdirs.push(full)
    else return true
  }
  return subdirs.some(hasAnyFile)
}

/** Package dirs under node_modules, expanding `@scope/` one level. */
function stagedPackages(modulesDir) {
  const out = []
  let entries
  try {
    entries = readdirSync(modulesDir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const full = join(modulesDir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(full)) {
        const subFull = join(full, sub)
        try {
          if (statSync(subFull).isDirectory()) out.push({ name: `${entry}/${sub}`, dir: subFull })
        } catch {
          /* ignore */
        }
      }
      continue
    }
    out.push({ name: entry, dir: full })
  }
  return out
}

/**
 * @param {string} distDir absolute path to dist/
 * @returns {{ ok: boolean, skipped: boolean, incomplete: boolean, problems: string[] }}
 */
export function verifyStagedRuntime(distDir) {
  const modulesDir = join(distDir, 'node_modules')
  const problems = []

  const marker = markerPath(distDir)
  let incomplete = false
  if (existsSync(marker)) {
    incomplete = true
    let detail = ''
    try {
      const m = JSON.parse(readFileSync(marker, 'utf8'))
      detail = ` (stage="${m.stage}", startedAt=${m.startedAt})`
    } catch {
      /* malformed marker still counts as incomplete */
    }
    problems.push(`staging did not complete — ${STAGING_MARKER} present${detail}`)
  }

  const packages = existsSync(modulesDir) ? stagedPackages(modulesDir) : []
  // No packages at all means staging never ran (plain tsup build) rather than
  // ran and produced nothing — do not fail those builds. An in-flight marker is
  // still reported, since that shape can only come from an interrupted run.
  if (packages.length === 0) {
    return { ok: !incomplete, skipped: !incomplete, incomplete, problems }
  }

  for (const { name, dir } of packages) {
    if (!hasAnyFile(dir)) {
      problems.push(`staged package "${name}" contains no files — directory skeleton only`)
    }
  }

  return { ok: problems.length === 0, skipped: false, incomplete, problems }
}
