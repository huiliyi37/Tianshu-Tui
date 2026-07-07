import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeHookPipeline, createRuntimeHookContext } from '../runtime-hooks.js'
import { createUserHooksBridge, runOnErrorHooks, type UserHooksBridgeDeps } from '../hooks/user-hooks-bridge.js'
import type { HookResult } from '../../hooks/user-hooks-runner.js'

function makeCtx(turn = 1) {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

function writeScript(cwd: string, name: string, body: string) {
  const path = join(cwd, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf-8')
  chmodSync(path, 0o755)
}

describe('createUserHooksBridge', () => {
  it('emits hook_result after postTool hooks run', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-hooks-bridge-'))
    try {
      mkdirSync(join(cwd, '.rivet'))
      writeScript(cwd, 'post-tool.sh', 'echo hi')
      writeFileSync(join(cwd, '.rivet', 'hooks.json'), JSON.stringify({
        hooks: [{ event: 'postTool', script: './post-tool.sh' }],
      }))

      const emissions: { results: HookResult[]; meta: Record<string, unknown> }[] = []
      const deps: UserHooksBridgeDeps = {
        cwd,
        sessionId: 's1',
        getTurn: () => 2,
        emitHookResult: (results, meta) => emissions.push({ results, meta: { ...meta } }),
      }

      const pipeline = new RuntimeHookPipeline(createUserHooksBridge(deps))
      pipeline.runPostTool(makeCtx(2), { name: 'write_file', success: true })

      assert.equal(emissions.length, 1)
      assert.equal(emissions[0]!.meta.event, 'postTool')
      assert.equal(emissions[0]!.meta.turn, 2)
      assert.equal(emissions[0]!.meta.toolName, 'write_file')
      assert.equal(emissions[0]!.results.length, 1)
      assert.equal(emissions[0]!.results[0]!.ok, true)
      assert.equal(emissions[0]!.results[0]!.output, 'hi')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('emits hook_result after preTurn/postTurn/postSession hooks run', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-hooks-bridge-'))
    try {
      mkdirSync(join(cwd, '.rivet'))
      writeScript(cwd, 'lifecycle.sh', 'echo lifecycle')
      writeFileSync(join(cwd, '.rivet', 'hooks.json'), JSON.stringify({
        hooks: [
          { event: 'preTurn', script: './lifecycle.sh' },
          { event: 'postTurn', script: './lifecycle.sh' },
          { event: 'postSession', script: './lifecycle.sh' },
        ],
      }))

      const events: string[] = []
      const deps: UserHooksBridgeDeps = {
        cwd,
        sessionId: 's1',
        getTurn: () => 1,
        emitHookResult: (_results, meta) => events.push(meta.event),
      }

      const pipeline = new RuntimeHookPipeline(createUserHooksBridge(deps))
      const ctx = makeCtx(1)
      pipeline.runPreTurn(ctx)
      pipeline.runPostTurn(ctx)
      pipeline.runPostSession(ctx)

      assert.deepEqual(events, ['preTurn', 'postTurn', 'postSession'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('runOnErrorHooks runs onError hooks and emits results', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-hooks-bridge-'))
    try {
      mkdirSync(join(cwd, '.rivet'))
      writeScript(cwd, 'on-error.sh', 'echo err')
      writeFileSync(join(cwd, '.rivet', 'hooks.json'), JSON.stringify({
        hooks: [{ event: 'onError', script: './on-error.sh' }],
      }))

      const emissions: { results: HookResult[]; meta: Record<string, unknown> }[] = []
      const deps: UserHooksBridgeDeps = {
        cwd,
        sessionId: 's1',
        getTurn: () => 5,
        emitHookResult: (results, meta) => emissions.push({ results, meta: { ...meta } }),
      }

      runOnErrorHooks(deps, 'something broke')

      assert.equal(emissions.length, 1)
      assert.equal(emissions[0]!.meta.event, 'onError')
      assert.equal(emissions[0]!.meta.turn, 5)
      assert.equal(emissions[0]!.meta.error, 'something broke')
      assert.equal(emissions[0]!.results[0]!.ok, true)
      assert.equal(emissions[0]!.results[0]!.output, 'err')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
