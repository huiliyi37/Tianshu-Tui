export interface ImportEdge {
  from: string
  to: string
}

const IMPORT_RE = /^import(?:\s+type)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/gm

export function buildImportEdgesFromText(file: string, text: string): ImportEdge[] {
  const edges: ImportEdge[] = []
  let match: RegExpExecArray | null
  while ((match = IMPORT_RE.exec(text)) !== null) {
    const target = match[1]!
    if (target.startsWith('.')) edges.push({ from: file, to: target })
  }
  return edges
}
