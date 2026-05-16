import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaimProposal } from './claims.js'

const MAX_RULE_LENGTH = 500

export function loadProjectRules(cwd: string): ClaimProposal[] {
  const rulesDir = join(cwd, '.rivet', 'rules')
  if (!existsSync(rulesDir)) return []

  const now = Date.now()
  const proposals: ClaimProposal[] = []

  try {
    const files = readdirSync(rulesDir).filter(f => f.endsWith('.md'))

    for (const file of files) {
      try {
        const content = readFileSync(join(rulesDir, file), 'utf-8').trim()
        if (!content) continue

        proposals.push({
          kind: 'project_rule',
          scope: 'project',
          text: content.slice(0, MAX_RULE_LENGTH),
          confidence: 1.0,
          fitness: 10,
          source: { actor: 'user', sessionId: 'project', turn: 0, eventId: `rules:${file}` },
          evidence: [{ id: `rules:${file}`, kind: 'file', summary: `project rule from .rivet/rules/${file}`, path: join(rulesDir, file), createdAt: now }],
          createdAt: now,
          tags: ['project_rule', file.replace('.md', '')],
        })
      } catch {
        // skip unreadable rule files
      }
    }
  } catch {
    // readdirSync failed (permissions, etc.)
  }

  return proposals
}
