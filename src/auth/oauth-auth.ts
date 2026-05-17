import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AuthProvider } from './types.js'
import { generatePKCE, buildAuthorizeUrl } from './oauth.js'
import { TokenStore, type TokenData } from './token-store.js'
import { shouldRefresh } from './refresh.js'

export interface OAuthConfig {
  clientId: string
  tokenEndpoint: string
  authorizeBase?: string
  redirectPort?: number
  authDir?: string
  onUserCode?: (url: string) => void
  fetch?: typeof globalThis.fetch
}

const DEFAULT_REDIRECT_PORT = 1455
const DEFAULT_AUTH_DIR = '.rivet/auth'

export class OAuthAuth implements AuthProvider {
  private store: TokenStore
  private config: Required<Pick<OAuthConfig, 'clientId' | 'tokenEndpoint'>> & OAuthConfig
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private server: ReturnType<typeof createServer> | null = null

  constructor(config: OAuthConfig, authDir?: string) {
    this.config = {
      ...config,
      redirectPort: config.redirectPort ?? DEFAULT_REDIRECT_PORT,
      authDir: config.authDir ?? DEFAULT_AUTH_DIR,
      authorizeBase: config.authorizeBase ?? 'https://auth.openai.com/oauth/authorize',
    }
    this.store = new TokenStore(
      authDir ?? config.authDir ?? `${process.env.HOME ?? '.'}/${DEFAULT_AUTH_DIR}`,
      'codex',
    )
  }

  isAuthenticated(): boolean {
    const token = this.store.load()
    return token !== null && token.expiresAt > Date.now()
  }

  async getHeaders(): Promise<Record<string, string>> {
    let token = this.store.load()
    if (!token) {
      throw new Error('Not authenticated — call authenticate() first')
    }

    if (shouldRefresh(token)) {
      token = await this.refreshToken(token)
    }

    return { 'Authorization': `Bearer ${token.accessToken}` }
  }

  async authenticate(): Promise<void> {
    const pkce = await generatePKCE()
    const state = randomBytes(16).toString('hex')
    const port: number = this.config.redirectPort ?? DEFAULT_REDIRECT_PORT
    const redirectUri = `http://localhost:${port}/auth/callback`

    const authUrl = buildAuthorizeUrl({
      clientId: this.config.clientId,
      codeChallenge: pkce.challenge,
      redirectUri,
      state,
      authorizeBase: this.config.authorizeBase,
    })

    const code = await this.startCallbackServer(port, state, authUrl)
    const tokens = await this.exchangeCode(code, pkce.verifier, redirectUri)
    this.store.save(tokens)
    this.startAutoRefresh()
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  private startCallbackServer(port: number, expectedState: string, authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close()
        reject(new Error('OAuth callback timed out after 5 minutes'))
      }, 5 * 60_000)

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`)

        if (url.pathname !== '/auth/callback') {
          res.writeHead(404)
          res.end('Not found')
          return
        }

        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

        if (returnedState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<h1>State mismatch — possible CSRF</h1>')
          server.close()
          clearTimeout(timeout)
          reject(new Error('OAuth state mismatch'))
          return
        }

        if (!code) {
          const error = url.searchParams.get('error') ?? 'unknown'
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(`<h1>Authorization failed: ${error}</h1>`)
          server.close()
          clearTimeout(timeout)
          reject(new Error(`OAuth error: ${error}`))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Authentication successful — you can close this tab</h1>')
        server.close()
        clearTimeout(timeout)
        resolve(code)
      })

      this.server = server

      server.listen(port, () => {
        if (this.config.onUserCode) {
          this.config.onUserCode(authUrl)
        } else {
          // Default: print to stderr (non-interactive fallback)
          process.stderr.write(`Open this URL to authenticate:\n${authUrl}\n`)
        }
      })

      server.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenData> {
    const fetchFn = this.config.fetch ?? globalThis.fetch
    const resp = await fetchFn(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }).toString(),
    })

    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Token exchange failed (${resp.status}): ${body}`)
    }

    const data = await resp.json() as Record<string, unknown>
    if (typeof data.error === 'string') {
      throw new Error(`Token exchange error: ${data.error}`)
    }

    return {
      accessToken: data.access_token as string,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    }
  }

  private async refreshToken(token: TokenData): Promise<TokenData> {
    if (!token.refreshToken) {
      throw new Error('No refresh token — re-authenticate')
    }

    const fetchFn = this.config.fetch ?? globalThis.fetch
    const resp = await fetchFn(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        refresh_token: token.refreshToken,
      }).toString(),
    })

    if (!resp.ok) {
      throw new Error(`Token refresh failed (${resp.status})`)
    }

    const data = await resp.json() as Record<string, unknown>
    if (typeof data.error === 'string') {
      throw new Error(`Token refresh error: ${data.error}`)
    }

    const refreshed: TokenData = {
      accessToken: data.access_token as string,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : token.refreshToken,
      expiresAt: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
    }

    this.store.save(refreshed)
    return refreshed
  }

  private startAutoRefresh(): void {
    // Check every 5 minutes if token needs refresh
    this.refreshTimer = setInterval(async () => {
      const token = this.store.load()
      if (token && shouldRefresh(token)) {
        try {
          await this.refreshToken(token)
        } catch {
          // Refresh failed — token will expire, user needs to re-auth
        }
      }
    }, 5 * 60_000)

    // Don't keep process alive just for the refresh timer
    if (this.refreshTimer.unref) this.refreshTimer.unref()
  }
}
