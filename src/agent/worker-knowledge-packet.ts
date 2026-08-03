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
    '## 必需知识包（memory / prompt / recall 类任务）',
    '',
    '本任务涉及项目记忆、prompt 构造或召回行为。在提出论断或建议前，先检查相关的检索地图与代码路径。',
    '',
    '必须读/查：',
    '- .rivet/knowledge/manifest.md',
    '- docs/analysis/2026-06-01-project-memory-architecture-conflict.md',
    '- docs/superpowers/plans/2026-06-01-project-memory-system.md',
    '- docs/superpowers/plans/2026-06-01-guided-memory-retrieval.md',
    '- src/context/project-memory-loader.ts',
    '- src/tools/recall.ts',
    '',
    '已知约束：',
    '- .rivet/knowledge/project-memory.md 是人工整理的 Markdown、仅供召回；不要建议整段注入 prompt。',
    '- .rivet/knowledge/memory.jsonl 是本地结构化缓存，不得提交。',
    '- Tier 1 注入仅限 decision/project_rule/user_constraint 且 confidence >= 0.9，预算 2K 字符。',
    '- Tier 2 条目经 recall 检索，不注入每条 prompt。',
    '- 若证据与这些约束冲突，附文件路径报告冲突本身，不要臆测。',
  ].join('\n')
}
