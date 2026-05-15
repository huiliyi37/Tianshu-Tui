import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { Tool, ToolCallParams } from './types.js'
import { validatePath } from './path-validate.js'

export const EDIT_FILE_TOOL: Tool = {
  definition: {
    name: 'edit_file',
    description: `Perform exact string replacements in existing files.

### Usage
- Read the file first before editing
- old_string must be unique in the file — include surrounding context if needed
- Preserve exact indentation (tabs/spaces) from the file
- Use replace_all to replace every occurrence of old_string
- Prefer editing existing files over creating new ones

### Examples
Good: reading the file, finding the exact string with surrounding context, then replacing
Bad: editing without reading the file first
Bad: using a too-short old_string that matches multiple locations`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to replace (must be unique in the file)' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default: false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },

  async execute(params: ToolCallParams) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string)
    } catch {
      return { content: 'Error: Path escapes project directory', isError: true }
    }
    if (!existsSync(filePath)) {
      return { content: `Error: File not found: ${filePath}`, isError: true }
    }

    const content = readFileSync(filePath, 'utf-8')
    const oldString = params.input.old_string as string
    const newString = params.input.new_string as string
    const replaceAll = (params.input.replace_all as boolean) ?? false

    if (replaceAll) {
      if (!content.includes(oldString)) {
        return { content: `Error: old_string not found in file: ${filePath}`, isError: true }
      }
      const newContent = content.replaceAll(oldString, newString)
      writeFileSync(filePath, newContent, 'utf-8')
      const occurrences = (content.match(new RegExp(escapeRegExp(oldString), 'g')) || []).length
      return { content: `Replaced all ${occurrences} occurrences in ${filePath}` }
    }

    const firstIndex = content.indexOf(oldString)
    if (firstIndex === -1) {
      return { content: `Error: old_string not found in file: ${filePath}`, isError: true }
    }
    const secondIndex = content.indexOf(oldString, firstIndex + 1)
    if (secondIndex !== -1) {
      return {
        content: `Error: old_string matches multiple locations in ${filePath}. Use replace_all=true or include more surrounding context to make old_string unique.`,
        isError: true,
      }
    }

    const newContent = content.replace(oldString, newString)
    writeFileSync(filePath, newContent, 'utf-8')
    return { content: `Applied edit to ${filePath}` }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
