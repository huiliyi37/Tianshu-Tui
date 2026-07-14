// Maps OAuth provider tokens to the env vars / headers expected by each MCP preset.
// Stdio presets receive tokens via environment variables;
// remote (URL-based) presets receive tokens via Authorization headers.
import type { McpOAuthToken } from './types.js'

/** Maps a provider id to the env var(s) needed by the corresponding MCP stdio preset. */
const PROVIDER_ENV_MAP: Record<string, (token: McpOAuthToken) => Record<string, string>> = {
  github: (t) => ({ GITHUB_PERSONAL_ACCESS_TOKEN: t.accessToken }),
  slack: (t) => ({ SLACK_BOT_TOKEN: t.accessToken }),
  notion: (t) => ({ NOTION_API_KEY: t.accessToken }),
  linear: (t) => ({ LINEAR_API_KEY: t.accessToken }),
}

/** Maps a provider id to the header(s) expected by a remote MCP server. */
function defaultOAuthHeaders(token: McpOAuthToken): Record<string, string> {
  return { Authorization: `Bearer ${token.accessToken}` }
}

/**
 * Resolve env vars to inject into a stdio MCP server process.
 *
 * Because stdio servers receive credentials through environment variables,
 * the provider → env mapping is hardcoded per known preset.
 */
export function resolveOAuthEnv(providerId: string, token: McpOAuthToken): Record<string, string> {
  const fn = PROVIDER_ENV_MAP[providerId]
  if (fn) return fn(token)
  // Unknown provider — inject as default env var name guess
  return { [`${providerId.toUpperCase()}_API_KEY`]: token.accessToken }
}

/**
 * Resolve headers to inject into a remote MCP server request.
 *
 * Most remote MCP servers use standard Bearer token auth.
 * Custom overrides per provider can be added here.
 */
export function resolveOAuthHeaders(providerId: string, token: McpOAuthToken): Record<string, string> {
  return defaultOAuthHeaders(token)
}

/**
 * Map a preset id to its corresponding OAuth provider, if any.
 *
 * This is the loose coupling between presets and providers:
 * the preset declares `auth.provider`, and this function returns
 * the provider id. If a preset id differs from the provider id,
 * add a mapping here.
 */
const PRESET_TO_PROVIDER: Record<string, string> = {
  github: 'github',
  slack: 'slack',
  notion: 'notion',
  linear: 'linear',
}

export function presetToProvider(presetId: string): string | undefined {
  return PRESET_TO_PROVIDER[presetId]
}
