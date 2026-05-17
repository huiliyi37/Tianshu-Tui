import type { TokenData } from './token-store.js'

export type { TokenData }

const EXPIRY_MARGIN_MS = 5 * 60_000

export function shouldRefresh(token: TokenData): boolean {
  return token.expiresAt - Date.now() < EXPIRY_MARGIN_MS
}
