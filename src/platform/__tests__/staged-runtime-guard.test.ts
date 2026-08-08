import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectStagedRuntime } from '../staged-runtime-guard.js'

function layout() {
  const root = mkdtempSync(join(tmpdir(), 'staged-guard-'))
  return { root, dist: join(root, 'dist') }
}

/** Create a package dir; empty `files` reproduces the skeleton-only shape. */
function pkg(modulesDir: string, name: string, files: string[]) {
  const dir = join(modulesDir, name)
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), 'x')
}

test('a fully staged dist needs no action', () => {
  const { root, dist } = layout()
  const nm = join(dist, 'node_modules')
  pkg(nm, 'web-tree-sitter', ['package.json', 'tree-sitter.js'])
  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'ok')
  rmSync(root, { recursive: true, force: true })
})

test('a dist without node_modules needs no action (resolution walks upward)', () => {
  const { root, dist } = layout()
  mkdirSync(dist, { recursive: true })
  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'ok')
  rmSync(root, { recursive: true, force: true })
})

// Node resolves a bare specifier against the FIRST node_modules that contains a
// matching directory and does not continue upward when that directory turns out
// to be unusable. An empty skeleton therefore shadows a perfectly good parent
// node_modules — it is strictly worse than having no directory at all.
test('an empty skeleton with a usable parent node_modules is healable', () => {
  const { root, dist } = layout()
  pkg(join(dist, 'node_modules'), 'web-tree-sitter', [])
  pkg(join(root, 'node_modules'), 'web-tree-sitter', ['package.json', 'tree-sitter.js'])

  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'heal')
  assert.deepEqual(r.emptyPackages, ['web-tree-sitter'])
  rmSync(root, { recursive: true, force: true })
})

test('an empty skeleton with no parent fallback is fatal, not healable', () => {
  const { root, dist } = layout()
  pkg(join(dist, 'node_modules'), 'web-tree-sitter', [])
  // No parent node_modules — the packaged .app shape, where deleting the
  // skeleton would not make the dependency resolvable.
  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'fatal')
  assert.deepEqual(r.emptyPackages, ['web-tree-sitter'])
  rmSync(root, { recursive: true, force: true })
})

test('healing requires every empty package to have a parent counterpart', () => {
  const { root, dist } = layout()
  pkg(join(dist, 'node_modules'), 'web-tree-sitter', [])
  pkg(join(dist, 'node_modules'), 'typescript', [])
  // Only one of the two is recoverable from the parent.
  pkg(join(root, 'node_modules'), 'web-tree-sitter', ['package.json'])

  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'fatal')
  assert.deepEqual(r.emptyPackages.sort(), ['typescript', 'web-tree-sitter'])
  rmSync(root, { recursive: true, force: true })
})

test('scoped packages are inspected one level deep', () => {
  const { root, dist } = layout()
  pkg(join(dist, 'node_modules'), '@ast-grep/napi', [])
  pkg(join(root, 'node_modules'), '@ast-grep/napi', ['package.json'])

  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'heal')
  assert.deepEqual(r.emptyPackages, ['@ast-grep/napi'])
  rmSync(root, { recursive: true, force: true })
})

test('files nested in subdirectories count as staged payload', () => {
  const { root, dist } = layout()
  const out = join(dist, 'node_modules', 'tree-sitter-wasms', 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'tree-sitter-go.wasm'), 'x')

  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'ok')
  rmSync(root, { recursive: true, force: true })
})

test('a partially staged tree only reports the empty packages', () => {
  const { root, dist } = layout()
  const nm = join(dist, 'node_modules')
  pkg(nm, 'typescript', ['package.json'])
  pkg(nm, 'web-tree-sitter', [])
  pkg(root === dist ? nm : join(root, 'node_modules'), 'web-tree-sitter', ['package.json'])

  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'heal')
  assert.deepEqual(r.emptyPackages, ['web-tree-sitter'])
  rmSync(root, { recursive: true, force: true })
})

test('dotfiles in node_modules are not mistaken for packages', () => {
  const { root, dist } = layout()
  const nm = join(dist, 'node_modules')
  mkdirSync(join(nm, '.staging-incomplete-dir'), { recursive: true })
  pkg(nm, 'typescript', ['package.json'])

  const r = inspectStagedRuntime(dist)
  assert.equal(r.action, 'ok')
  rmSync(root, { recursive: true, force: true })
})

test('inspect never throws on a nonexistent dist', () => {
  const r = inspectStagedRuntime(join(tmpdir(), 'no-such-dist-xyz'))
  assert.equal(r.action, 'ok')
})
