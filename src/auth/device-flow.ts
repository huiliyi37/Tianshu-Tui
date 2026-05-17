import type { TokenData } from './token-store.js'

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export function buildDeviceCodeRequest(clientId: string): Record<string, string> {
  return {
    client_id: clientId,
    scope: 'openid profile email offline_access',
  }
}

export function parseDeviceCodeResponse(raw: Record<string, unknown>): DeviceCodeResponse {
  const deviceCode = raw.device_code
  const userCode = raw.user_code
  const verificationUri = raw.verification_uri

  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new Error(`Invalid device code response: missing required fields. Got keys: ${Object.keys(raw).join(', ')}`)
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: typeof raw.expires_in === 'number' ? raw.expires_in : 600,
    interval: typeof raw.interval === 'number' ? raw.interval : 5,
  }
}

export function parseTokenResponse(raw: Record<string, unknown>): TokenData {
  if (typeof raw.error === 'string') {
    throw new Error(`Token error: ${raw.error}`)
  }

  const accessToken = raw.access_token
  if (typeof accessToken !== 'string') {
    throw new Error('Invalid token response: missing access_token')
  }

  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600

  return {
    accessToken,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}
