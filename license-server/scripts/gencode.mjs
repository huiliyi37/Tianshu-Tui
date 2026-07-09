#!/usr/bin/env node
// Generate one or more activation codes and emit SQL to insert them.
//
//   node scripts/gencode.mjs [--count N] [--tier pro] [--devices 1] \
//                            [--days 365] [--note "buyer@example.com"]
//
// Pipe the output into D1:
//   node scripts/gencode.mjs --count 5 | tee /tmp/codes.sql
//   wrangler d1 execute tianshu-licenses --file=/tmp/codes.sql
//
// --days omitted → perpetual license (license_expires NULL).
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const count = parseInt(opt('count', '1'), 10)
const tier = opt('tier', 'pro')
const devices = parseInt(opt('devices', '1'), 10)
const daysRaw = opt('days', '')
const note = opt('note', '')

const licenseExpires = daysRaw ? Date.now() + parseInt(daysRaw, 10) * 86_400_000 : null
const now = Date.now()

// Human-friendly grouped code: TS-XXXX-XXXX-XXXX (base32-ish, no ambiguous chars).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function group() {
  const b = randomBytes(4)
  let s = ''
  for (let i = 0; i < 4; i++) s += ALPHABET[b[i] % ALPHABET.length]
  return s
}
function makeCode() {
  return `TS-${group()}-${group()}-${group()}`
}

console.log('-- generated activation codes')
for (let i = 0; i < count; i++) {
  const code = makeCode()
  const lic = licenseExpires == null ? 'NULL' : String(licenseExpires)
  const noteSql = note ? `'${note.replace(/'/g, "''")}'` : 'NULL'
  console.log(
    `INSERT INTO codes (code, tier, max_activations, used_count, license_expires, revoked, note, created_at) ` +
      `VALUES ('${code}', '${tier}', ${devices}, 0, ${lic}, 0, ${noteSql}, ${now});`,
  )
  console.error(code) // stderr so codes are visible even when stdout is piped to a file
}
