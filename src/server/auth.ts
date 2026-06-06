import { timingSafeEqual } from 'node:crypto'

export interface AuthContext {
  body?: unknown
  headers?: Record<string, string>
}

export function extractBearerToken(headers?: Record<string, string>): string | null {
  const authHeader = headers?.authorization
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return null
}

export function extractRequestToken(context: AuthContext): string | null {
  const bearer = extractBearerToken(context.headers)
  if (bearer) return bearer
  const body = context.body
  if (body && typeof body === 'object' && 'token' in body) {
    return String((body as Record<string, unknown>).token)
  }
  return null
}

export function isAuthorizedRequest(context: AuthContext, expectedToken?: string): boolean {
  if (!expectedToken) return false
  const token = extractRequestToken(context)
  if (!token) return false
  const tokenBuffer = Buffer.from(token)
  const expectedBuffer = Buffer.from(expectedToken)
  if (tokenBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(tokenBuffer, expectedBuffer)
}
