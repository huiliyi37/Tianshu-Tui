import { isIP } from 'node:net'

export function isPrivateIP(ip: string): boolean {
  if (isIP(ip) === 4) {
    const octets = ip.split('.').map(Number)
    if (octets[0] === 10) return true
    if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) return true
    if (octets[0] === 192 && octets[1] === 168) return true
    if (octets[0] === 127) return true
    if (octets[0] === 0) return true
    if (octets[0] === 169 && octets[1] === 254) return true
    return false
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe80')) return true
    return false
  }
  return false
}

export class SSRFError extends Error {
  constructor(
    readonly hostname: string,
    readonly address: string,
  ) {
    super(`Access denied: ${hostname} resolves to a private/reserved IP (${address})`)
    this.name = 'SSRFError'
  }
}

export type LookupFn = (hostname: string) => Promise<{ address: string }>

export async function resolveAndAssertPublic(
  hostname: string,
  lookup: LookupFn,
): Promise<{ address: string }> {
  const { address } = await lookup(hostname)
  if (isPrivateIP(address)) {
    throw new SSRFError(hostname, address)
  }
  return { address }
}
