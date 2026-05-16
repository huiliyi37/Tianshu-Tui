import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ContextClaimStore } from './claim-store.js'
import type { ContextClaim } from './claims.js'

export interface ClaimExportData {
  version: 1
  exportedAt: string
  claims: ContextClaim[]
}

export function exportDurableClaims(store: ContextClaimStore, outPath: string): number {
  const durable = store.listClaims({ status: ['durable', 'durable_candidate'] })
  const data: ClaimExportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    claims: durable,
  }

  const dir = dirname(outPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8')
  return durable.length
}

export function importClaims(store: ContextClaimStore, filePath: string): number {
  if (!existsSync(filePath)) return 0

  const raw = readFileSync(filePath, 'utf-8')
  const data = JSON.parse(raw) as ClaimExportData
  if (data.version !== 1 || !Array.isArray(data.claims)) return 0

  let imported = 0
  for (const claim of data.claims) {
    store.propose({
      kind: claim.kind,
      scope: claim.scope,
      text: claim.text,
      confidence: claim.confidence * 0.8,
      fitness: claim.fitness,
      source: { ...claim.source, eventId: `import:${claim.id}` },
      evidence: claim.evidence,
      createdAt: Date.now(),
      tags: [...(claim.tags ?? []), 'imported'],
    })
    imported++
  }
  return imported
}
