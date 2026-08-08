import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isRuntimeLeanAspect, isRuntimeLean } from '../runtime-lean.js'

const ENV_KEYS = ['RIVET_LEAN', 'RIVET_LEAN_ASPECT', 'RIVET_CONFIG_PATH'] as const

describe('isRuntimeLeanAspect', () => {
  let saved: Array<string | undefined>
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-lean-aspect-'))
    saved = ENV_KEYS.map(k => process.env[k])
    for (const k of ENV_KEYS) delete process.env[k]
    // Isolate from real user config — the fallback chain reads it.
    process.env.RIVET_CONFIG_PATH = join(dir, 'nonexistent-config.json')
  })

  afterEach(() => {
    ENV_KEYS.forEach((k, i) => {
      const v = saved[i]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('no env and no config → all aspects off', () => {
    assert.equal(isRuntimeLeanAspect('tools'), false)
    assert.equal(isRuntimeLeanAspect('prompt'), false)
    assert.equal(isRuntimeLeanAspect('embeddings'), false)
    assert.equal(isRuntimeLeanAspect('meridian'), false)
    assert.equal(isRuntimeLeanAspect('pool'), false)
  })

  it('RIVET_LEAN=1 → all aspects on (master switch overrides)', () => {
    process.env.RIVET_LEAN = '1'
    for (const aspect of ['tools', 'prompt', 'embeddings', 'meridian', 'pool'] as const) {
      assert.equal(isRuntimeLeanAspect(aspect), true)
    }
  })

  it('RIVET_LEAN=0 → all aspects off even with aspect list (master switch off)', () => {
    process.env.RIVET_LEAN = '0'
    process.env.RIVET_LEAN_ASPECT = 'tools,pool'
    assert.equal(isRuntimeLeanAspect('tools'), false)
    assert.equal(isRuntimeLeanAspect('pool'), false)
  })

  it('RIVET_LEAN_ASPECT=embeddings → only embeddings on', () => {
    process.env.RIVET_LEAN_ASPECT = 'embeddings'
    assert.equal(isRuntimeLeanAspect('embeddings'), true)
    assert.equal(isRuntimeLeanAspect('tools'), false)
    assert.equal(isRuntimeLeanAspect('prompt'), false)
    assert.equal(isRuntimeLeanAspect('meridian'), false)
    assert.equal(isRuntimeLeanAspect('pool'), false)
  })

  it('RIVET_LEAN_ASPECT=tools,pool → only tools and pool on', () => {
    process.env.RIVET_LEAN_ASPECT = 'tools, pool'
    assert.equal(isRuntimeLeanAspect('tools'), true)
    assert.equal(isRuntimeLeanAspect('pool'), true)
    assert.equal(isRuntimeLeanAspect('prompt'), false)
    assert.equal(isRuntimeLeanAspect('embeddings'), false)
    assert.equal(isRuntimeLeanAspect('meridian'), false)
  })

  it('empty RIVET_LEAN_ASPECT falls back to config chain', () => {
    process.env.RIVET_LEAN_ASPECT = '  '
    assert.equal(isRuntimeLeanAspect('tools'), false)
    // configLean fallback still applies when aspect env is empty
    assert.equal(isRuntimeLeanAspect('pool', true), true)
  })

  it('configLean fallback works without any env', () => {
    assert.equal(isRuntimeLeanAspect('tools', true), true)
    assert.equal(isRuntimeLeanAspect('tools', false), false)
  })

  it('isRuntimeLean unchanged (backward compat)', () => {
    process.env.RIVET_LEAN = '1'
    assert.equal(isRuntimeLean(), true)
    delete process.env.RIVET_LEAN
    assert.equal(isRuntimeLean(false), false)
  })
})
