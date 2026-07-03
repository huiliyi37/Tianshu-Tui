import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import { didYouMeanHint } from './did-you-mean.js'

/**
 * Foreign tool names from other agent frameworks (Cursor, Claude Code, etc.)
 * mapped to their Rivet equivalents. Transparent remapping avoids forcing
 * the model to memorize framework-specific tool names — the call just works.
 *
 * Key: foreign name (case-insensitive lookup).
 * Val: Rivet tool name.
 */
const FOREIGN_ALIASES: Record<string, string> = {
  todowrite: 'todo',
  task: 'delegate_task',
  agent: 'delegate_task',
}

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
    let tool = this.tools.get(name)
    let resolvedName = name
    let aliasNote: string | undefined

    // Transparent alias remapping: foreign tool names (Cursor/Claude Code
    // conventions) silently map to their Rivet equivalents. The model gets
    // the real tool result + a one-line prefix so it learns the correct name.
    if (!tool) {
      const aliasKey = FOREIGN_ALIASES[name.toLowerCase()]
      if (aliasKey) {
        tool = this.tools.get(aliasKey)
        if (tool) {
          resolvedName = aliasKey
          aliasNote = `[NOTE: "${name}" 自动映射为 "${aliasKey}" — 下次请直接调 ${aliasKey}]`
        }
      }
    }

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
    if (!tool.isEnabled()) throw new Error(`Tool ${resolvedName} is disabled`)

    const result = await tool.execute(params)
    if (aliasNote) {
      result.content = `${aliasNote}\n${result.content}`
    }
    return result
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
