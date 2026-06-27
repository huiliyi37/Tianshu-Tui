import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  abortSession,
  approvePlan,
  closeSession,
  createSchedule,
  createSession,
  deleteSchedule,
  getHealth,
  getGithubPr,
  getPlan,
  getFileDiff,
  getWorkingTree,
  listArtifacts,
  listConfigProviders,
  listGithubPrs,
  listPlans,
  listSchedule,
  listSessions,
  pauseSchedule,
  rejectPlan,
  sendArtifactFeedback,
  sendPrompt,
  setPlanMode,
  unarchiveSession,
} from '../runtime/client'
import type { PlanModeState } from '../runtime/types'

// Server state lives in TanStack Query: sessions/health poll on an interval,
// artifacts refetch on demand (driven by artifact events). UI state is separate
// (state/store.tsx). Components never call the client directly.

export const qk = {
  health: ['health'] as const,
  sessions: ['sessions'] as const,
  artifacts: (id: string | null) => ['artifacts', id] as const,
  plans: (id: string | null) => ['plans', id] as const,
  plan: (id: string | null, slug: string | null) => ['plan', id, slug] as const,
  schedule: ['schedule'] as const,
  githubPrs: ['github', 'prs'] as const,
  githubPr: (n: number) => ['github', 'pr', n] as const,
  configProviders: ['config', 'providers'] as const,
  workingTree: ['git', 'working-tree'] as const,
  fileDiff: (path: string) => ['git', 'diff', path] as const,
}

export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: getHealth,
    refetchInterval: 4000,
    retry: false,
  })
}

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: listSessions,
    refetchInterval: 2000,
  })
}

export function useArtifacts(sessionId: string | null, rev: number) {
  return useQuery({
    queryKey: [...qk.artifacts(sessionId), rev],
    queryFn: () => (sessionId ? listArtifacts(sessionId) : Promise.resolve([])),
    enabled: !!sessionId,
  })
}

// ── Plan mode ───────────────────────────────────────────────────────

/** List this session's plans; re-fetches when `rev` (planRev) bumps. */
export function usePlans(sessionId: string | null, rev: number) {
  return useQuery({
    queryKey: [...qk.plans(sessionId), rev],
    queryFn: () => (sessionId ? listPlans(sessionId) : Promise.resolve([])),
    enabled: !!sessionId,
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
    mutationFn: ({ id, slug }: { id: string; slug: string }) => approvePlan(id, slug),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: qk.plans(id) })
      qc.invalidateQueries({ queryKey: qk.sessions })
    },
  })
}

export function useRejectPlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, slug, comment }: { id: string; slug: string; comment?: string }) =>
      rejectPlan(id, slug, comment),
    onSuccess: (_d, { id }) => qc.invalidateQueries({ queryKey: qk.plans(id) }),
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

export function useArtifactFeedback() {
  return useMutation({
    mutationFn: ({ id, artifactId, comment }: { id: string; artifactId: string; comment: string }) =>
      sendArtifactFeedback(id, artifactId, comment),
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

// ── Config: Providers ───────────────────────────────────────────────

export function useConfigProviders() {
  return useQuery({
    queryKey: qk.configProviders,
    queryFn: listConfigProviders,
    staleTime: 10_000,
  })
}

// ── Git: Working Tree (changes tab) ─────────────────────────────────

/** Poll the working-tree change list. Diff changes less often than session
 *  state, so 5s (vs sessions' 2s) is a reasonable cadence. Disabled when no
 *  active session, since the cwd is session-scoped. */
export function useWorkingTree(enabled: boolean) {
  return useQuery({
    queryKey: qk.workingTree,
    queryFn: getWorkingTree,
    refetchInterval: enabled ? 5000 : false,
    enabled,
    staleTime: 2000,
  })
}

/** Fetch a single file's unified diff on demand (when the user selects it). */
export function useFileDiff(path: string | null) {
  return useQuery({
    queryKey: qk.fileDiff(path ?? ''),
    queryFn: () => getFileDiff(path!),
    enabled: path !== null,
    staleTime: 3000,
  })
}
