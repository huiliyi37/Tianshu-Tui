#!/usr/bin/env node
/**
 * Check that all i18n namespace files have matching keys between zh-CN and en.
 * Run from repo root: node desktop/scripts/check-i18n.js
 * Exits with 1 and prints mismatches if namespaces differ in structure.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const localesDir = path.resolve(__dirname, '../src/locales')

const LANGS = ['zh-CN', 'en']

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function collectKeys(obj, prefix = '') {
  const keys = new Set()
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      for (const child of collectKeys(v, key)) keys.add(child)
    } else {
      keys.add(key)
    }
  }
  return keys
}

function listNamespaces(lang) {
  return fs
    .readdirSync(path.join(localesDir, lang))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
}

let failed = false
const zhNamespaces = new Set(listNamespaces('zh-CN'))
const enNamespaces = new Set(listNamespaces('en'))

// Namespace set must match.
for (const ns of zhNamespaces) {
  if (!enNamespaces.has(ns)) {
    console.error(`❌ namespace "${ns}" exists in zh-CN but not en`)
    failed = true
  }
}
for (const ns of enNamespaces) {
  if (!zhNamespaces.has(ns)) {
    console.error(`❌ namespace "${ns}" exists in en but not zh-CN`)
    failed = true
  }
}

// Keys within each namespace must match.
for (const ns of [...zhNamespaces].sort()) {
  const zh = readJSON(path.join(localesDir, 'zh-CN', `${ns}.json`))
  const en = readJSON(path.join(localesDir, 'en', `${ns}.json`))
  const zhKeys = collectKeys(zh)
  const enKeys = collectKeys(en)
  const onlyInZh = [...zhKeys].filter((k) => !enKeys.has(k)).sort()
  const onlyInEn = [...enKeys].filter((k) => !zhKeys.has(k)).sort()
  if (onlyInZh.length) {
    console.error(`❌ ${ns}: keys in zh-CN but missing in en:`)
    for (const k of onlyInZh) console.error(`   - ${k}`)
    failed = true
  }
  if (onlyInEn.length) {
    console.error(`❌ ${ns}: keys in en but missing in zh-CN:`)
    for (const k of onlyInEn) console.error(`   - ${k}`)
    failed = true
  }
}

if (failed) {
  console.error('\n i18n key alignment check failed.')
  process.exit(1)
}

console.log('✅ i18n key alignment check passed.')
