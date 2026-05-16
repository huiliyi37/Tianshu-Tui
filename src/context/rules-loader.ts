import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaimProposal } from './claims.js'

const MAX_RULE_LENGTH = 500

export function loadProjectRules(cwd: string, sessionId: string): ClaimProposal[] {
  const rulesDir = join(cwd, '.rivet', 'rules')
  if (!existsSync(rulesDir)) return []

  const files = readdirSync(rulesDir).filter(f => f.endsWith('.md'))
  const now = Date.now()
  const proposals: ClaimProposal[] = []

  for (const file of files) {
    const content = readFileSync(join(rulesDir, file), 'utf-8').trim()
    if (!content) continue

    proposals.push({
      kind: 'project_rule',
      scope: 'project',
      text: content.slice(0, MAX_RULE_LENGTH),
      confidence: 1.0,
      fitness: 10,
      source: { actor: 'user', sessionId, turn: 0, eventId: `rules:${file}` },
      evidence: [{ id: `rules:${file}`, kind: 'file', summary: `project rule from .rivet/rules/${file}`, path: join(rulesDir, file), createdAt: now }],
      createdAt: now,
      tags: ['project_rule', file.replace('.md', '')],
    })
  }

  return proposals
}
