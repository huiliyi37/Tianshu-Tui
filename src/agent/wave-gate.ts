/**
 * 波间硬门禁 — 大计划分波执行的防伪闭环（重构事故链缺口 2, 2026-07-04）。
 *
 * 事故形态：大计划一口气执行，波与波之间没有任何验证兜底，等最后一波跑完
 * 才发现前面的波早就把功能改丢了。此前只有 review backstop（advisory 非硬性）。
 *
 * 语义：
 * - executePlan 完成一个非末波后，立即评估门禁：typecheck（changed files 记忆化
 *   scoped tsc）+ 该波声明的验证命令（只执行形如测试/编译的白名单命令，其余记
 *   为 unverifiable 留痕不执行——计划声明的自由文本不能直接当 shell 跑）。
 * - 失败 → 结果存入会话级 store；下一波 dispatch 入口硬拦（executePlan 抛错）。
 * - 自愈：被拦时重新评估存储的门禁（主控可能已直接修复代码而非重跑波），
 *   现在通过则放行并更新记录。
 * - 逃生阀：RIVET_WAVE_GATE=0 整体禁用（保持 advisory-only 旧行为）。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseVerifyCommand, spawnVerifyArgv } from './verify-command.js'
import { gateTypecheckRunner, runChangedFilesTypecheckOutcomeMemo, typecheckGateEnabled, type TypecheckRunner } from './typecheck-gate.js'
import { evaluateTestPresence, testPresenceGateEnabled } from './test-presence.js'

export interface WaveGateCheck {
  command: string
  status: 'passed' | 'failed' | 'unverifiable'
  detail?: string
  /** unverifiable 且 blocking=true → 计入门禁失败（typecheck 超时/未跑完属于
   *  "没验证过"而非"验证通过"；声明式自由文本命令的 unverifiable 仍不拦）。 */
  blocking?: boolean
}

export interface WaveGateRecord {
  /** 被评估的波序号（0-based） */
  wave: number
  passed: boolean
  checks: WaveGateCheck[]
  /** 复评所需输入（自愈重跑用） */
  changedFiles: string[]
  commands: string[]
  checkedAt: number
}

/** 可执行验证命令判定：能解析成安全 argv 才算（H4 收口后白名单 = token
 *  字符集 + argv 形状双重校验，而非行首正则——`npx tsx; curl …|sh` 这类
 *  恶意后缀不再穿透）。council-obligations 的 advisory_gate 分类同源复用。 */
export function isRunnableVerifyCommand(command: string): boolean {
  return parseVerifyCommand(command) !== null
}

const gates = new Map<string, WaveGateRecord>()

function key(sessionId?: string): string {
  return sessionId ?? '__default__'
}

export function setWaveGate(record: WaveGateRecord, sessionId?: string): void {
  gates.set(key(sessionId), record)
}

export function getWaveGate(sessionId?: string): WaveGateRecord | undefined {
  return gates.get(key(sessionId))
}

/** 测试卫生/会话收尾清理。 */
export function clearWaveGate(sessionId?: string): void {
  gates.delete(key(sessionId))
}

export function isWaveGateEnabled(): boolean {
  return process.env.RIVET_WAVE_GATE !== '0'
}

export interface EvaluateWaveGateInput {
  cwd: string
  wave: number
  changedFiles: string[]
  /** 该波任务声明的验证命令（TeamTask.verification 去重）。 */
  commands: string[]
  typecheckRunner?: TypecheckRunner
  /** 测试钩子：命令执行器。缺省异步 spawn（shell）。允许返回 Promise——
   *  同步注入经 await 兼容。 */
  runCommand?: (cwd: string, command: string) => { ok: boolean; detail?: string } | Promise<{ ok: boolean; detail?: string }>
  /** 测试钩子：文件存在性判定。缺省 existsSync(resolve(cwd, f))。 */
  fileExists?: (relPath: string) => boolean
}

// 异步 spawn（同 typecheck-gate.ts 的 declared runner）——同步 spawnSync 最长
// 阻塞主线程 5 分钟，期间 TUI 完全无响应。执行前强制过 parseVerifyCommand：
// 解析失败按不可执行收口，绝不退回字符串拼 shell。
function defaultRunCommand(cwd: string, command: string): Promise<{ ok: boolean; detail?: string }> {
  const argv = parseVerifyCommand(command)
  if (!argv) {
    return Promise.resolve({ ok: false, detail: '非白名单验证命令形状——拒绝 shell 执行' })
  }
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    // 尾部 5 行 / 500 字符摘要——与旧 spawnSync 路径逐字节一致。
    const tail = (): string =>
      `${stdout}\n${stderr}`.trim().split('\n').slice(-5).join('\n').slice(0, 500)
    const settle = (result: { ok: boolean; detail?: string }): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    try {
      const child = spawnVerifyArgv(cwd, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        settle({ ok: false, detail: tail() })
      }, 300_000)
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) settle({ ok: true })
        else settle({ ok: false, detail: tail() })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        settle({ ok: false, detail: err.message })
      })
    } catch (err) {
      settle({ ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  })
}

/** 评估一个波的门禁：typecheck + 白名单验证命令。纯计算 + 受注入 I/O，可测。 */
export async function evaluateWaveGate(input: EvaluateWaveGateInput): Promise<WaveGateRecord> {
  const checks: WaveGateCheck[] = []

  if (typecheckGateEnabled() && input.changedFiles.length > 0) {
    try {
      // gateTypecheckRunner（5 分钟预算）而非 defaultRunner：满载机器上 2 分钟
      // tsc 跑不完，超时曾被记成 ✅ passed 放行下一波（2026-07-07 天枢长任务事故）。
      const outcome = await runChangedFilesTypecheckOutcomeMemo(
        input.cwd, input.changedFiles, input.typecheckRunner ?? gateTypecheckRunner)
      if (outcome.status === 'errors') {
        checks.push({ command: 'tsc --noEmit (scoped)', status: 'failed', detail: outcome.result!.summary })
      } else if (outcome.status === 'inconclusive') {
        // 硬门禁语义：没验证过 ≠ 验证通过。记 blocking unverifiable 拦下一波；
        // 自愈复评时 inconclusive 不进 memo，会真实重跑 tsc，机器空了即放行。
        checks.push({
          command: 'tsc --noEmit (scoped)',
          status: 'unverifiable',
          detail: `${outcome.reason ?? 'tsc did not complete'} — 未验证按失败拦截，复评自动重跑`,
          blocking: true,
        })
      } else {
        checks.push({ command: 'tsc --noEmit (scoped)', status: 'passed' })
      }
    } catch {
      checks.push({ command: 'tsc --noEmit (scoped)', status: 'unverifiable', detail: 'typecheck runner unavailable' })
    }
  }

  // 测试存在性：新代码堆到阈值却零测试文件 → blocking unverifiable 拦下一波。
  // 自愈复评时补了测试文件（changedFiles 更新）即放行——与 typecheck 超时同款语义。
  //
  // 输入先过磁盘存在性过滤（审查 2026-07-07 #4/#5）：changedFiles 含 worker
  // 自报路径，可伪造——不存在的"测试文件"不能让门禁放行；同时被删除的源文件
  // 自然掉出统计，纯删除/移动重构不再因"改了 N 个源文件零测试"误拦。
  if (testPresenceGateEnabled() && input.changedFiles.length > 0) {
    const exists = input.fileExists ?? ((f: string) => existsSync(resolve(input.cwd, f)))
    const presentFiles = input.changedFiles.filter(f => {
      try { return exists(f) } catch { return false }
    })
    const presence = evaluateTestPresence(presentFiles)
    if (!presence.ok) {
      checks.push({
        command: 'test-presence',
        status: 'unverifiable',
        detail: presence.detail,
        blocking: true,
      })
    } else if (presence.sourceFiles.length > 0) {
      checks.push({ command: 'test-presence', status: 'passed' })
    }
  }

  const run = input.runCommand ?? defaultRunCommand
  for (const command of input.commands) {
    if (!isRunnableVerifyCommand(command)) {
      checks.push({ command, status: 'unverifiable', detail: '非白名单验证命令形状——请人工执行确认' })
      continue
    }
    const res = await run(input.cwd, command)
    checks.push({ command, status: res.ok ? 'passed' : 'failed', detail: res.detail })
  }

  return {
    wave: input.wave,
    passed: checks.every(c => c.status !== 'failed' && !(c.blocking && c.status !== 'passed')),
    checks,
    changedFiles: input.changedFiles,
    commands: input.commands,
    checkedAt: Date.now(),
  }
}

/** 渲染门禁结果（工具输出/拦截信息用）。 */
export function formatWaveGate(record: WaveGateRecord): string[] {
  const lines = [`波间门禁 (wave ${record.wave + 1}): ${record.passed ? '✅ 通过' : '❌ 未通过'}`]
  for (const c of record.checks) {
    const icon = c.status === 'passed' ? '✅' : c.status === 'failed' ? '❌' : '❓'
    lines.push(`  ${icon} ${c.command}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  return lines
}
