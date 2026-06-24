import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import { didYouMeanHint } from './did-you-mean.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /** Names of every registered tool, sorted for stable did-you-mean hints. */
  getAllNames(): string[] {
    return Array.from(this.tools.keys()).sort()
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll()
      .filter(t => t.isEnabled())
      .map(t => t.definition)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async execute(name: string, params: ToolCallParams): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      // Session 6176a17f history: LLM hallucinated `task` (Cursor/Claude Code
      // convention) instead of `delegate_task`. The bare "Unknown tool: task"
      // message was unhelpful — the next model turn had to guess the real
      // name from memory. Surfacing a did-you-mean hint + the full tool
      // catalog turns the failure into a learnable signal.
      const hint = didYouMeanHint(name, this.getAllNames())
      // EXTENDED-layer guidance comes first so the did-you-mean hint — whose
      // trailing "Available tools: a, b, c" is the model's positive anchor (and
      // the prefix-cache-stable sorted catalog) — stays the final section. The
      // previous order glued "…cIf this is an EXTENDED…" together, polluting both
      // readability and the catalog parse.
      throw new Error(`Unknown tool: ${name}. If this is an EXTENDED-layer tool, use delegate_task to dispatch a worker, or /tools enable <name> to mount it on the primary agent. ${hint}`)
    }
    if (!tool.isEnabled()) throw new Error(`Tool ${name} is disabled`)
    return tool.execute(params)
  }

  needsApproval(name: string, params: ToolCallParams): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    return tool.requiresApproval(params)
  }
}

export function filterToolRegistry(source: ToolRegistry, allowedNames: readonly string[]): ToolRegistry {
  const filtered = new ToolRegistry()
  for (const name of allowedNames) {
    const tool = source.get(name)
    if (!tool) throw new Error(`Cannot allowlist unknown tool: ${name}`)
    filtered.register(tool)
  }
  return filtered
}
