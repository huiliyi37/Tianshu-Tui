/**
 * Rule generator — auto-create .rivet/rules/*.md when observations repeat 3+ times.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { countSimilarMemoryEntries } from './unified-memory.js'

const REPEAT_THRESHOLD = 3

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'auto-rule'
}

export function maybeGenerateRule(cwd: string, observationText: string): string | null {
  const count = countSimilarMemoryEntries(cwd, observationText)
  if (count < REPEAT_THRESHOLD) return null

  const rulesDir = join(cwd, '.rivet', 'rules')
  const slug = slugify(observationText)
  const rulePath = join(rulesDir, `auto-${slug}.md`)

  if (existsSync(rulePath)) return null

  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true })

  const content = `---
source: auto-generated
observations: ${count}
---

${observationText.trim()}
`
  writeFileSync(rulePath, content, 'utf-8')
  return rulePath
}

export function processObservationForRuleGeneration(cwd: string, observationText: string): string | null {
  return maybeGenerateRule(cwd, observationText)
}
