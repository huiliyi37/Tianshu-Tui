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

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
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

/** 可直接执行的验证命令白名单形状（测试/编译/类型检查）。 */
const RUNNABLE_VERIFY_RE = /^\s*(npx?\s+(tsc|vitest|jest|tsx)\b|npm\s+(test\b|run\s+\S+)|pnpm\s+(test\b|run\s+\S+)|yarn\s+(test\b|run\s+\S+)|node\s+--test\b|cargo\s+(test|check)\b|go\s+(test|vet|build)\b|pytest\b|python\s+-m\s+pytest\b|make\s+(test|check)\b)/

export function isRunnableVerifyCommand(command: string): boolean {
  return RUNNABLE_VERIFY_RE.test(command)
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
  /** 测试钩子：命令执行器。缺省 spawnSync sh -c。 */
  runCommand?: (cwd: string, command: string) => { ok: boolean; detail?: string }
  /** 测试钩子：文件存在性判定。缺省 existsSync(resolve(cwd, f))。 */
  fileExists?: (relPath: string) => boolean
}

function defaultRunCommand(cwd: string, command: string): { ok: boolean; detail?: string } {
  try {
    const res = spawnSync(command, { cwd, shell: true, encoding: 'utf-8', timeout: 300_000 })
    if (res.status === 0) return { ok: true }
    const tail = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n')
    return { ok: false, detail: tail.slice(0, 500) }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
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
    const res = run(input.cwd, command)
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
