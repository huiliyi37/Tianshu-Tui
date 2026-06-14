/**
 * Constellation store — read/write/append for `.rivet/constellation.json`.
 *
 * Append is idempotent (dedup by milestone/shift id) and bounded: once the
 * in-file milestone list exceeds MILESTONE_CAP, the oldest entries roll off to
 * `.rivet/constellation.archive.jsonl` (one JSON object per line) so history is
 * never lost but the working file stays small and git-diff friendly.
 */
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import {
  normalizeConstellation,
  createConstellation,
  emptySkeleton,
  shortHash,
  MILESTONE_CAP,
  type ProjectConstellation,
  type Milestone,
  type ArchitectureShift,
  type Skeleton,
} from './schema.js'

export function constellationDir(cwd: string): string {
  return join(cwd, '.rivet')
}
export function constellationPath(cwd: string): string {
  return join(constellationDir(cwd), 'constellation.json')
}
export function archivePath(cwd: string): string {
  return join(constellationDir(cwd), 'constellation.archive.jsonl')
}

/** Stable project id derived from the absolute path. */
function deriveProjectId(cwd: string): string {
  return shortHash(cwd)
}

/**
 * Lightweight, bounded skeleton survey: top-level `src/*` directories as
 * modules, common entry points, and a tech-stack guess from package.json. No
 * deep recursion — just enough to seed a useful blueprint cheaply.
 */
export function surveySkeleton(cwd: string): Skeleton {
  const sk = emptySkeleton()
  const srcDir = join(cwd, 'src')
  if (existsSync(srcDir)) {
    try {
      for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('__')) {
          sk.modules.push({ path: `src/${entry.name}` })
        }
      }
    } catch {
      /* ignore unreadable src */
    }
  }
  for (const ep of ['src/main.tsx', 'src/main.ts', 'src/index.ts', 'index.ts', 'index.js']) {
    if (existsSync(join(cwd, ep))) sk.entryPoints.push(ep)
  }
  try {
    const pkgPath = join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      const known = ['react', 'ink', 'typescript', 'vite', 'next', 'express', 'fastify']
      sk.techStack = known.filter(d => d in deps)
    }
  } catch {
    /* ignore malformed package.json */
  }
  return sk
}

export function loadConstellation(cwd: string): ProjectConstellation | null {
  const p = constellationPath(cwd)
  if (!existsSync(p)) return null
  try {
    return normalizeConstellation(JSON.parse(readFileSync(p, 'utf-8')))
  } catch {
    return null
  }
}

export function saveConstellation(cwd: string, c: ProjectConstellation, now = Date.now()): void {
  c.lastUpdatedAt = now
  writeFileAtomicSync(constellationPath(cwd), JSON.stringify(c, null, 2) + '\n')
}

/** Load existing constellation or mint a fresh minimal one (no skeleton yet). */
function loadOrCreate(cwd: string, now: number): ProjectConstellation {
  return (
    loadConstellation(cwd) ??
    createConstellation({ projectId: deriveProjectId(cwd), name: basename(cwd) || 'project', now })
  )
}

function appendArchive(cwd: string, entries: Milestone[]): void {
  if (entries.length === 0) return
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  appendFileSync(archivePath(cwd), lines, 'utf-8')
}

/**
 * Append a milestone. Idempotent by id (a re-run of the same session close is a
 * no-op). Auto-creates the constellation if absent so capture works before an
 * explicit `init`. Returns the persisted constellation.
 */
export function appendMilestone(cwd: string, milestone: Milestone, now = Date.now()): ProjectConstellation {
  const c = loadOrCreate(cwd, now)
  if (c.milestones.some(m => m.id === milestone.id)) return c
  c.milestones.push(milestone)
  if (c.milestones.length > MILESTONE_CAP) {
    const overflow = c.milestones.splice(0, c.milestones.length - MILESTONE_CAP)
    appendArchive(cwd, overflow)
  }
  saveConstellation(cwd, c, now)
  return c
}

export function appendArchitectureShift(
  cwd: string,
  shift: ArchitectureShift,
  now = Date.now(),
): ProjectConstellation {
  const c = loadOrCreate(cwd, now)
  if (c.architectureShifts.some(s => s.id === shift.id)) return c
  c.architectureShifts.push(shift)
  saveConstellation(cwd, c, now)
  return c
}

/** Diff two skeletons into the additive/subtractive fields of a shift. */
export function diffSkeleton(prev: Skeleton, next: Skeleton): {
  addedModules: string[]
  removedModules: string[]
  addedEntryPoints: string[]
  removedEntryPoints: string[]
  changed: boolean
} {
  const prevModules = new Set(prev.modules.map(m => m.path))
  const nextModules = new Set(next.modules.map(m => m.path))
  const prevEntries = new Set(prev.entryPoints)
  const nextEntries = new Set(next.entryPoints)
  const addedModules = [...nextModules].filter(m => !prevModules.has(m))
  const removedModules = [...prevModules].filter(m => !nextModules.has(m))
  const addedEntryPoints = [...nextEntries].filter(e => !prevEntries.has(e))
  const removedEntryPoints = [...prevEntries].filter(e => !nextEntries.has(e))
  return {
    addedModules,
    removedModules,
    addedEntryPoints,
    removedEntryPoints,
    changed:
      addedModules.length + removedModules.length + addedEntryPoints.length + removedEntryPoints.length > 0,
  }
}

/**
 * Initialize (or re-survey) the project skeleton. If a constellation already
 * exists and the skeleton changed, records an ArchitectureShift capturing the
 * diff. Returns the persisted constellation.
 */
export function initConstellation(
  cwd: string,
  input: { name?: string; skeleton: Skeleton; sessionId?: string; shiftSummary?: string },
  now = Date.now(),
): ProjectConstellation {
  const existing = loadConstellation(cwd)
  if (!existing) {
    const c = createConstellation({
      projectId: deriveProjectId(cwd),
      name: input.name ?? basename(cwd) ?? 'project',
      skeleton: input.skeleton,
      now,
    })
    saveConstellation(cwd, c, now)
    return c
  }

  const diff = diffSkeleton(existing.skeleton, input.skeleton)
  if (diff.changed) {
    existing.architectureShifts.push({
      id: shortHash(`${input.sessionId ?? 'manual'}:${now}:shift`),
      timestamp: now,
      sessionId: input.sessionId ?? '',
      summary: input.shiftSummary ?? 'skeleton re-surveyed',
      addedModules: diff.addedModules,
      removedModules: diff.removedModules,
      addedEntryPoints: diff.addedEntryPoints,
      removedEntryPoints: diff.removedEntryPoints,
    })
  }
  existing.skeleton = input.skeleton
  if (input.name) existing.name = input.name
  saveConstellation(cwd, existing, now)
  return existing
}
