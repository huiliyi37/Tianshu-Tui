import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pruneTypescriptStaging, TS_LIB_DROP_FILES } from '../typescript-stage-trim.js'

test('pruneTypescriptStaging keeps typescript.js and lib.*.d.ts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-trim-'))
  const lib = join(root, 'lib')
  mkdirSync(join(lib, 'zh-cn'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(lib, 'typescript.js'), 'exports.ok=1')
  writeFileSync(join(lib, 'lib.es5.d.ts'), 'declare var x: number')
  writeFileSync(join(lib, '_tsc.js'), 'cli')
  writeFileSync(join(lib, 'tsserver.js'), 'server')
  writeFileSync(join(lib, 'zh-cn', 'diagnosticMessages.generated.json'), '{}')
  writeFileSync(join(root, 'bin', 'tsc'), '#!/bin/sh')
  writeFileSync(join(root, 'package.json'), '{"main":"./lib/typescript.js"}')

  const { removed } = pruneTypescriptStaging(root)
  assert.ok(removed.some((r) => r.includes('zh-cn')))
  assert.ok(removed.includes('lib/_tsc.js'))
  assert.ok(removed.includes('bin/'))
  assert.equal(existsSync(join(lib, 'typescript.js')), true)
  assert.equal(existsSync(join(lib, 'lib.es5.d.ts')), true)
  assert.equal(existsSync(join(lib, '_tsc.js')), false)
  assert.equal(existsSync(join(root, 'bin')), false)

  rmSync(root, { recursive: true, force: true })
})

test('TS_LIB_DROP_FILES includes CLI and tsserver entrypoints', () => {
  assert.ok(TS_LIB_DROP_FILES.has('_tsc.js'))
  assert.ok(TS_LIB_DROP_FILES.has('tsserver.js'))
})
