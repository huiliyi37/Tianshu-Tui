import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { JobRegistry } from '../../tools/job-store.js'

/**
 * Background-Jobs Hook — preTurn awareness nudge.
 *
 * When bash(run_in_background) has live jobs (dev servers, watchers, installs),
 * the model can forget they exist and either (a) act on results that are not
 * ready yet or (b) start a duplicate. Each turn with running jobs we inject a
 * compact status line so the model remembers to `job(await, id)` before it
 * depends on a background result.
 *
 * Cheap + prefix-safe: routed through the advisory bus (system-reminder channel,
 * ttl=1) — never rewrites the frozen prefix. Emits nothing when no job is running.
 */
export interface BackgroundJobsHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  getJobs: () => JobRegistry | undefined
}

/** Cap listed jobs to keep the reminder a single short block. */
const MAX_LISTED = 5

function fmtElapsed(startedAt: number): string {
  const s = Math.round((Date.now() - startedAt) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

export function createBackgroundJobsHook(deps: BackgroundJobsHookDeps): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'background-jobs',
    run(_ctx: RuntimeHookContext) {
      const jobs = deps.getJobs()
      if (!jobs) return
      const running = jobs.list().filter((j) => j.status === 'running')
      if (running.length === 0) return

      const lines = running.slice(0, MAX_LISTED).map((j) => {
        const tail = j.lastLine ? ` — 尾: ${j.lastLine}` : ''
        return `  [${j.id}] ${j.command} · 运行 ${fmtElapsed(j.startedAt)}${tail}`
      })
      const extra = running.length > MAX_LISTED ? `\n  …另有 ${running.length - MAX_LISTED} 个` : ''

      deps.advisoryBus.submit({
        key: 'background-jobs',
        priority: 0.6,
        category: 'background',
        tier: 'operational',
        content:
          `后台任务运行中 (${running.length}):\n${lines.join('\n')}${extra}\n` +
          `依赖其输出/结果前先 job(action="await", id=..., pattern="Ready|listening|compiled")；不再需要用 job(action="kill", id=...)。`,
        ttl: 1,
      })
    },
  }
}
