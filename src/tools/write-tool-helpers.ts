/**
 * Write Tool Helpers — 所有写工具的共享常量和内容提取函数。
 *
 * 单一事实来源：四个编辑工具（edit_file / write_file / hash_edit / ast_edit）
 * 各有不同的输入 schema，但三个检测器（dead-end-detector、probe-detector、
 * external-claim-tracking-hook）都需要"文件路径 + 写入内容"。
 * 与其各处各自维护写工具列表和提取逻辑，不如集中到这里。
 *
 * ast_edit 的输入与另外三个不同：
 *   - 不是单 file_path，而是 paths: string[]
 *   - 不是单 new_string/content，而是 ops: [{ find, replace }, ...]
 *   - dryRun: true 时不实际写盘，返回空数组
 *
 * apply_patch 语义完全不同（输入是 diff 文件路径，非目标文件路径），
 * 只列入 WRITE_TOOL_NAMES 供路径提取使用，不做内容提取。
 */

/** 所有写工具名（供各检测器引用，替代各自的 EDIT_TOOLS / WRITE_TOOLS） */
export const WRITE_TOOL_NAMES = new Set([
  'edit_file',
  'write_file',
  'hash_edit',
  'ast_edit',
  'apply_patch',
])

/** 四编辑工具（不含 apply_patch，其语义不同） */
const EDIT_TOOLS_WITH_CONTENT = new Set([
  'edit_file',
  'write_file',
  'hash_edit',
  'ast_edit',
])

export interface WriteFileContent {
  filePath: string
  content: string
}

/**
 * 从 ast_edit 的 input 中提取 (filePath, content) 列表。
 * dryRun 时返回空数组（不实际写盘）。
 */
function extractAstEditContents(input: Record<string, unknown>): WriteFileContent[] {
  const ops = input.ops
  const paths = input.paths
  const dryRun = input.dryRun === true

  if (dryRun) return []
  if (!Array.isArray(ops) || !Array.isArray(paths) || paths.length === 0 || ops.length === 0) {
    return []
  }

  const results: WriteFileContent[] = []
  for (const filePath of paths) {
    if (typeof filePath !== 'string') continue
    for (const op of ops) {
      if (typeof op?.replace !== 'string') continue
      results.push({ filePath, content: op.replace })
    }
  }
  return results
}

/**
 * 从任意写工具的 input 中提取 (文件路径, 写入内容) 列表。
 *
 * - ast_edit: 返回多个条目（paths × ops），dryRun 返回空
 * - edit_file / hash_edit: 从 new_string + file_path 提取
 * - write_file: 从 content + file_path 提取
 * - apply_patch: 返回空（语义不同，不做内容提取）
 * - 非写工具或无法提取时返回空数组
 */
export function extractWriteContents(
  toolName: string,
  input: Record<string, unknown> | undefined,
): WriteFileContent[] {
  if (!input || !EDIT_TOOLS_WITH_CONTENT.has(toolName)) return []

  if (toolName === 'ast_edit') {
    return extractAstEditContents(input)
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  if (!filePath) return []

  let content: string | null = null
  if (toolName === 'write_file' && typeof input.content === 'string') {
    content = input.content
  } else if ((toolName === 'edit_file' || toolName === 'hash_edit') && typeof input.new_string === 'string') {
    content = input.new_string
  }

  if (content === null) return []
  return [{ filePath, content }]
}

/**
 * 从任意写工具的 input 中提取文件路径列表（不需要内容时用）。
 * 如 dead-end-detector 只需知道哪些文件被编辑过，不需要内容。
 *
 * - ast_edit: 返回 input.paths（dryRun 也返回——预览也需要标记 editPending）
 * - apply_patch: 返回 input.path ?? input.file ?? []
 * - 其余: 返回 [input.file_path]
 */
export function extractWriteFilePaths(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string[] {
  if (!input || !WRITE_TOOL_NAMES.has(toolName)) return []

  if (toolName === 'ast_edit') {
    if (input.dryRun === true) return []
    const paths = input.paths
    if (!Array.isArray(paths)) return []
    return paths.filter((p): p is string => typeof p === 'string')
  }

  // apply_patch: input 是 diff 文件路径（非目标文件），best-effort 提取
  if (toolName === 'apply_patch') {
    const p = input.path ?? input.file
    if (typeof p === 'string') return [p]
    return []
  }

  const fp = input.file_path
  return typeof fp === 'string' ? [fp] : []
}
