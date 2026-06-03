import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import { extractBullets, shouldRunREM, detectCrossSessionPatterns, suppressStalePatterns } from '../playbook.js'
import type { RetrospectInput } from '../retrospect.js'
import { generateRetrospect } from '../retrospect.js'
import type { PlaybookStore } from '../playbook-store.js'
import type { DoomLoopLevel } from '../trace-store.js'
import type { SessionRegistry } from '../session-registry.js'
import { buildRetrospectFingerprint } from '../retrospect-fingerprint.js'

export interface PlaybookReflectHookDeps {
  store: PlaybookStore
  buildRetrospectInput: () => RetrospectInput
  getDoomLoopLevel: () => DoomLoopLevel
  /** SessionRegistry 实例，用于跨 session 指纹存储 */
  registry?: SessionRegistry
  /** 当前 session ID */
  sessionId?: string
}

export function createPlaybookReflectHook(deps: PlaybookReflectHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'playbook-reflect',
    run(ctx) {
      const { vigor, sensorium } = ctx.snapshot
      if (!vigor || !sensorium) return

      // 计算 sessionCount（用于 shouldRunREM 门控）
      const sessionCount = deps.registry
        ? deps.registry.loadFingerprints(100).length
        : 0

      const remMode = shouldRunREM(vigor, sensorium, deps.getDoomLoopLevel(), sessionCount)

      if (remMode === 'skip') return

      // 轻量模式：只做指纹存储 + 模式检测（跳过 retrospect 生成）
      if (remMode === 'light') {
        if (!deps.registry || !deps.sessionId) return

        // 加载历史指纹
        const historical = deps.registry.loadFingerprints(10, deps.sessionId)
        if (historical.length === 0) return

        // 构建空指纹（无 retrospect 报告）
        const fingerprint = buildRetrospectFingerprint(deps.sessionId, '', [], {
          now: Date.now(),
        })

        // 存储指纹
        deps.registry.storeFingerprint(fingerprint)

        // 加载现有 bullets
        const existingBullets = deps.store.load()

        // 执行模式检测（检查历史指纹之间的相似性）
        const allFingerprints = [fingerprint, ...historical]
        const patternBullets = detectCrossSessionPatterns(fingerprint, historical, existingBullets)

        // 抑制 stale 模式
        const updatedBullets = suppressStalePatterns(deps.store.load(), allFingerprints)
        deps.store.save(updatedBullets)

        ctx.effects.emitPhaseChange('playbook-reflect', {
          reason: 'REM light mode: pattern detection only',
          suggestion: `${patternBullets.length} pattern(s) detected`,
        })
        return
      }

      // 完整模式：retrospect + 模式检测
      const report = generateRetrospect(deps.buildRetrospectInput())
      const bullets = extractBullets(report)

      // 构建 fingerprint
      const fingerprint = buildRetrospectFingerprint(
        deps.sessionId ?? 'unknown',
        report,
        bullets,
        { now: Date.now() },
      )

      // 存储 fingerprint
      if (deps.registry && deps.sessionId) {
        deps.registry.storeFingerprint(fingerprint)
      }

      // 加载历史指纹
      const historical = deps.registry && deps.sessionId
        ? deps.registry.loadFingerprints(10, deps.sessionId)
        : []

      // 执行模式检测
      const existingBullets = deps.store.load()
      const patternBullets = detectCrossSessionPatterns(fingerprint, historical, existingBullets)

      // 合并 bullets
      const allBullets = [...bullets, ...patternBullets]
      if (allBullets.length === 0) return

      deps.store.addBullets(allBullets)

      // 抑制 stale 模式
      if (deps.registry && deps.sessionId) {
        const allFingerprints = [fingerprint, ...historical]
        const updatedBullets = suppressStalePatterns(deps.store.load(), allFingerprints)
        deps.store.save(updatedBullets)
      }

      ctx.effects.emitPhaseChange('playbook-reflect', {
        reason: 'difficult session reflected',
        suggestion: `${bullets.length} lesson(s) + ${patternBullets.length} pattern(s) stored`,
      })
    },
  }
}
