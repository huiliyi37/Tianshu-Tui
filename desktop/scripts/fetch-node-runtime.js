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
 *   NODE_MIRROR    base URL for the Node.js dist tree (default nodejs.org).
 *                  Set to a regional mirror (e.g. https://cdn.npmmirror.com/binaries/node)
 *                  when nodejs.org is slow/blocked. The mirror must keep the
 *                  official /v<ver>/<archive> + /v<ver>/SHASUMS256.txt layout so
 *                  the checksum guard below still verifies against official hashes.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, cpSync, copyFileSync, chmodSync } from 'node:fs'
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
// Base of the Node.js dist tree. Override with a regional mirror when nodejs.org
// is unreachably slow (the common case behind the GFW). Trailing slash trimmed
// so URL joins stay clean regardless of how the env value is written.
const NODE_MIRROR = (process.env.NODE_MIRROR || 'https://nodejs.org/dist').replace(/\/+$/, '')
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

// Rust target-triple arch token → Node.js dist arch token. Tauri sets
// TAURI_ENV_TARGET_TRIPLE (e.g. "x86_64-apple-darwin") on every build — native
// AND cross (`--target`). Honoring it is what makes an Intel package built on an
// Apple-Silicon host actually bundle an x86_64 Node runtime instead of silently
// shipping the host's arm64 binary (the exact bug that broke the Intel package).
const tripleArchMap = {
  aarch64: 'arm64',
  arm64: 'arm64',
  x86_64: 'x64',
  i686: 'x86',
}

/**
 * Resolve which platform/arch we are BUILDING FOR. Prefers Tauri's target
 * triple; falls back to the host when the var is absent (plain
 * `node fetch-node-runtime.js`). Exported so pack-native.js and others can reuse
 * the same cross-build detection without duplicating the triple parser.
 */
export function resolveTargetTriple() {
  const triple = (process.env.TAURI_ENV_TARGET_TRIPLE || '').trim()
  if (!triple) {
    return {
      platform: platformMap[process.platform],
      arch: archMap[process.arch],
      isWindows: process.platform === 'win32',
      source: 'host',
    }
  }
  const archTok = triple.split('-')[0]
  const arch = tripleArchMap[archTok]
  const platform = triple.includes('windows')
    ? 'win'
    : triple.includes('darwin')
      ? 'darwin'
      : triple.includes('linux')
        ? 'linux'
        : platformMap[process.platform]
  if (!platform || !arch) {
    throw new Error(`Unsupported target triple: ${triple}`)
  }
  return { platform, arch, isWindows: platform === 'win', source: 'triple' }
}

function detectTriple() {
  const t = resolveTargetTriple()
  if (!t.platform || !t.arch) {
    throw new Error(`Unsupported platform/arch: ${process.platform} ${process.arch}`)
  }
  if (t.source === 'triple') {
    console.log(
      `[fetch-node-runtime] target ${t.platform}-${t.arch} from TAURI_ENV_TARGET_TRIPLE=${process.env.TAURI_ENV_TARGET_TRIPLE}`,
    )
  }
  return { platform: t.platform, arch: t.arch, isWindows: t.isWindows }
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
    // Version-aware cache: a cached binary is only trustworthy if it IS the
    // requested version. Bumping NODE_VERSION while a stale binary sits on disk
    // would otherwise be silently ignored, shipping a runtime whose ABI no
    // longer matches the better-sqlite3 that pack-native built for NODE_VERSION
    // (the exact trap that caused the NODE_MODULE_VERSION crash). So probe the
    // cached binary and only short-circuit on an exact match; anything else
    // (wrong version / unreadable) falls through to a fresh download.
    let cachedVersion = ''
    try {
      cachedVersion = execSync(`"${binaryPath}" -v`, { encoding: 'utf8' }).trim()
    } catch {
      cachedVersion = ''
    }
    if (cachedVersion === `v${NODE_VERSION}`) {
      console.log(`[fetch-node-runtime] cached ${binaryPath} (${cachedVersion})`)
      return
    }
    console.log(
      `[fetch-node-runtime] cached ${binaryPath} is ${cachedVersion || 'unreadable'}, ` +
        `need v${NODE_VERSION} — re-downloading`,
    )
  }

  const baseName = `node-v${NODE_VERSION}-${platform}-${arch}`
  const ext = isWindows ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz'
  const url = `${NODE_MIRROR}/v${NODE_VERSION}/${baseName}.${ext}`
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
  const shasums = await fetchText(`${NODE_MIRROR}/v${NODE_VERSION}/SHASUMS256.txt`)
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

  // Bundle npm so the packaged desktop app can install plugins on demand.
  // The official Node archive ships npm; we copy only what is needed to run
  // `npm install` (the npm module + its launcher script), keeping the runtime
  // package as lean as possible.
  try {
    if (isWindows) {
      const npmModuleSrc = join(extractedDir, 'node_modules', 'npm')
      const npmModuleDest = join(targetDir, 'node_modules', 'npm')
      const npmCmdSrc = join(extractedDir, 'npm.cmd')
      const npmCmdDest = join(targetDir, 'npm.cmd')
      const npxCmdSrc = join(extractedDir, 'npx.cmd')
      const npxCmdDest = join(targetDir, 'npx.cmd')
      if (existsSync(npmModuleSrc) && existsSync(npmCmdSrc)) {
        mkdirSync(dirname(npmModuleDest), { recursive: true })
        cpSync(npmModuleSrc, npmModuleDest, { recursive: true, dereference: true })
        copyFileSync(npmCmdSrc, npmCmdDest)
        if (existsSync(npxCmdSrc)) {
          copyFileSync(npxCmdSrc, npxCmdDest)
          console.log(`[fetch-node-runtime] bundled npm + npx → ${npmCmdDest}, ${npxCmdDest}`)
        } else {
          console.log(`[fetch-node-runtime] bundled npm → ${npmCmdDest} (npx.cmd missing; npx-cli.js in module is enough)`)
        }
      } else {
        console.warn('[fetch-node-runtime] npm files not found in Windows archive; plugin install may fail in packaged app')
      }
    } else {
      const npmModuleSrc = join(extractedDir, 'lib', 'node_modules', 'npm')
      const npmModuleDest = join(targetDir, 'lib', 'node_modules', 'npm')
      const npmBinSrc = join(extractedDir, 'bin', 'npm')
      const npmBinDest = join(targetDir, 'bin', 'npm')
      const npxBinSrc = join(extractedDir, 'bin', 'npx')
      const npxBinDest = join(targetDir, 'bin', 'npx')
      if (existsSync(npmModuleSrc) && existsSync(npmBinSrc)) {
        mkdirSync(dirname(npmModuleDest), { recursive: true })
        cpSync(npmModuleSrc, npmModuleDest, { recursive: true, dereference: true })
        mkdirSync(dirname(npmBinDest), { recursive: true })
        copyFileSync(npmBinSrc, npmBinDest)
        chmodSync(npmBinDest, 0o755)
        if (existsSync(npxBinSrc)) {
          copyFileSync(npxBinSrc, npxBinDest)
          chmodSync(npxBinDest, 0o755)
          console.log(`[fetch-node-runtime] bundled npm + npx → ${npmBinDest}, ${npxBinDest}`)
        } else {
          console.log(`[fetch-node-runtime] bundled npm → ${npmBinDest} (npx missing; npx-cli.js in module is enough)`)
        }
      } else {
        console.warn('[fetch-node-runtime] npm files not found in archive; plugin install may fail in packaged app')
      }
    }
  } catch (err) {
    console.warn('[fetch-node-runtime] failed to bundle npm:', err.message)
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
