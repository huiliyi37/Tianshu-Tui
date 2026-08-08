/**
 * 事件触发器监听器——file-change / git-push。
 *
 * 监听文件系统变更与 git 引用变化，命中时经 CronScheduler.fireByEvent()
 * 触发对应的定时任务。仅在 sidecar owner（抢到 CronLock）时活跃，多进程
 * 不重复 fire。
 *
 * 设计取舍（v1）：
 * - 监听目标在 startEventTriggers 时扫描快照确定。任务增删后需重启 sidecar
 *   才更新监听集合——动态 add/remove watcher 留待 v2。
 * - fs.watch 不可靠（尤其 Linux），用 debounce（500ms）+ recursive 选项
 *   尽量收敛；watcher 出错静默重建。
 * - git-push 监听 .git/HEAD 引用文件变更（含 checkout 与 fetch/push 导致的
 *   HEAD 移动），debounce 后 fire。spec 存分支名时按 spec 匹配。
 */
import { watch, type FSWatcher } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import type { CronScheduler } from './cron-scheduler.js'
import { serverLogger } from './logger.js'

const FILE_CHANGE_DEBOUNCE_MS = 500
const GIT_PUSH_DEBOUNCE_MS = 1000

interface EventTriggerState {
  watchers: FSWatcher[]
  timers: Map<string, ReturnType<typeof setTimeout>>
  gitHeads: Map<string, string> // repo path → last known HEAD ref content
}

let state: EventTriggerState | null = null

/** 启动事件触发器监听。扫描 scheduler 当前任务，为 file-change / git-push
 *  类型注册 watcher。可重复调用（先 stop 再 start）。 */
export function startEventTriggers(scheduler: CronScheduler, cwd: string): void {
  stopEventTriggers()
  const tasks = scheduler.list()
  const fileChangeTargets = new Set<string>()
  const gitPushRepos = new Set<string>()

  for (const task of tasks) {
    if (task.trigger.type === 'file-change') {
      // spec 是相对 cwd 的路径（或绝对路径）；空 spec=监听整个 cwd。
      const target = task.trigger.spec.trim()
        ? resolve(cwd, task.trigger.spec.trim())
        : cwd
      fileChangeTargets.add(target)
    } else if (task.trigger.type === 'git-push') {
      // git-push 监听 cwd 的 .git/HEAD（最常见场景）；多仓库场景留待 v2。
      gitPushRepos.add(cwd)
    }
  }

  const watchers: FSWatcher[] = []
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const gitHeads = new Map<string, string>()

  // ── file-change: fs.watch ──
  for (const target of fileChangeTargets) {
    if (!existsSync(target)) continue
    try {
      const w = watch(target, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        const fullPath = join(target, String(filename))
        const rel = relative(cwd, fullPath) || String(filename)
        debounce(timers, `fc:${target}`, FILE_CHANGE_DEBOUNCE_MS, () => {
          const n = scheduler.fireByEvent('file-change', { spec: rel })
          if (n > 0) serverLogger.info(`file-change trigger fired ${n} task(s) for ${rel}`)
        })
      })
      watchers.push(w)
    } catch (err) {
      serverLogger.warn(`file-change watcher failed for ${target}`, { error: String(err) })
    }
  }

  // ── git-push: 监听 .git/HEAD ──
  for (const repo of gitPushRepos) {
    const headPath = join(repo, '.git', 'HEAD')
    if (!existsSync(headPath)) continue
    try {
      const initContent = readFileSync(headPath, 'utf8').trim()
      gitHeads.set(headPath, initContent)
      const w = watch(headPath, () => {
        debounce(timers, `gp:${headPath}`, GIT_PUSH_DEBOUNCE_MS, () => {
          let newContent: string
          try { newContent = readFileSync(headPath, 'utf8').trim() } catch { return }
          const old = gitHeads.get(headPath)
          if (old === newContent) return
          gitHeads.set(headPath, newContent)
          // 解析当前分支（HEAD 内容形如 "ref: refs/heads/main"）
          const branch = newContent.startsWith('ref: refs/heads/')
            ? newContent.slice('ref: refs/heads/'.length)
            : ''
          const n = scheduler.fireByEvent('git-push', branch ? { spec: branch } : undefined)
          if (n > 0) serverLogger.info(`git-push trigger fired ${n} task(s) (branch=${branch || 'detached'})`)
        })
      })
      watchers.push(w)
    } catch (err) {
      serverLogger.warn(`git-push watcher failed for ${repo}`, { error: String(err) })
    }
  }

  state = { watchers, timers, gitHeads }
  if (watchers.length > 0) {
    serverLogger.info(`event triggers started: ${fileChangeTargets.size} file-change, ${gitPushRepos.size} git-push watcher(s)`)
  }
}

/** 停止所有事件触发器监听，释放 watcher 资源。 */
export function stopEventTriggers(): void {
  if (!state) return
  for (const w of state.watchers) { try { w.close() } catch { /* ignore */ } }
  for (const t of state.timers.values()) clearTimeout(t)
  state = null
}

/** focus-change 事件触发——由前端 Tauri window event 经 HTTP API 调入。
 *  单独导出（不经 startEventTriggers），因为触发时机由前端控制。 */
export function fireFocusChange(scheduler: CronScheduler): number {
  return scheduler.fireByEvent('focus-change')
}

function debounce(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  key: string,
  ms: number,
  fn: () => void,
): void {
  const existing = timers.get(key)
  if (existing) clearTimeout(existing)
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    fn()
  }, ms))
}

/** 用于测试：解析相对/绝对路径为监听目标（不注册 watcher）。 */
export function resolveFileChangeTarget(spec: string, cwd: string): string {
  return isAbsolute(spec) ? spec : resolve(cwd, spec)
}
