export type ReadPolicyKind = 'source' | 'log' | 'jsonl' | 'generated' | 'minified' | 'unknown'
export type ReadPolicyAction = 'full' | 'full-with-hint' | 'partial' | 'preview' | 'reject-with-range'

export interface ReadPolicyInput {
  filePath: string
  sizeBytes: number
  hasExplicitRange: boolean
}

export interface ReadPolicyDecision {
  kind: ReadPolicyKind
  action: ReadPolicyAction
  reason: string
  previewLines: number
  maxRangeLines: number
}

const LOG_PREVIEW_GUARD_BYTES = 16 * 1024
const DEFAULT_PREVIEW_LINES = 80
const DEFAULT_MAX_RANGE_LINES = 200

/** ~20KB — source files below this are returned in full without hints. */
const SOURCE_SMALL_BYTES = 20 * 1024

/** ~80KB — source files above this get PARTIAL view (first page only). */
const SOURCE_LARGE_BYTES = 80 * 1024

function classifyPath(filePath: string): ReadPolicyKind {
  const lower = filePath.toLowerCase()
  if (/\.(?:jsonl|ndjson)(?:\.\d+)?$/.test(lower)) return 'jsonl'
  if (/\.(?:log|out|err|trace)(?:\.\d+)?$/.test(lower)) return 'log'
  if (/\.min\.(?:js|css)$/.test(lower)) return 'minified'
  if (/(?:^|\/)(?:dist|build|coverage|\.next)\//.test(lower)) return 'generated'
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml)$/.test(lower)) return 'source'
  return 'unknown'
}

export function decideReadPolicy(input: ReadPolicyInput): ReadPolicyDecision {
  const kind = classifyPath(input.filePath)
  const base = { kind, previewLines: DEFAULT_PREVIEW_LINES, maxRangeLines: DEFAULT_MAX_RANGE_LINES }

  if (input.hasExplicitRange) {
    return { ...base, action: 'full', reason: 'explicit range requested' }
  }
  if ((kind === 'log' || kind === 'jsonl') && input.sizeBytes > LOG_PREVIEW_GUARD_BYTES) {
    return { ...base, action: 'preview', reason: 'log-like file over preview guard' }
  }
  if (kind === 'generated' || kind === 'minified') {
    return { ...base, action: 'reject-with-range', reason: 'generated or minified file requires an explicit range' }
  }

  if (kind === 'source' || kind === 'unknown') {
    if (input.sizeBytes > SOURCE_LARGE_BYTES) {
      return { ...base, action: 'partial', reason: 'large source file — returning first page with navigation hints' }
    }
    if (input.sizeBytes > SOURCE_SMALL_BYTES) {
      return { ...base, action: 'full-with-hint', reason: 'medium source file — full read with editing hints' }
    }
  }

  return { ...base, action: 'full', reason: 'safe default read' }
}
