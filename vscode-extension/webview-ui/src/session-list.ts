export interface SessionLite {
  id: string
  title?: string
  status?: string
  archived?: boolean
}

export function sessionLabel(s: SessionLite): string {
  const t = s.title?.trim()
  return t || s.id.slice(0, 8)
}

export function splitSessionLists(sessions: readonly SessionLite[]): { active: SessionLite[]; archived: SessionLite[] } {
  const active: SessionLite[] = []
  const archived: SessionLite[] = []
  for (const s of sessions) {
    if (s.archived) archived.push(s)
    else active.push(s)
  }
  return { active, archived }
}

export function filterSessions(sessions: readonly SessionLite[], query: string): SessionLite[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...sessions]
  return sessions.filter((s) => {
    const title = (s.title ?? '').toLowerCase()
    return title.includes(q) || s.id.toLowerCase().includes(q)
  })
}
