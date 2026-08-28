import type { AuthProvider } from './types.js'
import { ApiKeyAuth } from './api-key.js'
import { OAuthAuth, type OAuthConfig } from './oauth-auth.js'
import type { AuthConfig } from '../config/schema.js'

const CODEX_OAUTH_CONFIG: OAuthConfig = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  authorizeBase: 'https://auth.openai.com/oauth/authorize',
  redirectPort: 1455,
}

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
    const oauthConfig = authConfig.provider === 'codex' ? CODEX_OAUTH_CONFIG : null
    if (!oauthConfig) {
      throw new Error(`Unknown OAuth provider: ${authConfig.provider}`)
    }
    return new OAuthAuth(oauthConfig)
  }

  throw new Error(`Unknown auth type: ${(authConfig as { type: string }).type}`)
}

/**
 * 登录流程专用构造器：带 onUserCode 钩子（浏览器打开授权 URL）的 OAuthAuth。
 * 与 createAuthProvider 的运行时实例分开——登录是一次性用户动作，不进 agent 装配。
 * （背景：authenticate() 曾长期零生产调用，connect-flow 指引的 /login 是幽灵命令。）
 */
export function createOAuthLoginAuth(provider: string, onUserCode?: (url: string) => void): OAuthAuth {
  const base = provider === 'codex' ? CODEX_OAUTH_CONFIG : null
  if (!base) throw new Error(`Unknown OAuth provider: ${provider}`)
  return new OAuthAuth({ ...base, ...(onUserCode ? { onUserCode } : {}) })
}
