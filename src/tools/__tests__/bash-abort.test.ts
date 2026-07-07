/**
 * 1A：bash 协作式取消。
 *
 * 子代理调查：bash.execute 之前完全不读 params.abortSignal，用户 Esc/Ctrl+C 后
 * detached 子进程会继续在后台运行 —— 既泄漏资源，又在会话"假死"期间持续产生副作用。
 *
 * 契约：
 *  - abort 时立即 settle（不等到命令自然结束 / 超时）。
 *  - 子进程树被杀：被 abort 的 `sleep && touch` 不会写出 marker 文件。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASH_TOOL } from '../bash.js'
import { _resetSandboxBackendCache } from '../sandbox-profile.js'
import type { ToolCallParams } from '../types.js'

const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

// Same environment fixes as abort-isolation.test.ts — see comments there.
const _savedNoSandbox = process.env.RIVET_NO_SANDBOX
const _savedTmpdir = process.env.TMPDIR
let _testTmp: string

before(() => {
  process.env.RIVET_NO_SANDBOX = '1'
  _resetSandboxBackendCache()
  _testTmp = mkdtempSync(join(process.cwd(), '.tmp-abort-'))
  process.env.TMPDIR = _testTmp
})
after(() => {
  if (_savedNoSandbox === undefined) delete process.env.RIVET_NO_SANDBOX
  else process.env.RIVET_NO_SANDBOX = _savedNoSandbox
  if (_savedTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = _savedTmpdir
  _resetSandboxBackendCache()
  rmSync(_testTmp, { recursive: true, force: true })
})

function makeParams(command: string, signal: AbortSignal, cwd: string): ToolCallParams {
  return {
    input: { command },
    toolUseId: 'bash-abort-' + Math.random().toString(36).slice(2),
    cwd,
    abortSignal: signal,
  }
}

test('abort 时 bash 立即 settle（不等命令自然结束）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-bash-abort-'))
  const ctrl = new AbortController()
  const start = Date.now()
  const p = BASH_TOOL.execute(makeParams('sleep 30', ctrl.signal, cwd))
  await sleepMs(100)
  ctrl.abort()
  const result = await Promise.race([
    p,
    sleepMs(2000).then(() => { throw new Error('bash 未在 2s 内 settle —— abort 未生效') }),
  ])
  const elapsed = Date.now() - start
  assert.ok(elapsed < 2000, `应迅速 settle，实际 ${elapsed}ms`)
  assert.equal((result as { isError?: boolean }).isError, false, 'abort 是用户行为，非失败')
  rmSync(cwd, { recursive: true, force: true })
})

test('abort 杀掉子进程树：被中止的 sleep&&touch 不写出 marker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-bash-kill-'))
  const marker = join(cwd, 'marker.txt')
  const ctrl = new AbortController()
  // 子进程：1.5s 后才 touch marker；我们在 100ms 时 abort，应在 touch 之前被杀
  const p = BASH_TOOL.execute(makeParams(`sleep 1.5 && touch "${marker}"`, ctrl.signal, cwd))
  await sleepMs(100)
  ctrl.abort()
  await p
  // 等过原本的 touch 时刻，确认进程确实被杀（marker 不应出现）
  await sleepMs(2200)
  assert.equal(existsSync(marker), false, '子进程应在 touch 之前被杀，marker 不应存在')
  rmSync(cwd, { recursive: true, force: true })
})
