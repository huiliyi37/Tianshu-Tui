#!/usr/bin/env node
/**
 * Fetch and cache a platform-matching Node.js binary for Tauri bundling.
 *
 * The binary is placed at src-tauri/resources/node/<os>-<arch>/node[.exe]
 * so that tauri.conf.json can ship it as a bundled resource. This lets the
 * desktop app launch its sidecar without relying on a system Node install.
 *
 * Environment variables:
 *   NODE_VERSION   e.g. 22.15.0 (default below)
 *   FORCE_FETCH    set to 1 to re-download even if the binary already exists
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Single source of truth for the bundled sidecar Node runtime version.
// scripts/pack-native.js imports this to keep its build-time ABI assertion in
// lockstep — the packed better-sqlite3 ABI must match THIS runtime, not the
// build machine's Node. Bump here and the ABI guard follows automatically.
export const DEFAULT_NODE_VERSION = '24.1.0'
const NODE_VERSION = process.env.NODE_VERSION || DEFAULT_NODE_VERSION
const FORCE_FETCH = process.env.FORCE_FETCH === '1'
// No-data watchdog: abort a stalled connection so a hung mirror can't freeze
// the whole build indefinitely.
const DOWNLOAD_TIMEOUT_MS = Number(process.env.NODE_FETCH_TIMEOUT_MS || 120000)

const platformMap = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win',
}

const archMap = {
  arm64: 'arm64',
  x64: 'x64',
  ia32: 'x86',
}

function detectTriple() {
  const platform = platformMap[process.platform]
  const arch = archMap[process.arch]
  if (!platform || !arch) {
    throw new Error(`Unsupported platform/arch: ${process.platform} ${process.arch}`)
  }
  return { platform, arch, isWindows: process.platform === 'win32' }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    const req = get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        rmSync(dest, { force: true })
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        rmSync(dest, { force: true })
        return reject(new Error(`Download failed: ${res.statusCode} ${url}`))
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    })
    req.on('error', (err) => {
      file.close()
      rmSync(dest, { force: true })
      reject(err)
    })
    // Reset the watchdog on every byte; only fire if the socket goes silent.
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${url}`))
    })
  })
}

/** Fetch a small text resource (follows redirects). Used for SHASUMS256.txt. */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Fetch failed: ${res.statusCode} ${url}`))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`Fetch timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${url}`))
    })
  })
}

/**
 * Pull the expected sha256 for `filename` out of a Node.js SHASUMS256.txt body.
 * Each line is "<hex>  <filename>". Returns the lowercase hex digest, or null
 * if the file is not listed. Pure (no I/O) so it is unit-testable.
 */
export function parseShasum(shasumsText, filename) {
  for (const line of shasumsText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m && m[2] === filename) return m[1].toLowerCase()
  }
  return null
}

/** Stream-hash a file with sha256 → lowercase hex. */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function main() {
  const { platform, arch, isWindows } = detectTriple()
  const targetDir = join(__dirname, '..', 'src-tauri', 'resources', 'node', `${platform}-${arch}`)
  const binaryName = isWindows ? 'node.exe' : 'node'
  const binaryPath = join(targetDir, binaryName)

  if (existsSync(binaryPath) && !FORCE_FETCH) {
    console.log(`[fetch-node-runtime] cached ${binaryPath}`)
    return
  }

  const baseName = `node-v${NODE_VERSION}-${platform}-${arch}`
  const ext = isWindows ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz'
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${baseName}.${ext}`
  const tmpDir = join(__dirname, '..', '.tmp-node-runtime')
  const archivePath = join(tmpDir, `${baseName}.${ext}`)

  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(targetDir, { recursive: true })

  console.log(`[fetch-node-runtime] downloading ${url}`)
  await download(url, archivePath)

  // Supply-chain guard: verify the archive against the official SHASUMS256.txt
  // before trusting it. A tampered/corrupt binary would otherwise be bundled
  // straight into the shipped app. Fail-closed — abort the build on any mismatch.
  const archiveName = `${baseName}.${ext}`
  console.log(`[fetch-node-runtime] verifying ${archiveName} checksum`)
  const shasums = await fetchText(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)
  const expected = parseShasum(shasums, archiveName)
  if (!expected) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw new Error(`No checksum listed for ${archiveName} in SHASUMS256.txt`)
  }
  const actual = await sha256File(archivePath)
  if (actual !== expected) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw new Error(
      `Checksum mismatch for ${archiveName}:\n  expected ${expected}\n  actual   ${actual}`,
    )
  }
  console.log(`[fetch-node-runtime] checksum ok (${expected.slice(0, 12)}…)`)

  console.log(`[fetch-node-runtime] extracting ${archivePath}`)
  if (isWindows) {
    execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'inherit' })
  } else if (platform === 'linux') {
    execSync(`tar -xJf "${archivePath}" -C "${tmpDir}"`, { stdio: 'inherit' })
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { stdio: 'inherit' })
  }

  const extractedDir = join(tmpDir, baseName)
  const sourceBinary = isWindows
    ? join(extractedDir, 'node.exe')
    : join(extractedDir, 'bin', 'node')

  if (!existsSync(sourceBinary)) {
    throw new Error(`Expected Node binary not found at ${sourceBinary}`)
  }

  // Copy (not move) so the temp dir can be wiped cleanly.
  execSync(isWindows
    ? `copy /Y "${sourceBinary}" "${binaryPath}"`
    : `cp "${sourceBinary}" "${binaryPath}"`, { stdio: 'inherit' })

  // Make executable on Unix.
  if (!isWindows) {
    execSync(`chmod +x "${binaryPath}"`, { stdio: 'inherit' })
  }

  // Clean up.
  rmSync(tmpDir, { recursive: true, force: true })

  console.log(`[fetch-node-runtime] ready ${binaryPath}`)
}

// Only run the fetch when invoked directly as a script. Importing this module
// (e.g. for the exported `parseShasum` in a test) must have no side effects.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[fetch-node-runtime] failed:', err.message)
    process.exit(1)
  })
}
