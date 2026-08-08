import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  STAGING_MARKER,
  writeStagingMarker,
  clearStagingMarker,
  verifyStagedRuntime,
} from '../staged-runtime-verify.js'

function tmpDist() {
  return mkdtempSync(join(tmpdir(), 'staged-verify-'))
}

/** Stage a package dir with `files` entries; empty array = directory only. */
function pkg(distDir: string, name: string, files: string[]) {
  const dir = join(distDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), 'x')
}

test('verifyStagedRuntime skips when dist/node_modules absent (plain tsup build)', () => {
  const dist = tmpDist()
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
  assert.deepEqual(r.problems, [])
  rmSync(dist, { recursive: true, force: true })
})

test('verifyStagedRuntime passes on a fully staged tree', () => {
  const dist = tmpDist()
  pkg(dist, 'web-tree-sitter', ['package.json', 'tree-sitter.js'])
  pkg(dist, '@ast-grep/napi', ['package.json', 'index.js'])
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, true)
  assert.equal(r.skipped, false)
  assert.deepEqual(r.problems, [])
  rmSync(dist, { recursive: true, force: true })
})

// The 2026-08-03 incident: staging left 65 directories and zero files, and
// every downstream guard still passed because the import allowlist only
// checks specifiers, not payload.
test('verifyStagedRuntime catches a package directory staged with zero files', () => {
  const dist = tmpDist()
  pkg(dist, 'web-tree-sitter', [])
  pkg(dist, 'typescript', ['package.json'])
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, false)
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0]!, /web-tree-sitter/)
  rmSync(dist, { recursive: true, force: true })
})

test('verifyStagedRuntime detects empty scoped packages', () => {
  const dist = tmpDist()
  pkg(dist, '@ast-grep/napi', [])
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, false)
  assert.match(r.problems[0]!, /@ast-grep\/napi/)
  rmSync(dist, { recursive: true, force: true })
})

test('verifyStagedRuntime counts files in nested subdirectories', () => {
  const dist = tmpDist()
  const nested = join(dist, 'node_modules', 'tree-sitter-wasms', 'out')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'tree-sitter-go.wasm'), 'x')
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, true)
  rmSync(dist, { recursive: true, force: true })
})

test('an interrupted staging run leaves a marker that verify reports', () => {
  const dist = tmpDist()
  mkdirSync(join(dist, 'node_modules'), { recursive: true })
  writeStagingMarker(dist, 'copying roots')
  pkg(dist, 'typescript', ['package.json'])

  assert.equal(existsSync(join(dist, 'node_modules', STAGING_MARKER)), true)
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, false)
  assert.equal(r.incomplete, true)
  assert.match(r.problems.join('\n'), /copying roots/)
  rmSync(dist, { recursive: true, force: true })
})

test('clearStagingMarker removes the marker so a completed run verifies clean', () => {
  const dist = tmpDist()
  mkdirSync(join(dist, 'node_modules'), { recursive: true })
  writeStagingMarker(dist, 'copying roots')
  pkg(dist, 'typescript', ['package.json'])
  clearStagingMarker(dist)

  assert.equal(existsSync(join(dist, 'node_modules', STAGING_MARKER)), false)
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, true)
  assert.equal(r.incomplete, false)
  rmSync(dist, { recursive: true, force: true })
})

test('clearStagingMarker is a no-op when no marker exists', () => {
  const dist = tmpDist()
  mkdirSync(join(dist, 'node_modules'), { recursive: true })
  clearStagingMarker(dist)
  clearStagingMarker(dist)
  rmSync(dist, { recursive: true, force: true })
})

test('the marker records stage and timestamp for post-mortem attribution', () => {
  const dist = tmpDist()
  mkdirSync(join(dist, 'node_modules'), { recursive: true })
  writeStagingMarker(dist, 'pack-native handoff')
  const r = verifyStagedRuntime(dist)
  const text = r.problems.join('\n')
  assert.match(text, /pack-native handoff/)
  // ISO-8601 timestamp so a stale dist can be dated without guessing.
  assert.match(text, /\d{4}-\d{2}-\d{2}T/)
  rmSync(dist, { recursive: true, force: true })
})

test('marker and empty-package problems are reported together, not short-circuited', () => {
  const dist = tmpDist()
  mkdirSync(join(dist, 'node_modules'), { recursive: true })
  writeStagingMarker(dist, 'copying roots')
  pkg(dist, 'web-tree-sitter', [])
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, false)
  assert.equal(r.incomplete, true)
  assert.equal(r.problems.length, 2)
  rmSync(dist, { recursive: true, force: true })
})

test('a bare node_modules with no packages is not treated as staged', () => {
  const dist = tmpDist()
  mkdirSync(join(dist, 'node_modules'), { recursive: true })
  const r = verifyStagedRuntime(dist)
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
  rmSync(dist, { recursive: true, force: true })
})
