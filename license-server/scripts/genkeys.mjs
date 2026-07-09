#!/usr/bin/env node
// Generate an Ed25519 keypair for license signing.
//
//   node scripts/genkeys.mjs
//
// Prints:
//   - PRIVATE (PKCS#8, base64)  → wrangler secret put SIGNING_KEY_PKCS8
//   - PUBLIC  (raw 32 bytes, base64) → hardcode into the Rust verifier
//
// The private key NEVER leaves the server. Only the public key ships in the
// desktop binary.
import { webcrypto } from 'node:crypto'

const { subtle } = webcrypto

const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey))
const rawPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))

const b64 = (u8) => Buffer.from(u8).toString('base64')

console.log('=== Ed25519 keypair (generated) ===\n')
console.log('PRIVATE KEY (PKCS#8, base64) — keep secret, set as Worker secret:')
console.log('  wrangler secret put SIGNING_KEY_PKCS8')
console.log('  value:')
console.log(b64(pkcs8))
console.log('\nPUBLIC KEY (raw 32 bytes, base64) — hardcode into Rust verifier:')
console.log(b64(rawPub))
console.log('\n(32-byte public key length check:', rawPub.length, ')')
