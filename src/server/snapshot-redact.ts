/**
 * P1-4 — local redaction for read-only session snapshots.
 *
 * Runs BEFORE the snapshot leaves the machine (export) so shared files carry
 * `<redacted:kind>` placeholders instead of live secrets. The scan is
 * best-effort regex heuristics — callers must still review the exported file.
 */

export interface RedactionResult {
  text: string
  findings: number
}

interface Pattern {
  kind: string
  re: RegExp
}

const PATTERNS: Pattern[] = [
  { kind: 'api_key', re: /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g },
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'openssh_private', re: /\bssh-(?:rsa|ed25519|ecdsa)[A-Za-z0-9+/=]{16,}\b/g },
  { kind: 'password', re: /(?:^|[_\s])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi },
  { kind: 'ssh_path', re: /(?:~|\/Users\/[^/\s]+)\/\.ssh\/[^\s"']+/g },
]

/** Redact one text blob. Returns the redacted text and the number of findings. */
export function redactSnapshotText(raw: string): RedactionResult {
  let text = raw
  let findings = 0
  for (const p of PATTERNS) {
    text = text.replace(p.re, () => {
      findings++
      return `<redacted:${p.kind}>`
    })
  }
  return { text, findings }
}

/** Redact arbitrary scalar/object trees in-place-safe (returns a deep copy). */
export function redactSnapshotValue<T>(value: T): { value: T; findings: number } {
  let findings = 0
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const r = redactSnapshotText(node)
      findings += r.findings
      return r.text
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v)
      return out
    }
    return node
  }
  return { value: walk(value) as T, findings }
}
