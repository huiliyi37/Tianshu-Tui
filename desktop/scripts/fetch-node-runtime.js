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

import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_NODE_VERSION = '22.23.1'
const NODE_VERSION = process.env.NODE_VERSION || DEFAULT_NODE_VERSION
const FORCE_FETCH = process.env.FORCE_FETCH === '1'

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
    get(url, (res) => {
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
    }).on('error', (err) => {
      file.close()
      rmSync(dest, { force: true })
      reject(err)
    })
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

main().catch((err) => {
  console.error('[fetch-node-runtime] failed:', err.message)
  process.exit(1)
})
