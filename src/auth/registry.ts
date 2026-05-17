import type { AuthProvider } from './types.js'
import { ApiKeyAuth } from './api-key.js'
import type { AuthConfig } from '../config/schema.js'

/**
 * Create an AuthProvider from config.
 * @param authConfig - The auth config from provider config (optional for backward compat)
 * @param env - Environment variables (defaults to process.env)
 * @param legacyApiKey - Fallback: explicit apiKey from legacy config
 */
export function createAuthProvider(
  authConfig: AuthConfig | undefined,
  env: Record<string, string | undefined>,
  legacyApiKey?: string,
): AuthProvider {
  if (!authConfig || authConfig.type === 'api-key') {
    const keyEnv = authConfig?.type === 'api-key' ? authConfig.keyEnv : undefined
    const key = (keyEnv ? env[keyEnv] : undefined) ?? legacyApiKey
    if (!key) {
      throw new Error(
        `No API key configured. Set apiKey in config or the ${keyEnv ?? 'API_KEY'} environment variable.`,
      )
    }
    return new ApiKeyAuth(key)
  }

  if (authConfig.type === 'oauth') {
    throw new Error(`OAuth provider "${authConfig.provider}" not yet implemented — requires interactive auth flow`)
  }

  throw new Error(`Unknown auth type: ${(authConfig as { type: string }).type}`)
}
