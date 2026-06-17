/**
 * 1B：范围化（per-instance）进程取消的隔离性。
 *
 * 设计：AgentLoop.abort() 不再用全局 killAll 硬锤，而是翻转**本实例独有**的
 * abortController 信号；该信号经 tool-pipeline 透传给本实例正在跑的工具，
 * 工具（bash/run_tests）监听 params.abortSignal 自杀其子进程。
 * 因信号按实例隔离，中止一个"实例"绝不会波及另一个实例的子进程。
 *
 * 本测试用两个独立 AbortSignal 模拟两个 AgentLoop 实例的信号边界：
 * 中止信号 A → 仅 A 的子进程被杀（markerA 缺失），B 不受影响（markerB 写出）。
 *
 * 环境注意：当 agent 自身运行在 macOS Seatbelt 沙箱内时，sandbox-exec 无法嵌套
 * (sandbox_apply: EPERM)，persistRawOutput 写 /var/folders T/ 也会 EPERM。
 * 因此测试 setup 做两件事：禁用命令沙箱 + 将 TMPDIR 重定向到 workspace 内。
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

const _savedNoSandbox = process.env.RIVET_NO_SANDBOX
const _savedTmpdir = process.env.TMPDIR
let _testTmp: string

before(() => {
  // Disable sandbox: sandbox-exec cannot nest inside the agent's Seatbelt.
  process.env.RIVET_NO_SANDBOX = '1'
  _resetSandboxBackendCache()
  // Redirect TMPDIR to workspace so persistRawOutput / mkdtemp don't EPERM.
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

function bashParams(command: string, signal: AbortSignal, cwd: string): ToolCallParams {
  return {
    input: { command },
    toolUseId: 'iso-' + Math.random().toString(36).slice(2),
    cwd,
    abortSignal: signal,
  }
}

test('中止实例 A 的信号只杀 A 的子进程，B 的进程照常完成', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-iso-'))
  const markerA = join(cwd, 'A.txt')
  const markerB = join(cwd, 'B.txt')

  const ctrlA = new AbortController()
  const ctrlB = new AbortController()

  // 两个进程都在 1.2s 后 touch；A 在 100ms 时被中止，B 不中止
  const pA = BASH_TOOL.execute(bashParams(`sleep 1.2 && touch "${markerA}"`, ctrlA.signal, cwd))
  const pB = BASH_TOOL.execute(bashParams(`sleep 1.2 && touch "${markerB}"`, ctrlB.signal, cwd))

  await sleepMs(100)
  ctrlA.abort() // 仅中止 A

  await Promise.all([pA, pB])
  // 等过 touch 时刻，确认 B 完成、A 被杀
  await sleepMs(1800)

  assert.equal(existsSync(markerA), false, 'A 被中止 → 子进程在 touch 前被杀，markerA 不应存在')
  assert.equal(existsSync(markerB), true, 'B 未被中止 → 子进程正常完成，markerB 应存在')

  rmSync(cwd, { recursive: true, force: true })
})
