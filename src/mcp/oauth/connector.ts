// MCP OAuth connector — per-server PKCE token lifecycle.
//
// Reuses the same OAuth primitives (PKCE, TokenStore, refresh) as the main
// Codex auth in src/auth/, but with per-serverId token storage and generic
// provider endpoints (not hardcoded to OpenAI's auth domain).

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { generatePKCE, buildAuthorizeUrl } from '../../auth/oauth.js'
import { TokenStore, type TokenData } from '../../auth/token-store.js'
import { shouldRefresh } from '../../auth/refresh.js'
import { rivetHome } from '../../config/paths.js'
import type { McpOAuthProvider, McpOAuthToken } from './types.js'

const REDIRECT_PORT = 1456
const CALLBACK_PATH = '/auth/callback'
const CALLBACK_TIMEOUT_MS = 5 * 60_000
const OAUTH_TIMEOUT_MS = 30_000

/** Per-server OAuth token directory — separate from the main Codex auth store. */
function mcpOAuthDir(): string {
  return join(rivetHome(), 'mcp-oauth')
}

function tokenStore(serverId: string): TokenStore {
  return new TokenStore(mcpOAuthDir(), serverId)
}

/** Start the full OAuth flow for a given server + provider.
 *  Returns the serialized token on success. */
export async function startMcpOAuth(
  serverId: string,
  provider: McpOAuthProvider,
  clientId: string,
  extraScopes?: string[],
): Promise<McpOAuthToken> {
  const pkce = await generatePKCE()
  const state = randomBytes(16).toString('hex')
  const redirectUri = `http://localhost:${REDIRECT_PORT}${CALLBACK_PATH}`
  const scopes = [...provider.defaultScopes, ...(extraScopes ?? [])]

  const authUrl = buildAuthorizeUrl({
    clientId,
    codeChallenge: pkce.challenge,
    redirectUri,
    state,
    authorizeBase: provider.authorizeUrl,
  })
  // Override the default 'openid profile email offline_access' scope string
  // that buildAuthorizeUrl produces — MCP providers have their own scopes.
  const url = new URL(authUrl)
  url.searchParams.set('scope', scopes.join(' '))

  const code = await serveCallback(REDIRECT_PORT, state, url.toString())
  const token = await exchange(code, pkce.verifier, redirectUri, provider, clientId)

  const mcpToken: McpOAuthToken = {
    ...token,
    provider: provider.id,
    scopes,
  }
  // Save metadata (provider, scopes) alongside the raw TokenData so
  // loadMcpOAuthToken can reconstruct the full McpOAuthToken.
  tokenStore(serverId).save({
    ...token,
    _provider: provider.id,
    _scopes: scopes,
  } as TokenData & { _provider: string; _scopes: string[] })
  return mcpToken
}

/** Get a fresh access token for a server, refreshing if needed. */
export async function getMcpAccessToken(serverId: string, provider: McpOAuthProvider, clientId: string): Promise<string> {
  const store = tokenStore(serverId)
  let token = store.load()
  if (!token) throw new Error(`No OAuth token for MCP server "${serverId}" — run /mcp auth ${serverId}`)

  if (shouldRefresh(token)) {
    token = await refreshMcpToken(token, provider, clientId)
    store.save(token)
  }

  return token.accessToken
}

/** Check if a server has a valid (non-expired) OAuth token. */
export function hasMcpOAuthToken(serverId: string): boolean {
  const token = tokenStore(serverId).load()
  return token !== null && token.expiresAt > Date.now()
}

/** Remove the OAuth token for a server (disconnect). */
export function revokeMcpOAuth(serverId: string): void {
  tokenStore(serverId).clear()
}

/** Load the stored OAuth token for a server (null if none or expired). */
export function loadMcpOAuthToken(serverId: string): McpOAuthToken | null {
  const data = tokenStore(serverId).load() as (TokenData & { _provider?: string; _scopes?: string[] }) | null
  if (!data) return null
  if (data.expiresAt <= Date.now()) return null
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    provider: data._provider ?? '',
    scopes: data._scopes ?? [],
  }
}

// ── internals ──

async function serveCallback(port: number, expectedState: string, authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('OAuth callback timed out after 5 minutes'))
    }, CALLBACK_TIMEOUT_MS)

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(); return }

      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')

      if (returnedState !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h1>State mismatch — possible CSRF</h1>')
        server.close(); clearTimeout(timeout)
        reject(new Error('OAuth state mismatch'))
        return
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h1>Authorization failed: ${url.searchParams.get('error') ?? 'unknown'}</h1>`)
        server.close(); clearTimeout(timeout)
        reject(new Error(`OAuth error: ${url.searchParams.get('error') ?? 'unknown'}`))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>MCP connected — you can close this tab</h1>')
      server.close(); clearTimeout(timeout)
      resolve(code)
    })

    server.listen(port, () => {
      process.stderr.write(`Open this URL to connect MCP:\n${authUrl}\n`)
    })
    server.on('error', (err) => { clearTimeout(timeout); reject(err) })
  })
}

async function exchange(
  code: string, codeVerifier: string, redirectUri: string,
  provider: McpOAuthProvider, clientId: string,
): Promise<TokenData> {
  const resp = await fetch(provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  })

  // GitHub returns form-encoded; others return JSON
  const text = await resp.text()
  let data: Record<string, unknown>
  if (text.startsWith('{')) {
    data = JSON.parse(text) as Record<string, unknown>
  } else {
    // Parse form-encoded (GitHub style: access_token=xxx&scope=...)
    const params = new URLSearchParams(text)
    data = Object.fromEntries(params.entries())
  }

  if (!resp.ok || typeof data.error === 'string') {
    throw new Error(`Token exchange failed (${resp.status}): ${typeof data.error === 'string' ? data.error : text.slice(0, 200)}`)
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in
    : typeof data.expires_in === 'string' ? Number.parseInt(data.expires_in, 10)
    : 3600

  return {
    accessToken: (data.access_token ?? data.accessToken) as string,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  }
}

async function refreshMcpToken(
  token: TokenData, provider: McpOAuthProvider, clientId: string,
): Promise<TokenData> {
  if (!token.refreshToken) throw new Error('No refresh token — re-authenticate')

  const resp = await fetch(provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: token.refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  })

  const text = await resp.text()
  let data: Record<string, unknown>
  if (text.startsWith('{')) {
    data = JSON.parse(text) as Record<string, unknown>
  } else {
    data = Object.fromEntries(new URLSearchParams(text).entries())
  }

  if (!resp.ok) throw new Error(`Token refresh failed (${resp.status})`)

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in
    : typeof data.expires_in === 'string' ? Number.parseInt(data.expires_in, 10)
    : 3600

  return {
    accessToken: (data.access_token ?? data.accessToken) as string,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : token.refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  }
}
