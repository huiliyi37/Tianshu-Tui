import type { WorkOrder } from './work-order.js'

const MEMORY_KEYWORDS = [
  'memory',
  'recall',
  'project-memory',
  'project memory',
  'memory.jsonl',
  'manifest',
  'prompt',
  'volatile',
]

const MEMORY_PATH_MARKERS = [
  'src/context/',
  'src/prompt/',
  'src/tools/recall.ts',
  '.rivet/knowledge/',
]

export function needsMemoryKnowledgePacket(order: Pick<WorkOrder, 'objective' | 'scope'>): boolean {
  const objective = order.objective.toLowerCase()
  if (MEMORY_KEYWORDS.some(keyword => objective.includes(keyword))) return true

  const files = order.scope.files ?? []
  return files.some(file => MEMORY_PATH_MARKERS.some(marker => file.includes(marker)))
}

export function buildMemoryKnowledgePacket(): string {
  return [
    '## Required Knowledge Packet: memory / prompt / recall',
    '',
    'This task touches project memory, prompt construction, or recall behavior. Before making claims or recommendations, inspect the relevant retrieval map and code paths.',
    '',
    'Must read / inspect:',
    '- .rivet/knowledge/manifest.md',
    '- docs/analysis/2026-06-01-project-memory-architecture-conflict.md',
    '- docs/superpowers/plans/2026-06-01-project-memory-system.md',
    '- docs/superpowers/plans/2026-06-01-guided-memory-retrieval.md',
    '- src/context/project-memory-loader.ts',
    '- src/tools/recall.ts',
    '',
    'Known constraints:',
    '- .rivet/knowledge/project-memory.md is curated Markdown and recall-only; do not recommend full prompt injection.',
    '- .rivet/knowledge/memory.jsonl is local structured cache and must not be committed.',
    '- Tier 1 injection is restricted to decision/project_rule/user_constraint with confidence >= 0.9 and a 2K char budget.',
    '- Tier 2 entries are searched through recall, not injected into every prompt.',
    '- If evidence contradicts these constraints, report the contradiction with file paths instead of guessing.',
  ].join('\n')
}
