import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { JobSnapshot } from './job-store.js'

/** Cap for an await's blocking window so a runaway pattern never hangs the loop. */
const MAX_AWAIT_MS = 600_000
const DEFAULT_AWAIT_MS = 120_000

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

function fmtStatus(job: JobSnapshot): string {
  if (job.status === 'running') return 'running'
  if (job.status === 'killed') return `killed${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}`
  return `exited (${job.exitCode ?? '?'})`
}

function fmtLine(job: JobSnapshot): string {
  const elapsed = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt)
  const head = `[${job.id}] ${fmtStatus(job)} · ${elapsed} · ${job.command}`
  return job.lastLine ? `${head}\n    └ ${job.lastLine}` : head
}

export const JOB_TOOL: Tool = {
  definition: {
    name: 'job',
    description: `Inspect and control background jobs started by bash(run_in_background).

Actions:
- list: show all background jobs for this session (status, elapsed, last output line).
- await: block until a job exits, its output matches \`pattern\` (regex), or \`timeout\` elapses. Use this before depending on a background result (e.g. wait for a dev server "Ready" or an install to finish).
- logs: return the captured output of a job.
- kill: terminate a running job.`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'await', 'logs', 'kill'], description: 'What to do' },
        id: { type: 'string', description: 'Job id (required for await/logs/kill)' },
        pattern: { type: 'string', description: 'await only: regex matched against output; resolves early on a hit (e.g. "Ready|listening|compiled")' },
        timeout: { type: 'integer', description: 'await only: max ms to block (default 120000, max 600000)' },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const jobs = params.jobs
    if (!jobs) {
      return { content: '后台任务系统在当前上下文不可用（无会话）。请直接前台运行命令。', isError: false }
    }
    const action = String(params.input.action ?? '')
    const id = params.input.id != null ? String(params.input.id) : ''

    switch (action) {
      case 'list': {
        const list = jobs.list()
        if (list.length === 0) return { content: '当前没有后台任务。', uiContent: '后台任务: 0', isError: false }
        const body = list.map(fmtLine).join('\n')
        const running = list.filter((j) => j.status === 'running').length
        return { content: `后台任务 (${list.length}，运行中 ${running}):\n${body}`, uiContent: `后台任务: ${list.length} (运行 ${running})`, isError: false }
      }

      case 'await': {
        if (!id) return { content: 'await 需要 id 参数。', isError: true }
        const pattern = params.input.pattern != null ? String(params.input.pattern) : undefined
        const timeoutMs = Math.min(Number(params.input.timeout) || DEFAULT_AWAIT_MS, MAX_AWAIT_MS)
        const result = await jobs.await(id, { pattern, timeoutMs })
        if (!result) return { content: `未找到任务 ${id}。用 job(action="list") 查看。`, isError: true }
        const { job, matched, timedOut, tail } = result
        const verdict = matched
          ? `✓ 输出命中 pattern`
          : timedOut
            ? `⏱ 等待超时（${fmtDuration(timeoutMs)}），任务仍在运行`
            : `● 任务已${job.status === 'killed' ? '被终止' : '退出'} (exit ${job.exitCode ?? '?'})`
        const header = `[${job.id}] ${verdict} · ${fmtStatus(job)}`
        return {
          content: tail ? `${header}\n── 输出尾部 ──\n${tail}` : header,
          uiContent: `await ${job.id}: ${matched ? '命中' : timedOut ? '超时' : fmtStatus(job)}`,
          isError: false,
        }
      }

      case 'logs': {
        if (!id) return { content: 'logs 需要 id 参数。', isError: true }
        const logs = jobs.logs(id)
        if (logs == null) return { content: `未找到任务 ${id}。`, isError: true }
        return { content: logs || '(无输出)', uiContent: `logs ${id}`, isError: false }
      }

      case 'kill': {
        if (!id) return { content: 'kill 需要 id 参数。', isError: true }
        const ok = jobs.kill(id)
        return { content: ok ? `已发送终止信号给任务 ${id}。` : `未找到任务 ${id}。`, uiContent: `kill ${id}`, isError: !ok }
      }

      default:
        return { content: `未知 action: ${action}。可用: list / await / logs / kill。`, isError: true }
    }
  },

  requiresApproval(): boolean {
    return false
  },

  // await blocks intentionally; give the pipeline headroom beyond the await window.
  timeoutMs(params?: ToolCallParams): number {
    if (params?.input?.action === 'await') {
      const t = Math.min(Number(params.input.timeout) || DEFAULT_AWAIT_MS, MAX_AWAIT_MS)
      return t + 30_000
    }
    return 120_000
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
