import { getToolFamily, type ToolFamily } from '../../../src/tui/tool-family.js'

export type { ToolFamily }

/**
 * 桌面端工具家族默认展开阈值（行数）。
 *
 * 对齐 TUI 策略：短输出默认展开，长输出默认折叠，避免长结果霸占线程。
 *   - run:   8 行（bash / run_tests / delegate 等命令输出）
 *   - find:  6 行（grep / glob / repo_map 等搜索结果）
 *   - write: 20 行（write_file / edit_file / apply_patch 等 diff）
 *   - read:  8 行（read_file / file_info 等文件内容）
 *   - other: 4 行（todo / ask_user_question 等）
 */
export function getToolFamilyDefaultLines(toolName: string): number {
  const family = getToolFamily(toolName).family
  switch (family) {
    case 'run':
      return 8
    case 'find':
      return 6
    case 'write':
      return 20
    case 'read':
      return 8
    case 'other':
      return 4
    default:
      return 4
  }
}

/**
 * 根据工具家族阈值决定该工具结果是否默认展开。
 *
 * @param toolName  工具名
 * @param lineCount 结果正文行数（去掉尾部空行后）
 * @returns         行数 ≤ 阈值时返回 true（默认展开）
 */
export function shouldDefaultOpen(toolName: string, lineCount: number): boolean {
  return lineCount <= getToolFamilyDefaultLines(toolName)
}
