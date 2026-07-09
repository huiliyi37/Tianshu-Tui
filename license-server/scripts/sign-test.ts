import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { importPrivateKey, signToken, type TokenPayload } from '../src/token.ts'

// 跨语言互操作测试夹具:用真实的 token.ts(Web Crypto Ed25519)签发一个 token,
// 连同 raw32 公钥(standard base64)写到文件,供 Rust activation.rs 的互操作测试验签。
// 证明服务器签发与桌面端验签在字节层面完全互认。

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const rawPublic = publicKey.export({ type: 'spki', format: 'der' })
const raw32 = rawPublic.subarray(rawPublic.length - 32)
const privB64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64')

const key = await importPrivateKey(privB64)

const now = Date.now()
const payload: TokenPayload = {
  product: 'tianshu-desktop',
  deviceId: 'dev-interoptest12345',
  tier: 'pro',
  iat: now,
  exp: now + 30 * 86_400_000,
  lic: null,
}

const token = await signToken(payload, key)

writeFileSync('/tmp/tianshu-interop-pubkey', Buffer.from(raw32).toString('base64'))
writeFileSync('/tmp/tianshu-interop-token', token)
console.log('wrote /tmp/tianshu-interop-pubkey and /tmp/tianshu-interop-token')
