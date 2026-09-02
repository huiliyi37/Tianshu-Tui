/**
 * 项目授信启动提示 —— 配置加载前的 raw-stdin 单键确认。
 *
 * 设计动机：信任门（config/project-trust.ts）默认剥离未授信项目的安全敏感键，
 * 但此前只在 stderr 打一行通知——用户发现时机会话已过半，项目里配的
 * agent.approval 等键"神秘失效"。本提示在进入目录（bootstrap 之前、
 * loadConfig 消费项目配置之前）主动问一次，授信则**当次会话生效**，无需重启。
 *
 * 只在有真实赌注时出现（项目配置含敏感键或存在 .rivet/hooks.json）；
 * RIVET_TRUST_PROJECT env 覆盖、已授信、已选"不再提示"时完全跳过。
 */

import { type ProjectTrustStakes } from '../config/project-trust.js'

export type TrustPromptDecision = 'trust' | 'skip' | 'dismiss'

/** 单键映射（纯函数）：y=授信 n/Esc=暂不 d=本项目不再提示。 */
export function interpretTrustKey(ch: string): TrustPromptDecision | null {
  if (ch === 'y' || ch === 'Y') return 'trust'
  if (ch === 'n' || ch === 'N' || ch === '\x1B') return 'skip'
  if (ch === 'd' || ch === 'D') return 'dismiss'
  return null
}

/** 提示正文（纯函数，便于测试）。 */
export function buildTrustPromptText(stakes: ProjectTrustStakes): string {
  const lines: string[] = [
    '',
    '┌ 项目授信 — 检测到本项目带有需要信任才能生效的设置',
    '│',
  ]
  if (stakes.sensitiveKeys.length > 0) {
    lines.push(`│ .rivet-config.json 含安全敏感键：${stakes.sensitiveKeys.join('、')}`)
  }
  if (stakes.hasHooks) {
    lines.push('│ .rivet/hooks.json 存在（项目级 hooks）')
  }
  lines.push(
    '│',
    '│ 这些键可以更改审批模式、预授权命令、拉起进程、改写出方向——',
    '│ 按信任边界（SECURITY.md），仓库内容不能自我授权，需你显式授信。',
    '│ 授信记录存本机 ~/.rivet/project-trust.json，绝不写回仓库。',
    '│',
    '│ [y] 授信（当次会话生效）  [n] 暂不（下次启动再问）  [d] 本项目不再提示',
    '└',
    '',
  )
  return lines.join('\n')
}

/**
 * raw-stdin 单键读取。stdin 卫生与模板首启选择器同模式（main.ts 模板 picker）：
 * 结束后恢复 rawMode(false) + pause，不影响后续 bootstrap/TUI 接管。
 */
export async function promptProjectTrust(stakes: ProjectTrustStakes): Promise<TrustPromptDecision> {
  process.stderr.write(buildTrustPromptText(stakes))
  if (!process.stdin.isTTY) return 'skip'

  process.stdin.setRawMode(true)
  process.stdin.resume()
  let onData: ((chunk: Buffer) => void) | undefined
  try {
    return await new Promise<TrustPromptDecision>((resolve) => {
      onData = (chunk: Buffer) => {
        const decision = interpretTrustKey(chunk.toString())
        if (decision) resolve(decision)
      }
      process.stdin.on('data', onData)
    })
  } finally {
    if (onData) process.stdin.removeListener('data', onData)
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}
