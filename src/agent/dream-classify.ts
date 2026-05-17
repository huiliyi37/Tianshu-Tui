export type KnowledgeTopic = 'testing' | 'infra' | 'prompt' | 'ui' | 'agent' | 'tools' | 'general'

const TOPIC_PATTERNS: Array<{ topic: KnowledgeTopic; patterns: RegExp[] }> = [
  { topic: 'testing', patterns: [/\btest|spec|__tests__/i] },
  { topic: 'infra', patterns: [/tsconfig|package\.json|\.config\.|Dockerfile|ci\//i] },
  { topic: 'prompt', patterns: [/src\/prompt|src\/compact|src\/context/i] },
  { topic: 'ui', patterns: [/src\/tui|\.tsx|cockpit|panel/i] },
  { topic: 'agent', patterns: [/src\/agent|loop|coordinator|dream/i] },
  { topic: 'tools', patterns: [/src\/tools/i] },
]

export function classifyEntry(entry: string): KnowledgeTopic {
  const filesLine = entry.match(/\*\*Modified\*\*[^:]*:\s*(.+)/)?.[1] ?? ''
  const files = filesLine.split(',').map(f => f.trim())

  const scores = new Map<KnowledgeTopic, number>()
  for (const file of files) {
    for (const { topic, patterns } of TOPIC_PATTERNS) {
      if (patterns.some(p => p.test(file))) {
        scores.set(topic, (scores.get(topic) ?? 0) + 1)
      }
    }
  }

  if (scores.size === 0) return 'general'
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted[0]!
  if (top[1] >= Math.ceil(files.length / 2)) return top[0]
  return 'general'
}
