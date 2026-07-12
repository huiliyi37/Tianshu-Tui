#!/usr/bin/env node
/**
 * stage-plugins.js — copy first-party plugins into a clean staging directory
 * for Tauri bundling, stripping build-time-only artifacts (node_modules, tests,
 * lockfiles) so the packaged app only ships plugin source + manifest.
 *
 * The staged tree is then bundled via tauri.conf.json:
 *   "resources/plugins-staged": "plugins"
 *
 * Why this exists:
 *   - plugins/ is a normal npm workspace area; developers may run `npm install`
 *     inside a plugin during development (e.g. design plugin's puppeteer deps).
 *   - Shipping those node_modules inside the .app would bloat the bundle by
 *     tens of MB and is unnecessary: the sidecar runs `npm install` at plugin
 *     install time using the bundled npm.
 *   - Excluding tests and lockfiles keeps the runtime package lean and avoids
 *     leaking development-only files.
 */
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const sourceRoot = join(repoRoot, 'plugins')
const targetRoot = join(repoRoot, 'desktop', 'src-tauri', 'resources', 'plugins-staged')

/** Paths / globs to keep out of the packaged plugin bundle. */
const EXCLUDED_NAMES = new Set([
  'node_modules',
  '.git',
  '.github',
  '__tests__',
  '.DS_Store',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
])

const EXCLUDED_EXTS = ['.test.ts', '.test.js', '.spec.ts', '.spec.js']

function shouldExclude(name) {
  if (EXCLUDED_NAMES.has(name)) return true
  for (const ext of EXCLUDED_EXTS) {
    if (name.endsWith(ext)) return true
  }
  return false
}

function copyPlugin(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (shouldExclude(entry.name)) continue
    const src = join(sourceDir, entry.name)
    const dest = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyPlugin(src, dest)
    } else {
      cpSync(src, dest)
    }
  }
}

function main() {
  if (!existsSync(sourceRoot)) {
    console.warn('[stage-plugins] plugins/ directory not found; nothing to stage')
    return
  }

  if (existsSync(targetRoot)) {
    rmSync(targetRoot, { recursive: true, force: true })
  }
  mkdirSync(targetRoot, { recursive: true })

  const entries = readdirSync(sourceRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && !shouldExclude(e.name))

  let staged = 0
  for (const entry of entries) {
    const sourceDir = join(sourceRoot, entry.name)
    const targetDir = join(targetRoot, entry.name)
    copyPlugin(sourceDir, targetDir)
    staged++
  }

  console.log(`[stage-plugins] staged ${staged} plugin(s) → ${targetRoot}`)
}

main()
