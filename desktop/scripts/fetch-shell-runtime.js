#!/usr/bin/env node
/**
 * fetch-shell-runtime.js — download busybox-w32 for Windows bash support.
 *
 * Places the binary at src-tauri/resources/shell/win-<arch>/busybox.exe so
 * tauri.conf.json can ship it as a bundled resource. This guarantees every
 * Windows install has a POSIX shell + coreutils — no dependency on the user
 * installing Git for Windows, no degradation to PowerShell/cmd.
 *
 * busybox-w32 is a single ~3MB native Win32 binary containing ash (bash-compatible
 * shell) + ls/cat/grep/sed/awk/cp/mv/rm/mkdir/touch and more. No dependencies.
 *
 * Non-Windows builds: no-op (Unix/macOS have native sh).
 *
 * Idempotent. Run during `tauri build` (beforeBuildCommand).
 */
import { existsSync, mkdirSync, createWriteStream, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// busybox-w32 release from frippery.org (the official upstream distributor).
// Mirror override for regions where the upstream is slow.
const BUSYBOX_BASE = (process.env.BUSYBOX_MIRROR || 'https://frippery.org/busybox').replace(/\/+$/, '')
const BUSYBOX_VERSION = process.env.BUSYBOX_VERSION || 'FRP-6075_g7d205ab'
const DOWNLOAD_TIMEOUT_MS = Number(process.env.SHELL_FETCH_TIMEOUT_MS || 120000)

/** Map Node process.arch → busybox-w32 arch suffix. */
function archFor(arch) {
  switch (arch) {
    case 'arm64': return 'aarch64'
    case 'ia32':
    case 'x32': return 'i686'
    default: return 'x86_64'
  }
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

async function main() {
  // Non-Windows target: nothing to do (native sh is always available).
  // We detect Windows target via the Tauri target triple env or host platform.
  const hostIsWindows = process.platform === 'win32'
  const tauriTarget = process.env.TAURI_ENV_TARGET_TRIPLE || ''
  const targetIsWindows = hostIsWindows || tauriTarget.includes('windows')
  if (!targetIsWindows) {
    console.log('[fetch-shell-runtime] non-Windows target — skipping (native sh)')
    return
  }

  const arch = archFor(process.env.npm_config_arch || process.arch)
  const targetDir = join(__dirname, '..', 'src-tauri', 'resources', 'shell', `win-${arch}`)
  const binaryPath = join(targetDir, 'busybox.exe')

  // Cache check: skip if already present (idempotent).
  if (existsSync(binaryPath)) {
    const size = statSync(binaryPath).size
    if (size > 1_000_000) {
      console.log(`[fetch-shell-runtime] cached ${binaryPath} (${(size / 1024 / 1024).toFixed(1)}MB)`)
      return
    }
  }

  mkdirSync(targetDir, { recursive: true })

  // busybox-w32 naming: busybox-w32-<arch>_FRP-xxxx.exe
  const fileName = `busybox-w32-${arch}_${BUSYBOX_VERSION}.exe`
  const url = `${BUSYBOX_BASE}/${fileName}`
  const tmpPath = join(targetDir, '.busybox.tmp')

  console.log(`[fetch-shell-runtime] downloading ${url}`)
  await download(url, tmpPath)

  // Basic sanity: file must be > 1MB (busybox is ~3MB).
  const size = statSync(tmpPath).size
  if (size < 1_000_000) {
    throw new Error(`downloaded file too small (${size} bytes) — likely a 404 page`)
  }

  const { renameSync, unlinkSync } = await import('node:fs')
  try { unlinkSync(binaryPath) } catch { /* may not exist */ }
  renameSync(tmpPath, binaryPath)
  console.log(`[fetch-shell-runtime] ready ${binaryPath} (${(size / 1024 / 1024).toFixed(1)}MB)`)
}

main().catch((err) => {
  console.error('[fetch-shell-runtime] failed:', err.message)
  console.error('[fetch-shell-runtime] Windows bash will fall back to PowerShell — set BUSYBOX_MIRROR if upstream is unreachable')
  // Non-fatal: the build continues; Windows users get PowerShell fallback + Git Bash guide banner.
  process.exit(0)
})
