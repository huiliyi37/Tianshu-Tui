import type { TaskLedgerEvent } from './task-ledger.js'

export const KNOWLEDGE_MANIFEST_PATH = '.rivet/knowledge/manifest.md'

const SENSITIVE_PREFIXES = [
  'src/prompt/',
  'src/context/',
  '.rivet/knowledge/',
]

const SENSITIVE_EXACT_PATHS = new Set([
  'src/tools/recall.ts',
  'src/agent/dream.ts',
])

const SENSITIVE_AGENT_PREFIXES = [
  'src/agent/delivery-gate',
  'src/agent/ownership',
  'src/agent/verification',
]

export function normalizePreflightPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

export function isSensitivePreflightPath(path: string | undefined): boolean {
  if (!path) return false
  const normalized = normalizePreflightPath(path)
  return SENSITIVE_EXACT_PATHS.has(normalized)
    || SENSITIVE_PREFIXES.some(prefix => normalized.startsWith(prefix))
    || SENSITIVE_AGENT_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

export function hasKnowledgeManifestRead(events: readonly TaskLedgerEvent[]): boolean {
  return events.some(event =>
    event.type === 'file_read'
    && typeof event.path === 'string'
    && normalizePreflightPath(event.path) === KNOWLEDGE_MANIFEST_PATH,
  )
}

export function shouldRequireSensitivePreflight(input: {
  path?: string
  events?: readonly TaskLedgerEvent[]
}): boolean {
  if (!isSensitivePreflightPath(input.path)) return false
  return !hasKnowledgeManifestRead(input.events ?? [])
}

export function buildSensitivePreflightMessage(path: string): string {
  return [
    'Sensitive-area preflight required.',
    `Read ${KNOWLEDGE_MANIFEST_PATH} before editing ${normalizePreflightPath(path)}.`,
    'This protects prompt, memory, recall, verification, and ownership architecture decisions from context-free edits.',
  ].join(' ')
}
