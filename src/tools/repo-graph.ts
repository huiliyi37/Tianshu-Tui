import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'
import { scheduleMeridianBackfill } from '../repo/meridian-backfill.js'

interface RepoGraphInput {
  from_file: string
  max_tokens?: number
  mode?: 'graph' | 'impact'
}

const DEFINITION: ToolDefinition = {
  name: 'repo_graph',
  description: `查询代码图，找出与给定文件存在结构关联的文件和符号。

### 模式
- **graph**（默认）：按调用/导入距离排序，返回带导出符号的相关文件排名。
- **impact**：返回改动该文件的爆炸半径——哪些文件依赖它、需要跑哪些测试。

### 何时使用
- 读完文件后，查它依赖什么、什么依赖它
- 编辑前，评估改动的爆炸半径（用 mode: "impact"）
- 沿结构连接在陌生代码中导航
- 编辑后，确认需要跑哪些测试（用 mode: "impact"）

### 工作原理
图随你读/写文件增量构建。读过的文件越多，图越完整。`,
  input_schema: {
    type: 'object',
    properties: {
      from_file: { type: 'string', description: '要查关联代码的文件路径（相对项目根）' },
      max_tokens: { type: 'number', default: 2000, description: '响应的 token 预算（控制返回多少文件）' },
      mode: { type: 'string', enum: ['graph', 'impact'], default: 'graph', description: '查询模式："graph" 查相关文件，"impact" 做爆炸半径分析' },
    },
    required: ['from_file'],
  },
}

export function createRepoGraphTool(getIndexer: () => MeridianIndexer | null): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const indexer = getIndexer()
      if (!indexer) {
        return { content: 'Meridian 图尚未初始化。请先读取一些文件以构建索引。', isError: true }
      }
      // First repo_* use: kick idle full-project backfill (no-op if already scheduled / lean / disabled).
      scheduleMeridianBackfill(indexer, params.cwd ?? process.cwd(), { reason: 'ondemand' })

      const input = params.input as unknown as RepoGraphInput
      const mode = input.mode ?? 'graph'

      if (mode === 'impact') {
        return executeImpact(indexer, input.from_file)
      }

      const result = await indexer.query(input.from_file, { maxTokens: input.max_tokens ?? 2000 })

      if (result.entries.length === 0) {
        return { content: `\`${input.from_file}\` 尚无图数据。请先读取该文件以建立索引。` }
      }

      const lines: string[] = [
        `## 代码图（起点 \`${input.from_file}\`）`,
        `索引：${result.graphSize} 个文件，${result.totalSymbols} 个符号`,
        '',
      ]

      for (const entry of result.entries) {
        lines.push(`### ${entry.filePath}（分数：${entry.score.toFixed(2)}）`)
        for (const sym of entry.symbols) {
          const prefix = sym.kind === 'function' ? 'ƒ' : sym.kind === 'class' ? '◆' : sym.kind === 'interface' || sym.kind === 'type' ? '◇' : '•'
          lines.push(`  ${prefix} ${sym.name} L${sym.line}`)
        }
        lines.push('')
      }

      const content = lines.join('\n')
      return { content: content.length > 15000 ? content.slice(0, 15000) + '\n...（已截断）' : content }
    },
    requiresApproval() { return false },
    isConcurrencySafe() { return true },
    isEnabled() { return true },
  }
}

function executeImpact(indexer: MeridianIndexer, filePath: string): ToolResult {
  const result = indexer.impact([filePath])

  if (result.totalImpact === 0 && result.tests.length === 0) {
    return { content: `\`${filePath}\` 尚无已知依赖方。图可能还需要索引更多文件。` }
  }

  const lines: string[] = [
    `## 影响分析：\`${filePath}\``,
    `受影响合计：${result.totalImpact} 个文件`,
    '',
  ]

  if (result.direct.length > 0) {
    lines.push(`### 直接依赖方（${result.direct.length}）`)
    for (const f of result.direct) lines.push(`- ${f}`)
    lines.push('')
  }

  if (result.transitive.length > 0) {
    lines.push(`### 传递依赖方（${result.transitive.length}）`)
    for (const f of result.transitive.slice(0, 20)) lines.push(`- ${f}`)
    if (result.transitive.length > 20) lines.push(`- ...（另有 ${result.transitive.length - 20} 个）`)
    lines.push('')
  }

  if (result.tests.length > 0) {
    lines.push(`### 应运行的测试（${result.tests.length}）`)
    for (const f of result.tests) lines.push(`- ${f}`)
    lines.push('')
  }

  return { content: lines.join('\n') }
}
