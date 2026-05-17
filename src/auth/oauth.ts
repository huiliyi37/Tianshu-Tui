import { createHash, randomBytes } from 'node:crypto'

const CODE_VERIFIER_BYTES = 32

export interface PKCEPair {
  verifier: string
  challenge: string
}

export async function generatePKCE(): Promise<PKCEPair> {
  const verifier = randomBytes(CODE_VERIFIER_BYTES).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

const DEFAULT_AUTHORIZE_BASE = 'https://auth.openai.com/oauth/authorize'

export interface AuthorizeUrlParams {
  clientId: string
  codeChallenge: string
  redirectUri: string
  state: string
  authorizeBase?: string
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const searchParams = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: params.redirectUri,
    state: params.state,
    scope: 'openid profile email offline_access',
  })
  return `${params.authorizeBase ?? DEFAULT_AUTHORIZE_BASE}?${searchParams.toString()}`
}
