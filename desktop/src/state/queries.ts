import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  abortSession,
  approvePlan,
  closeSession,
  conveneCouncil,
  createSchedule,
  createSession,
  deleteSchedule,
  deleteSession,
  getEnvironment,
  getHealth,
  getGithubPr,
  getGithubPrDiff,
  submitGithubPrReview,
  getHooks,
  getPlan,
  getFileDiff,
  getWorkingTree,
  listArtifacts,
  listConfigProviders,
  listDomains,
  listGithubPrs,
  listPlans,
  listSchedule,
  listSessions,
  listTasks,
  cancelTask,
  pauseSchedule,
  rejectPlan,
  updatePlan,
  renameSession,
  sendArtifactFeedback,
  sendPrompt,
  setDomain,
  setHooks,
  setPlanMode,
  unarchiveSession,
  type PrReviewInput,
} from '../runtime/client'
import type { HookEntry, PlanModeState } from '../runtime/types'

// Server state lives in TanStack Query: sessions/health poll on an interval,
// artifacts refetch on demand (driven by artifact events). UI state is separate
// (state/store.tsx). Components never call the client directly.

export const qk = {
  health: ['health'] as const,
  environment: ['environment'] as const,
  sessions: ['sessions'] as const,
  artifacts: (id: string | null) => ['artifacts', id] as const,
  plans: (id: string | null) => ['plans', id] as const,
  plan: (id: string | null, slug: string | null) => ['plan', id, slug] as const,
  domains: (id: string | null) => ['domains', id] as const,
  hooks: (id: string | null) => ['hooks', id] as const,
  schedule: ['schedule'] as const,
  tasks: ['tasks'] as const,
  githubPrs: ['github', 'prs'] as const,
  githubPr: (n: number) => ['github', 'pr', n] as const,
  githubPrDiff: (n: number) => ['github', 'pr', n, 'diff'] as const,
  configProviders: ['config', 'providers'] as const,
  workingTree: (sessionId: string) => ['git', 'working-tree', sessionId] as const,
  fileDiff: (path: string, sessionId: string) => ['git', 'diff', sessionId, path] as const,
}

export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: getHealth,
    refetchInterval: 4000,
    retry: false,
  })
}

export function useEnvironment() {
  return useQuery({
    queryKey: qk.environment,
    queryFn: getEnvironment,
    refetchInterval: 30000,
    retry: false,
  })
}

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: listSessions,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    retry: false,
  })
}

export function useArtifacts(sessionId: string | null, rev: number) {
  return useQuery({
    queryKey: [...qk.artifacts(sessionId), rev],
    queryFn: () => (sessionId ? listArtifacts(sessionId) : Promise.resolve([])),
    enabled: !!sessionId,
  })
}

/** List the star-domain picker entries for a session (Auto / built-in & custom). */
export function useDomains(sessionId: string | null) {
  return useQuery({
    queryKey: qk.domains(sessionId),
    queryFn: () => (sessionId ? listDomains(sessionId) : Promise.resolve([])),
    enabled: !!sessionId,
  })
}

export function useSetDomain() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, key }: { id: string; key: string }) => setDomain(id, key),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: qk.domains(id) })
      qc.invalidateQueries({ queryKey: qk.sessions })
    },
  })
}

export function useConveneCouncil() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, artifactId, rounds }: { id: string; artifactId: string; rounds?: number }) =>
      conveneCouncil(id, { artifactId, rounds }),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: qk.artifacts(id) })
    },
  })
}

/** I4 — read the user-defined .rivet/hooks.json config for a session. */
export function useHooks(sessionId: string | null) {
  return useQuery({
    queryKey: qk.hooks(sessionId),
    queryFn: () => (sessionId ? getHooks(sessionId) : Promise.resolve({ hooks: [] })),
    enabled: !!sessionId,
  })
}

/** I4 — write the user-defined .rivet/hooks.json config for a session. */
export function useSetHooks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, hooks }: { id: string; hooks: HookEntry[] }) => setHooks(id, hooks),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: qk.hooks(id) })
    },
  })
}

// ── Plan mode ───────────────────────────────────────────────────────

/**
 * List this session's plans + active draft; re-fetches when `rev` (planRev)
 * bumps. Draft liveness is event-driven: the server emits throttled
 * `plan_draft` invalidation signals on every draft write (bumping planRev).
 * While planning, a slow poll remains as a degraded fallback for SSE gaps
 * (reconnect windows); outside planning the query is purely event-driven.
 */
export function usePlans(sessionId: string | null, rev: number, planning = false) {
  return useQuery({
    queryKey: [...qk.plans(sessionId), rev],
    queryFn: () => (sessionId ? listPlans(sessionId) : Promise.resolve({ plans: [], draft: null })),
    enabled: !!sessionId,
    refetchInterval: planning ? 10_000 : false,
  })
}

/** Fetch one plan's full markdown content. */
export function usePlan(sessionId: string | null, slug: string | null, rev: number) {
  return useQuery({
    queryKey: [...qk.plan(sessionId, slug), rev],
    queryFn: () => (sessionId && slug ? getPlan(sessionId, slug) : Promise.resolve(null)),
    enabled: !!sessionId && !!slug,
  })
}

export function useSetPlanMode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, state }: { id: string; state: PlanModeState }) => setPlanMode(id, state),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useApprovePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, slug, selectedApproach }: { id: string; slug: string; selectedApproach?: string }) =>
      approvePlan(id, slug, selectedApproach),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: qk.plans(id) })
      qc.invalidateQueries({ queryKey: qk.sessions })
    },
    // 服务端结构化拒绝（空计划 422 / 运行中 409 / 选项无效）带人类可读原因。
    onError: (err) => toast.error(`Build 失败：${(err as Error).message}`),
  })
}

export function useRejectPlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, slug, comment }: { id: string; slug: string; comment?: string }) =>
      rejectPlan(id, slug, comment),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: qk.plans(id) })
      qc.invalidateQueries({ queryKey: qk.sessions })
    },
  })
}

/** Edit a submitted plan's markdown before approval (review → tweak → Build). */
export function useUpdatePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, slug, content }: { id: string; slug: string; content: string }) =>
      updatePlan(id, slug, content),
    onSuccess: (_d, { id, slug }) => {
      qc.invalidateQueries({ queryKey: qk.plans(id) })
      qc.invalidateQueries({ queryKey: qk.plan(id, slug) })
    },
    onError: (err) => toast.error(`保存失败：${(err as Error).message}`),
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useSendPrompt() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, prompt, images }: { id: string; prompt: string; images?: string[] }) => sendPrompt(id, prompt, images),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
    // 失败时弹 toast：旧实现 fire-and-forget，发消息失败用户完全无感知，以为发出去了。
    // 这是核心操作的静默丢失——toast 至少让用户知道失败了，配合 ThreadView 的回填可重发。
    onError: (err: unknown, vars) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`发送失败：${msg}`, {
        description: '消息未发出，输入内容已保留，可重试',
        duration: 6000,
      })
      // 通知 ThreadView 回填输入内容（通过自定义事件，避免改 onSend 签名影响 40+ 调用点）
      window.dispatchEvent(new CustomEvent('send-prompt-failed', { detail: { prompt: vars.prompt } }))
    },
  })
}

export function useAbortSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => abortSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useCloseSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => closeSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useUnarchiveSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unarchiveSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useRenameSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameSession(id, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  })
}

export function useArtifactFeedback() {
  return useMutation({
    mutationFn: ({
      id,
      artifactId,
      comment,
      lines,
    }: {
      id: string
      artifactId: string
      comment: string
      lines?: ReadonlyArray<import('../runtime/types.js').LineComment>
    }) => sendArtifactFeedback(id, artifactId, comment, lines),
  })
}

// ── Schedule (N3) ───────────────────────────────────────────────────

export function useSchedule() {
  return useQuery({ queryKey: qk.schedule, queryFn: listSchedule, refetchInterval: 5000 })
}

export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.schedule }),
  })
}

export function usePauseSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => pauseSchedule(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.schedule }),
  })
}

export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.schedule }),
  })
}

/** All task execution records (polled). Automations dashboard filters by
 *  scheduledTaskId client-side. */
export function useTasks() {
  return useQuery({ queryKey: qk.tasks, queryFn: listTasks, refetchInterval: 5000 })
}

export function useCancelTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => cancelTask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  })
}

// ── GitHub PR ───────────────────────────────────────────────────────

export function useGithubPrs() {
  return useQuery({
    queryKey: qk.githubPrs,
    queryFn: listGithubPrs,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

export function useGithubPr(number: number | null) {
  return useQuery({
    queryKey: qk.githubPr(number ?? 0),
    queryFn: () => (number ? getGithubPr(number) : Promise.reject()),
    enabled: !!number,
  })
}

/** Fetch a PR's full unified diff on demand (when a PR is selected). */
export function useGithubPrDiff(number: number | null) {
  return useQuery({
    queryKey: qk.githubPrDiff(number ?? 0),
    queryFn: () => (number ? getGithubPrDiff(number) : Promise.reject()),
    enabled: !!number,
    staleTime: 30_000,
  })
}

/** Submit a PR review; refresh PR detail + list so the new verdict/comments show. */
export function useSubmitPrReview(number: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PrReviewInput) => {
      if (!number) return Promise.reject(new Error('No PR selected'))
      return submitGithubPrReview(number, input)
    },
    onSuccess: () => {
      if (number) qc.invalidateQueries({ queryKey: qk.githubPr(number) })
      qc.invalidateQueries({ queryKey: qk.githubPrs })
    },
  })
}

// ── Config: Providers ───────────────────────────────────────────────

export function useConfigProviders() {
  return useQuery({
    queryKey: qk.configProviders,
    queryFn: listConfigProviders,
    staleTime: 10_000,
  })
}

// ── Git: Working Tree (changes tab) ─────────────────────────────────

/** Poll the working-tree change list, scoped to the active session (worktree
 *  cwd + task baseline). Diff changes less often than session state, so 5s
 *  (vs sessions' 2s) is a reasonable cadence. Disabled when no active session. */
export function useWorkingTree(sessionId: string | null) {
  const enabled = sessionId !== null
  return useQuery({
    queryKey: qk.workingTree(sessionId ?? ''),
    queryFn: () => getWorkingTree(sessionId!),
    refetchInterval: enabled ? 5000 : false,
    enabled,
    staleTime: 2000,
  })
}

/** Fetch a single file's unified diff on demand (when the user selects it). */
export function useFileDiff(path: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: qk.fileDiff(path ?? '', sessionId ?? ''),
    queryFn: () => getFileDiff(path!, sessionId!),
    enabled: path !== null && sessionId !== null,
    staleTime: 3000,
  })
}
