import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll()
      .filter(t => t.isEnabled())
      .map(t => t.definition)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async execute(name: string, params: ToolCallParams): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    if (!tool.isEnabled()) throw new Error(`Tool ${name} is disabled`)
    return tool.execute(params)
  }

  needsApproval(name: string, params: ToolCallParams): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    return tool.requiresApproval(params)
  }
}
