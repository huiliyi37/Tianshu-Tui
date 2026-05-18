import type { RepairPass, RepairContext, RepairResult } from './repair-pipeline.js'

export const fourHorsemenPass: RepairPass = {
  name: 'four-horsemen',
  run(input: Record<string, unknown>, ctx: RepairContext): RepairResult {
    let applied = false
    const required = new Set(ctx.schema?.required ?? [])
    const props = ctx.schema?.properties ?? {}

    // Fix 1: null → omit for optional fields
    const step1: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (value === null && !required.has(key)) {
        applied = true
        continue
      }
      step1[key] = value
    }

    // Fixes 2-4: per-field array coercion
    const result = { ...step1 }
    for (const [key, value] of Object.entries(result)) {
      const fieldSchema = props[key] as { type?: string } | undefined
      if (fieldSchema?.type !== 'array' || Array.isArray(value)) continue

      // Fix 2: JSON array string → actual array
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed)
            if (Array.isArray(parsed)) { result[key] = parsed; applied = true; continue }
          } catch { /* not valid JSON */ }
        }
      }

      // Fix 3: numeric-keyed object → array
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value as Record<string, unknown>)
        if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
          result[key] = keys.sort((a, b) => +a - +b).map(k => (value as Record<string, unknown>)[k]!)
          applied = true
          continue
        }
      }

      // Fix 4: bare string → single-element array
      if (typeof value === 'string') {
        result[key] = [value]
        applied = true
      }
    }

    return { output: result, applied, fixType: applied ? 'fourHorsemen' : undefined }
  },
}

const AUTO_LINK_RE = /\[([^\]]+)\]\(\s*(?:https?:\/\/)?\s*\S*?\b([^\s)]+)\s*\)/g

export function fixAutoLinks(str: string): { fixed: string; count: number } {
  let count = 0
  const fixed = str.replace(AUTO_LINK_RE, (match, linkText: string, urlPath: string) => {
    const cleanPath = linkText.trim()
    const cleanUrl = urlPath.trim().replace(/^\/+/, '')
    if (cleanPath === cleanUrl || cleanUrl.endsWith(cleanPath)) {
      count++
      return cleanPath
    }
    return match
  })
  return { fixed, count }
}

function fixAutoLinksDeep(value: unknown): { fixed: unknown; count: number } {
  if (typeof value === 'string') return fixAutoLinks(value)
  if (Array.isArray(value)) {
    let total = 0
    const fixed = value.map(item => { const r = fixAutoLinksDeep(item); total += r.count; return r.fixed })
    return { fixed, count: total }
  }
  if (value && typeof value === 'object') {
    let total = 0
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const r = fixAutoLinksDeep(val)
      out[key] = r.fixed
      total += r.count
    }
    return { fixed: out, count: total }
  }
  return { fixed: value, count: 0 }
}

export const semanticRepairPass: RepairPass = {
  name: 'semantic-repair',
  run(input: Record<string, unknown>, _ctx: RepairContext): RepairResult {
    const r = fixAutoLinksDeep(input)
    if (r.count > 0) {
      return { output: r.fixed as Record<string, unknown>, applied: true, fixType: 'autoLink' }
    }
    return { output: input, applied: false }
  },
}
