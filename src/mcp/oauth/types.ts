// MCP OAuth type definitions.

import { z } from 'zod'

/** Auth configuration embedded in McpServerConfig. */
export const mcpOAuthConfigSchema = z.object({
  type: z.literal('oauth'),
  provider: z.string().min(1),
  scopes: z.array(z.string()).optional(),
})

export type McpOAuthConfig = z.infer<typeof mcpOAuthConfigSchema>

/** Per-provider static metadata. */
export interface McpOAuthProvider {
  id: string
  name: string
  /** OAuth authorization endpoint. */
  authorizeUrl: string
  /** OAuth token endpoint. */
  tokenEndpoint: string
  /** Default scopes for this provider. */
  defaultScopes: string[]
  /** Where to obtain a client id / register an app. */
  clientIdHelp: string
}

/** Serialized token state persisted to disk. */
export interface McpOAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  provider: string
  scopes: string[]
}
