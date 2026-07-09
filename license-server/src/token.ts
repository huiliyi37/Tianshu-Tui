// Signed license-token format (shared contract with the Rust verifier).
//
//   token = base64url(JSON(payload)) + "." + base64url(ed25519_sig)
//
// The message that gets signed is the ASCII bytes of the FIRST segment
// (the base64url(JSON) string itself), NOT the raw JSON. The Rust side
// verifies over the same bytes, so keep this stable.

export interface TokenPayload {
  /** Product id — must match wrangler PRODUCT var and the Rust verifier. */
  product: string
  /** Device fingerprint this token is bound to. */
  deviceId: string
  /** License tier (informational). */
  tier: string
  /** Issued-at, unix ms. */
  iat: number
  /** Token expiry, unix ms — heartbeat refreshes before this. */
  exp: number
  /** License validity end, unix ms; null = perpetual. */
  lic: number | null
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Import a PKCS#8 (base64) Ed25519 private key for signing.
 * `extractable: true` so we can derive the public key via JWK export for
 * server-side signature verification on /verify. Safe in a Worker — all code
 * is trusted; the flag only gates `exportKey` calls.
 */
export async function importPrivateKey(pkcs8B64: string): Promise<CryptoKey> {
  const der = b64urlDecodeStd(pkcs8B64)
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign'])
}

/**
 * Derive the Ed25519 public key from a private key (via JWK export). The JWK
 * contains an `x` field with the raw public key — we strip the private `d` and
 * re-import as a verify-only key.
 */
export async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicJwk: JsonWebKey = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    ext: true,
    key_ops: ['verify'],
  }
  return crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, false, ['verify'])
}

/**
 * Verify a token's Ed25519 signature. The signed message is the ASCII bytes of
 * the first segment (base64url(JSON(payload))), matching `signToken`. Returns
 * false on any crypto error — callers treat false as "reject the token".
 */
export async function verifyTokenSignature(token: string, publicKey: CryptoKey): Promise<boolean> {
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  const sig = b64urlDecode(sigB64)
  const msg = new TextEncoder().encode(payloadB64)
  try {
    return await crypto.subtle.verify('Ed25519', publicKey, sig, msg)
  } catch {
    return false
  }
}

/** Standard-base64 decode (private key is stored standard-base64, not url). */
function b64urlDecodeStd(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function signToken(payload: TokenPayload, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder()
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, enc.encode(payloadB64)))
  return `${payloadB64}.${b64urlEncode(sig)}`
}

/** Decode (without verifying) a token's payload. Used server-side on /verify. */
export function decodePayload(token: string): TokenPayload | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  try {
    const json = new TextDecoder().decode(b64urlDecode(token.slice(0, dot)))
    return JSON.parse(json) as TokenPayload
  } catch {
    return null
  }
}
