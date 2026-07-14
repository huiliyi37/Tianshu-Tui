import { z } from 'zod'
import { mcpOAuthConfigSchema } from './oauth/types.js'

/** Transport hint — explicit opt-in for transport selection on url-based servers.
 *  `streamableHttp` (default when absent): use Streamable HTTP transport (post-2025-03-26 spec).
 *  `sse`: force legacy SSE transport (pre-2025 spec, deprecated but still in wide use).
 *  Ignored for stdio servers. */
export const transportHintSchema = z.enum(['streamableHttp', 'sse']).optional()

export const mcpServerConfigSchema = z.object({
  // stdio fields
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  // remote fields
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  /** Explicit transport selection (url-based servers). When unset, Streamable HTTP is
   *  preferred. Set to 'sse' to force legacy SSE transport. */
  transportHint: transportHintSchema,
  /** OAuth-based authentication for this server.
   *  When set, env/headers secrets are obtained via OAuth flow instead of manual entry. */
  auth: mcpOAuthConfigSchema.optional(),
  // shared
  disabled: z.boolean().optional(),
}).refine(
  (v) => {
    const hasCommand = 'command' in v && v.command
    const hasUrl = 'url' in v && v.url
    return (hasCommand && !hasUrl) || (!hasCommand && hasUrl)
  },
  { message: 'MCP server must have either "command" (stdio) or "url" (SSE/Streamable HTTP), but not both' },
)

export const mcpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
  timeoutMs: z.number().int().positive().optional(),
})

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>
export type McpConfig = z.infer<typeof mcpConfigSchema>
