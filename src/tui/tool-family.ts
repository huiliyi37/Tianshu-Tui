export type ToolFamily = 'read' | 'write' | 'run' | 'find' | 'other'

export interface ToolFamilyInfo {
  family: ToolFamily
  glyph: string
  verb: string
}

const TOOL_MAP: Record<string, ToolFamilyInfo> = {
  read_file:       { family: 'read',  glyph: '◇', verb: 'read'     },
  glob:            { family: 'find',  glyph: '◎', verb: 'find'     },
  grep:            { family: 'find',  glyph: '◎', verb: 'search'   },
  bash:            { family: 'run',   glyph: '▶', verb: 'run'      },
  edit_file:       { family: 'write', glyph: '◈', verb: 'patch'    },
  write_file:      { family: 'write', glyph: '◈', verb: 'write'    },
  run_tests:       { family: 'run',   glyph: '▶', verb: 'test'     },
  delegate_task:   { family: 'run',   glyph: '▶', verb: 'delegate' },
  delegate_batch:  { family: 'run',   glyph: '▶', verb: 'batch'    },
  git:             { family: 'run',   glyph: '▶', verb: 'git'      },
  undo:            { family: 'write', glyph: '◈', verb: 'undo'     },
  web_fetch:       { family: 'read',  glyph: '◇', verb: 'fetch'    },
  inspect_project: { family: 'find',  glyph: '◎', verb: 'inspect'  },
  repo_map:        { family: 'find',  glyph: '◎', verb: 'map'      },
  todo:            { family: 'other', glyph: '•', verb: 'todo'     },
  recall:          { family: 'find',  glyph: '◎', verb: 'recall'   },
  ask_user_question: { family: 'other', glyph: '?', verb: 'ask'    },
}

const DEFAULT: ToolFamilyInfo = { family: 'other', glyph: '•', verb: 'tool' }

export function getToolFamily(toolName: string): ToolFamilyInfo {
  return TOOL_MAP[toolName] ?? DEFAULT
}

export function getGroupSummary(tools: ReadonlyArray<{ toolName?: string }>): string {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const name = t.toolName ?? 'unknown'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([name, count]) => `${name} x${count}`)
  const total = tools.length
  const label = total === 1 ? 'tool call' : 'tool calls'
  return `${total} ${label}: ${parts.join(', ')}`
}
