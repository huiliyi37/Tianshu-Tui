import { z } from 'zod'

export const mcpServerConfigSchema = z.object({
  // stdio fields
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  // SSE fields
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  // shared
  disabled: z.boolean().optional(),
}).refine(
  (v) => {
    const hasCommand = 'command' in v && v.command
    const hasUrl = 'url' in v && v.url
    return (hasCommand && !hasUrl) || (!hasCommand && hasUrl)
  },
  { message: 'MCP server must have either "command" (stdio) or "url" (SSE), but not both' },
)

export const mcpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
  timeoutMs: z.number().int().positive().optional(),
})

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>
export type McpConfig = z.infer<typeof mcpConfigSchema>
