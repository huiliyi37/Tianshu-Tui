// Static OAuth provider registry for MCP presets.
// Each entry maps to a known MCP server that supports OAuth-based auth.
import type { McpOAuthProvider } from './types.js'

export const MCP_OAUTH_PROVIDERS: McpOAuthProvider[] = [
  {
    id: 'github',
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    defaultScopes: ['repo', 'read:org'],
    clientIdHelp: 'GitHub Settings → Developer settings → OAuth Apps → New OAuth App. Redirect URL: http://localhost:1456/auth/callback',
  },
  {
    id: 'slack',
    name: 'Slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
    defaultScopes: ['channels:read', 'chat:write', 'channels:history'],
    clientIdHelp: 'Slack API → Your Apps → Create New App → OAuth & Permissions. Redirect URL: http://localhost:1456/auth/callback',
  },
  {
    id: 'notion',
    name: 'Notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
    defaultScopes: [],
    clientIdHelp: 'Notion Integrations → View integration → OAuth Domain & URIs. Redirect URL: http://localhost:1456/auth/callback',
  },
  {
    id: 'linear',
    name: 'Linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenEndpoint: 'https://api.linear.app/oauth/token',
    defaultScopes: ['read', 'write'],
    clientIdHelp: 'Linear Settings → API → OAuth applications → Create. Redirect URL: http://localhost:1456/auth/callback',
  },
]

/** Look up a provider by id. */
export function findMcpOAuthProvider(id: string): McpOAuthProvider | undefined {
  const lower = id.toLowerCase()
  return MCP_OAUTH_PROVIDERS.find(p => p.id.toLowerCase() === lower)
}
