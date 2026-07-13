/**
 * Resolve bare `npx` / `npm` to `node + *-cli.js` so stdio spawns work when
 * shell is forced off (MCP SDK StdioClientTransport) and Windows GUI PATH
 * lacks `npx.cmd`.
 *
 * Layout mirrors the official Node archive / fetch-node-runtime bundling:
 *   Windows: <nodeDir>/node_modules/npm/bin/{npx,npm}-cli.js
 *   Unix:    <nodeDir>/lib/node_modules/npm/bin/{npx,npm}-cli.js
 */
import { existsSync } from 'node:fs'
import { basename, win32 as winPath, posix as posixPath } from 'node:path'

export interface ResolveNodeCliDeps {
  execPath?: string
  platform?: NodeJS.Platform
  existsSync?: (path: string) => boolean
}

export interface ResolvedStdioCommand {
  command: string
  args: string[]
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? winPath : posixPath
}

function bareName(command: string): string {
  const base = basename(command.replace(/\\/g, '/'))
  // Strip Windows .cmd/.bat/.exe so "npx.cmd" still matches.
  return base.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase()
}

function cliCandidates(kind: 'npx' | 'npm', nodeDir: string, platform: NodeJS.Platform): string[] {
  const p = pathApi(platform)
  const file = kind === 'npx' ? 'npx-cli.js' : 'npm-cli.js'
  if (platform === 'win32') {
    return [p.join(nodeDir, 'node_modules', 'npm', 'bin', file)]
  }
  // Packaged desktop: node binary is flat in targetDir, npm under lib/.
  // Official Node archive: binary in bin/, npm under ../lib/.
  return [
    p.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', file),
    p.join(p.dirname(nodeDir), 'lib', 'node_modules', 'npm', 'bin', file),
    p.join(nodeDir, 'node_modules', 'npm', 'bin', file),
  ]
}

/**
 * If `command` is npm/npx (bare or *.cmd), rewrite to the hosting Node binary
 * plus the matching cli.js. Unknown commands / missing cli → pass through.
 */
export function resolveNpmCliCommand(
  command: string,
  args: string[] = [],
  deps: ResolveNodeCliDeps = {},
): ResolvedStdioCommand {
  const name = bareName(command)
  if (name !== 'npx' && name !== 'npm') {
    return { command, args: [...args] }
  }

  const execPath = deps.execPath ?? process.execPath
  const platform = deps.platform ?? process.platform
  const exists = deps.existsSync ?? existsSync
  const p = pathApi(platform)
  const nodeDir = p.dirname(execPath)

  for (const candidate of cliCandidates(name, nodeDir, platform)) {
    if (exists(candidate)) {
      return { command: execPath, args: [candidate, ...args] }
    }
  }

  return { command, args: [...args] }
}

/**
 * Build an env object for MCP stdio transports: always explicit, with the
 * hosting Node directory prepended to PATH so npx-cli can find the same node.
 * User-supplied env is merged, but nodeDir is written last onto PATH.
 */
export function buildStdioEnvWithNodePath(
  userEnv?: Record<string, string>,
  deps: ResolveNodeCliDeps & {
    getDefaultEnvironment?: () => Record<string, string>
  } = {},
): Record<string, string> {
  const getDefault = deps.getDefaultEnvironment
    ?? (() => {
      const out: Record<string, string> = {}
      for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
        const v = process.env[key]
        if (v !== undefined) out[key] = v
      }
      return out
    })
  const base = getDefault()
  const user = userEnv ?? {}
  const execPath = deps.execPath ?? process.execPath
  const platform = deps.platform ?? process.platform
  const p = pathApi(platform)
  const pathSep = platform === 'win32' ? ';' : ':'
  const nodeDir = p.dirname(execPath)
  const pathRest = user.PATH ?? user.Path ?? base.PATH ?? base.Path ?? ''
  return {
    ...base,
    ...user,
    PATH: pathRest ? `${nodeDir}${pathSep}${pathRest}` : nodeDir,
  }
}
