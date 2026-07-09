// Verify-probe: confirms the /verify signature-check fix.
//
// Tests three scenarios:
//   1. A legitimately signed token verifies ✓
//   2. A tampered token (payload modified after signing) is rejected ✗
//   3. A forged unsigned token (the original vuln) is rejected ✗
//
// Run from the license-server directory:
//   cd license-server && npx tsx scripts/verify-probe.ts
// Or from the project root:
//   npx tsx license-server/scripts/verify-probe.ts

import { generateKeyPairSync } from 'node:crypto'
import {
  importPrivateKey,
  derivePublicKey,
  signToken,
  verifyTokenSignature,
  type TokenPayload,
} from '../src/token.ts'

const { privateKey } = generateKeyPairSync('ed25519')
const pkcs8 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64')

const privKey = await importPrivateKey(pkcs8)
const pubKey = await derivePublicKey(privKey)

const payload: TokenPayload = {
  product: 'tianshu-desktop',
  deviceId: 'dev-test12345678',
  tier: 'pro',
  iat: Date.now(),
  exp: Date.now() + 30 * 86_400_000,
  lic: null,
}

let passed = 0
let failed = 0
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}`)
    failed++
  }
}

console.log('\n=== /verify signature fix probe ===\n')

// 1. Legitimate token verifies
const goodToken = await signToken(payload, privKey)
check('legitimate signed token verifies', await verifyTokenSignature(goodToken, pubKey))

// 2. Tampered payload rejected
const [payloadB64, sigB64] = goodToken.split('.')
// Flip the last char of the payload segment
const tamperedPayload = payloadB64!.slice(0, -2) + (payloadB64!.endsWith('AA') ? 'BB' : 'AA')
const tamperedToken = `${tamperedPayload}.${sigB64}`
check('tampered payload rejected', !(await verifyTokenSignature(tamperedToken, pubKey)))

// 3. Forged unsigned token rejected (the original vulnerability)
const forgedPayload = Buffer.from(
  JSON.stringify({ ...payload, deviceId: 'dev-stolen-device00' }),
).toString('base64url')
const forgedSig = Buffer.alloc(64, 0).toString('base64url') // zeros — no private key
const forgedToken = `${forgedPayload}.${forgedSig}`
check('forged unsigned token rejected', !(await verifyTokenSignature(forgedToken, pubKey)))

// 4. Wrong key rejected
const { privateKey: otherPriv } = generateKeyPairSync('ed25519')
const otherPkcs8 = Buffer.from(otherPriv.export({ type: 'pkcs8', format: 'der' })).toString('base64')
const otherPub = await derivePublicKey(await importPrivateKey(otherPkcs8))
check('token from different key rejected', !(await verifyTokenSignature(goodToken, otherPub)))

console.log(`\n${passed}/${passed + failed} checks passed\n`)
if (failed > 0) process.exit(1)
