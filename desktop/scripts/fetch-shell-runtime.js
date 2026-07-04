#!/usr/bin/env node
/**
 * fetch-shell-runtime.js — download PortableGit for Windows bash + git support.
 *
 * Places the self-extracting archive at
 * src-tauri/resources/shell/win-<arch>/PortableGit.7z.exe so tauri.conf.json
 * ships it as a bundled resource. The Rust launcher extracts it to the data
 * root on first launch (see lib.rs::ensure_bundled_git) and passes the
 * extracted dir to the sidecar via RIVET_BUNDLED_GIT_DIR.
 *
 * This guarantees every Windows install has a full Git Bash (bash + coreutils)
 * AND git itself — no dependency on the user installing Git for Windows, no
 * degradation to PowerShell/cmd. A system-installed Git still takes precedence
 * at runtime (see src/platform.ts::resolveGitBashPath).
 *
 * Non-Windows builds: no-op (Unix/macOS have native sh + git via Xcode CLT).
 *
 * Idempotent. Run during `tauri build` (beforeBuildCommand).
 */
import { existsSync, mkdirSync, createWriteStream, statSync, createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

// PortableGit release from git-for-windows GitHub releases (official).
// Mirror override for regions where GitHub is slow: set PORTABLE_GIT_MIRROR to
// a base URL that mirrors the release assets (the release filename is appended).
const GIT_TAG = process.env.PORTABLE_GIT_TAG || 'v2.55.0.windows.2'
const GIT_VERSION = process.env.PORTABLE_GIT_VERSION || '2.55.0.2'
const BASE = (
  process.env.PORTABLE_GIT_MIRROR
  || `https://github.com/git-for-windows/git/releases/download/${GIT_TAG}`
).replace(/\/+$/, '')
const DOWNLOAD_TIMEOUT_MS = Number(process.env.SHELL_FETCH_TIMEOUT_MS || 600000)

/** Official SHA-256 checksums for the pinned release (from the release notes).
 *  Only enforced for the default version — a version override skips verification. */
const PINNED_SHA256 = {
  '64-bit': 'b20d42da3afa228e9fa6174480de820282667e799440d655e308f700dfa0d0df',
  'arm64': '65b913a56a62d7a91fc11a2eecb08422aaa34332d3b2ea39457d2eda02c2f99c',
}
const isDefaultVersion = !process.env.PORTABLE_GIT_TAG && !process.env.PORTABLE_GIT_VERSION

/** Map Node process.arch → PortableGit arch suffix. 32-bit builds no longer
 *  exist upstream; ia32 hosts run the 64-bit build via WOW is not possible, but
 *  we don't ship 32-bit Windows targets anyway — default to 64-bit. */
function archFor(arch) {
  return arch === 'arm64' ? 'arm64' : '64-bit'
}

/** Directory suffix used by lib.rs::bundled_git_archive (keep in sync). */
function dirArchFor(arch) {
  return arch === 'arm64' ? 'win-aarch64' : 'win-x86_64'
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    const req = get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close()
        download(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        file.close()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => { file.close(resolve) })
    })
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('download timeout'))
    })
    req.on('error', reject)
  })
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function main() {
  // Non-Windows target: nothing to do (native sh + git are available).
  const hostIsWindows = process.platform === 'win32'
  const tauriTarget = process.env.TAURI_ENV_TARGET_TRIPLE || ''
  const targetIsWindows = hostIsWindows || tauriTarget.includes('windows')
  if (!targetIsWindows) {
    console.log('[fetch-shell-runtime] non-Windows target — skipping (native sh)')
    return
  }

  const nodeArch = process.env.npm_config_arch || process.arch
  const gitArch = archFor(nodeArch)
  const targetDir = join(__dirname, '..', 'src-tauri', 'resources', 'shell', dirArchFor(nodeArch))
  const binaryPath = join(targetDir, 'PortableGit.7z.exe')
  const expectedSha = isDefaultVersion ? PINNED_SHA256[gitArch] : undefined

  // Cache check: skip if already present with the right checksum (idempotent).
  if (existsSync(binaryPath)) {
    const size = statSync(binaryPath).size
    if (size > 50_000_000) {
      const actual = await sha256File(binaryPath)
      if (!expectedSha || actual === expectedSha) {
        console.log(`[fetch-shell-runtime] cached ${binaryPath} (${(size / 1024 / 1024).toFixed(1)}MB)`)
        return
      }
      console.log('[fetch-shell-runtime] cached file checksum mismatch — re-downloading')
    }
  }

  mkdirSync(targetDir, { recursive: true })

  const fileName = `PortableGit-${GIT_VERSION}-${gitArch}.7z.exe`
  const url = `${BASE}/${fileName}`
  const tmpPath = join(targetDir, '.portablegit.tmp')

  console.log(`[fetch-shell-runtime] downloading ${url}`)
  await download(url, tmpPath)

  // Sanity: PortableGit is ~56MB; anything small is an error page.
  const size = statSync(tmpPath).size
  if (size < 50_000_000) {
    throw new Error(`downloaded file too small (${size} bytes) — likely a 404 page`)
  }
  if (expectedSha) {
    const actual = await sha256File(tmpPath)
    if (actual !== expectedSha) {
      throw new Error(`SHA-256 mismatch: expected ${expectedSha}, got ${actual}`)
    }
  } else {
    console.log('[fetch-shell-runtime] no pinned checksum for this arch/version override — skipping verification')
  }

  const { renameSync, unlinkSync } = await import('node:fs')
  try { unlinkSync(binaryPath) } catch { /* may not exist */ }
  renameSync(tmpPath, binaryPath)
  console.log(`[fetch-shell-runtime] ready ${binaryPath} (${(size / 1024 / 1024).toFixed(1)}MB)`)
}

main().catch((err) => {
  console.error('[fetch-shell-runtime] failed:', err.message)
  console.error('[fetch-shell-runtime] Windows bash will fall back to system Git / PowerShell — set PORTABLE_GIT_MIRROR if upstream is unreachable')
  // Non-fatal: the build continues; Windows users get the Git install guide banner.
  process.exit(0)
})
