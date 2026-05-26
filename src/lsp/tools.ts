import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import type { LspManager } from './manager.js'

function resolveParams(input: Record<string, unknown>): { filePath: string; line: number; column: number } | string {
  const filePath = input.file_path as string | undefined
  if (!filePath || typeof filePath !== 'string') return 'Missing required parameter: file_path'
  const line = input.line as number | undefined
  if (typeof line !== 'number' || line < 1) return 'Missing or invalid parameter: line (must be >= 1)'
  const column = input.column as number | undefined
  if (typeof column !== 'number' || column < 0) return 'Missing or invalid parameter: column (must be >= 0)'
  return { filePath, line, column }
}

export function createGotoDefinitionTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_goto_definition',
      description:
        'Go to the definition of a symbol at the given file location. ' +
        'Returns the file path, line, and column of the definition. ' +
        'Use this to understand where a function, class, variable, or type is defined.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the source file containing the symbol' },
          line: { type: 'number', description: 'Line number (1-based) where the symbol is located' },
          column: { type: 'number', description: 'Column number (0-based) where the symbol is located' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.gotoDefinition(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No definition found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} definition(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return manager.isReady() && manager.supportsDefinition()
    },
  }
}

export function createFindReferencesTool(manager: LspManager): Tool {
  return {
    definition: {
      name: 'lsp_find_references',
      description:
        'Find all references to a symbol at the given file location. ' +
        'Returns a list of file paths, lines, and columns where the symbol is used. ' +
        'Use this to understand the impact of changing a function, class, or variable.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the source file containing the symbol' },
          line: { type: 'number', description: 'Line number (1-based) where the symbol is located' },
          column: { type: 'number', description: 'Column number (0-based) where the symbol is located' },
        },
        required: ['file_path', 'line', 'column'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const resolved = resolveParams(params.input)
      if (typeof resolved === 'string') {
        return { content: resolved, isError: true }
      }

      const locations = await manager.findReferences(
        resolved.filePath,
        resolved.line,
        resolved.column,
      )

      if (locations.length === 0) {
        return {
          content: `No references found for symbol at ${resolved.filePath}:${resolved.line}:${resolved.column}`,
        }
      }

      const formatted = locations.map(loc => {
        const displayLine = loc.range.start.line + 1
        const displayCol = loc.range.start.character
        return `${loc.uri}:${displayLine}:${displayCol}`
      }).join('\n')

      return {
        content: `${locations.length} reference(s) found:\n${formatted}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return manager.isReady() && manager.supportsReferences()
    },
  }
}
