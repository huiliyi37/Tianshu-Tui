import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isRuntimeLean,
  resolveSessionPoolOptions,
  LEAN_MAX_LOADED_SESSIONS,
  LEAN_IDLE_AGENT_TTL_MS,
  DEFAULT_MAX_LOADED_SESSIONS,
  DEFAULT_IDLE_AGENT_TTL_MS,
  LEAN_MAX_EVENTS_DISK_BYTES,
} from '../runtime-lean.js'
import { __resetToolPresetForTest, resolveToolPreset } from '../../tools/tool-preset.js'
import { invalidatePromptBlocks, resolvePromptBlocks } from '../../prompt/block-policy.js'

const ENV_KEYS = ['RIVET_LEAN', 'RIVET_TOOL_PRESET', 'RIVET_PROMPT_PROFILE'] as const

describe('runtime-lean', () => {
  let saved: Array<string | undefined>
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-lean-'))
    saved = ENV_KEYS.map(k => process.env[k])
    for (const k of ENV_KEYS) delete process.env[k]
    __resetToolPresetForTest()
    invalidatePromptBlocks()
  })

  afterEach(() => {
    ENV_KEYS.forEach((k, i) => {
      const v = saved[i]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    })
    __resetToolPresetForTest()
    invalidatePromptBlocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('RIVET_LEAN=1 forces lean; =0 forces off over config', () => {
    process.env.RIVET_LEAN = '1'
    assert.equal(isRuntimeLean(false), true)
    process.env.RIVET_LEAN = '0'
    assert.equal(isRuntimeLean(true), false)
  })

  it('configLean true enables without env', () => {
    assert.equal(isRuntimeLean(true), true)
    assert.equal(isRuntimeLean(false), false)
  })

  it('lean expands tool preset to minimal when preset unset', () => {
    process.env.RIVET_LEAN = '1'
    assert.equal(resolveToolPreset(dir), 'minimal')
  })

  it('explicit tool preset wins over lean', () => {
    process.env.RIVET_LEAN = '1'
    process.env.RIVET_TOOL_PRESET = 'full'
    assert.equal(resolveToolPreset(dir), 'full')
  })

  it('lean expands prompt profile when unset', () => {
    process.env.RIVET_LEAN = '1'
    assert.equal(resolvePromptBlocks(dir).profile, 'lean')
  })

  it('explicit prompt profile wins over lean', () => {
    process.env.RIVET_LEAN = '1'
    process.env.RIVET_PROMPT_PROFILE = 'full'
    assert.equal(resolvePromptBlocks(dir).profile, 'full')
  })

  it('resolveSessionPoolOptions uses lean caps', () => {
    const lean = resolveSessionPoolOptions({}, true)
    assert.equal(lean.maxLoadedSessions, LEAN_MAX_LOADED_SESSIONS)
    assert.equal(lean.idleAgentTtlMs, LEAN_IDLE_AGENT_TTL_MS)
    assert.equal(lean.maxEventsDiskBytes, LEAN_MAX_EVENTS_DISK_BYTES)

    const normal = resolveSessionPoolOptions({}, false)
    assert.equal(normal.maxLoadedSessions, DEFAULT_MAX_LOADED_SESSIONS)
    assert.equal(normal.idleAgentTtlMs, DEFAULT_IDLE_AGENT_TTL_MS)

    const override = resolveSessionPoolOptions({ maxLoadedSessions: 2, idleAgentTtlMs: 1000 }, true)
    assert.equal(override.maxLoadedSessions, 2)
    assert.equal(override.idleAgentTtlMs, 1000)
  })

  it('reads runtime.lean from project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ runtime: { lean: true } }))
    mkdirSync(join(dir, 'src'), { recursive: true })
    assert.equal(isRuntimeLean(undefined, dir), true)
  })
})
