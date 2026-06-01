import type { ClaimProposal, ContextClaimKind, EvidenceKind } from './claims.js'

export interface ToolResultContext {
  toolName: string
  input: Record<string, unknown>
  result: string
  isError: boolean
}

export interface ClaimExtractionMeta {
  sessionId: string
  turn: number
  eventId: string
}

const TTL: Record<ContextClaimKind, number> = {
  file_observation: 30 * 60_000,
  verification_fact: 60 * 60_000,
  failure_pattern: 120 * 60_000,
  security_finding: 240 * 60_000,
  user_constraint: Infinity,
  user_preference: Infinity,
  decision: Infinity,
  worker_finding: 60 * 60_000,
  project_rule: Infinity,
}

const SKIP_TOOLS = new Set(['grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'recall'])

export function extractClaimsFromToolResult(ctx: ToolResultContext, meta: ClaimExtractionMeta, existingFileObservations?: Set<string>): ClaimProposal[] {
  if (SKIP_TOOLS.has(ctx.toolName)) return []
  if (ctx.result.length < 10) return []

  const now = Date.now()

  if (ctx.toolName === 'read_file' && !ctx.isError) {
    const path = String(ctx.input.file_path ?? '')
    if (existingFileObservations?.has(path)) return []
    return [fileObservation(ctx, meta, now)]
  }

  const isTestRun = ctx.toolName === 'run_tests'
    || (ctx.toolName === 'bash' && /test|jest|vitest|pytest/i.test(String(ctx.input.command ?? '')))

  if (isTestRun) {
    if (ctx.isError) return [failurePattern(ctx, meta, now)]
    if (/\d+\s*pass/i.test(ctx.result)) return [verificationFact(ctx, meta, now)]
    return []
  }

  if (ctx.toolName === 'bash' && ctx.isError && /vulnerabilit|CVE-|security|audit/i.test(ctx.result)) {
    return [securityFinding(ctx, meta, now)]
  }

  // Commit fact: extract hash + message as a decision claim (Infinity TTL via decision kind)
  const isCommitResult = (ctx.toolName === 'git' && String(ctx.input.action ?? '') === 'commit')
    || (ctx.toolName === 'deliver_task' && ctx.input.commit === true)
  if (isCommitResult && !ctx.isError) {
    return [commitFact(ctx, meta, now)]
  }

  return []
}

function fileObservation(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const path = String(ctx.input.file_path ?? '')
  const filename = path.split('/').pop() ?? path
  const lines = ctx.result.split('\n').length
  const symbols = extractSymbols(ctx.result)
  const text = symbols.length > 0
    ? `${filename} (${lines}L): ${symbols.slice(0, 8).join(', ')}`
    : `Read ${filename} (${lines} lines)`
  return {
    kind: 'file_observation',
    scope: 'session',
    text,
    confidence: 0.6,
    fitness: 2,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:read`, kind: 'tool_result' as EvidenceKind, summary: `read_file ${filename}`, path, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.file_observation,
    tags: ['tool', 'read_file'],
  }
}

const EXPORT_RE = /^(?:export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)|export\s+\{([^}]+)\})/gm

function extractSymbols(content: string): string[] {
  const symbols: string[] = []
  let match: RegExpExecArray | null
  EXPORT_RE.lastIndex = 0
  while ((match = EXPORT_RE.exec(content)) !== null) {
    if (match[1]) {
      symbols.push(match[1])
    } else if (match[2]) {
      for (const name of match[2].split(',')) {
        const trimmed = name.trim().split(/\s+as\s+/).pop()?.trim()
        if (trimmed) symbols.push(trimmed)
      }
    }
    if (symbols.length >= 10) break
  }
  return symbols
}

function failurePattern(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const summary = ctx.result.slice(0, 200).replace(/\n/g, ' ')
  return {
    kind: 'failure_pattern',
    scope: 'session',
    text: summary,
    confidence: 0.8,
    fitness: 5,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:fail`, kind: 'test' as EvidenceKind, summary, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.failure_pattern,
    tags: ['tool', 'test_failure'],
  }
}

function verificationFact(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const match = ctx.result.match(/(\d+)\s*pass/i)
  const text = match ? `Tests: ${match[1]} pass` : 'Tests passing'
  return {
    kind: 'verification_fact',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 3,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:verify`, kind: 'test' as EvidenceKind, summary: text, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.verification_fact,
    tags: ['tool', 'test_pass'],
  }
}

function securityFinding(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const summary = ctx.result.slice(0, 200).replace(/\n/g, ' ')
  return {
    kind: 'security_finding',
    scope: 'session',
    text: summary,
    confidence: 0.75,
    fitness: 6,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:security`, kind: 'tool_result' as EvidenceKind, summary, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.security_finding,
    tags: ['tool', 'security'],
  }
}

const COMMIT_HASH_RE = /\b([0-9a-f]{7,40})\b/

function commitFact(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const hashMatch = ctx.result.match(COMMIT_HASH_RE)
  const hash = hashMatch?.[1] ?? 'unknown'
  const message = String(ctx.input.message ?? '').slice(0, 80)
  // Extract file list from stat lines (--stat file rows contain '|'; excludes %h%d header + summary)
  const statLines = ctx.result.split('\n')
    .filter(l => l.includes('|'))
    .map(l => l.split('|')[0]!.trim())
    .filter(f => f.length > 0)
  const files = statLines.length > 0 ? statLines.slice(0, 5).join(', ') : 'unknown files'
  const text = `Commit ${hash}: "${message}" (${files})`
  return {
    kind: 'decision',
    scope: 'project',
    text,
    confidence: 0.95,
    fitness: 8,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:commit`, kind: 'tool_result' as EvidenceKind, summary: text, createdAt: now }],
    createdAt: now,
    // decision kind has TTL=Infinity in the TTL table — no expiresAt needed
    // commit_fact is intentionally recall-only in project-memory-loader: commit history is useful,
    // but ordinary commits should not auto-enter the Tier 1 prompt block.
    tags: ['tool', 'commit', 'git', 'commit_fact'],
  }
}
