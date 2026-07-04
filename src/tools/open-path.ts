import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Tool } from './types.js'
import { expandHome } from '../platform.js'

export interface OpenPathCommand {
  cmd: string
  args: string[]
}

function normalizeOpenTarget(path: string, platform: NodeJS.Platform): string {
  const expanded = expandHome(path)
  if (platform === 'win32' && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(expanded)) {
    return expanded
  }
  return resolve(expanded)
}

export function buildOpenPathCommand(path: string, platform: NodeJS.Platform = process.platform): OpenPathCommand {
  const target = normalizeOpenTarget(path, platform)
  if (platform === 'win32') {
    // 不用 `cmd.exe /c start`：cmd 对参数做二次解析，路径中的 & | % ^ 等元字符
    // 会被重新解释（注入面）。改用 PowerShell Start-Process -LiteralPath，并把
    // 路径包成单引号字面串（单引号内 & | % ^ $ 全不解释，'' 转义内嵌单引号），
    // -LiteralPath 又禁用通配符。既能正常打开含 & 的合法路径（如 R&D 文件夹），
    // 又消除元字符注入。
    //
    // explorer/Start-Process 对正斜杠路径不友好（前端 toAbsolute 在 cwd 含 '/'
    // 时会拼出 'C:/Users/...'，explorer 会静默失败），统一转反斜杠。
    const winTarget = target.replace(/\//g, '\\')
    const literal = `'${winTarget.replace(/'/g, "''")}'`
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -LiteralPath ${literal}`],
    }
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: [target] }
  }
  return { cmd: 'xdg-open', args: [target] }
}

/** Build a command that reveals a file in the platform file manager. */
export function buildRevealCommand(path: string, platform: NodeJS.Platform = process.platform): OpenPathCommand {
  const target = normalizeOpenTarget(path, platform)
  if (platform === 'win32') {
    // explorer /select,"C:\path\to\file" — invoke through PowerShell so spaces
    // and shell metacharacters are not re-interpreted. Single-quote escaping
    // handles the rare embedded single quote.
    //
    // explorer 对正斜杠路径静默失败（前端可能传 'C:/Users/...'），统一转反斜杠。
    const winTarget = target.replace(/\//g, '\\')
    const literal = `'${winTarget.replace(/'/g, "''")}'`
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `explorer /select,${literal}`],
    }
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: ['-R', target] }
  }
  // Linux: no universal "select file" API; open the containing directory.
  return { cmd: 'xdg-open', args: [dirname(target)] }
}

export const OPEN_PATH_TOOL: Tool = {
  definition: {
    name: 'open_path',
    description: `Open a file or directory in the user's operating system.

Use this for user-visible files such as generated images, SVGs, PDFs, or folders. It accepts external paths (Desktop, Downloads, mounted drives, Windows paths) and avoids shell quoting issues by launching the OS opener directly.

Examples:
Good: open_path(path="~/Desktop/tianshu-logo.svg")
Good: open_path(path="H:\\zhuomian\\白嫖gpt")
Bad: using bash explorer/open/start commands with hand-written shell quoting`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or ~-relative file/directory path to open. May be outside the project.' },
      },
      required: ['path'],
    },
  },

  async execute(params) {
    const raw = params.input.path
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: 'Error: path is required', isError: true }
    }
    const target = resolve(expandHome(raw.trim()))
    if (!existsSync(target)) {
      return { content: `Error: path does not exist: ${target}`, isError: true }
    }
    const command = buildOpenPathCommand(target)

    return new Promise((resolveResult) => {
      const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' })
      child.on('error', (err) => {
        resolveResult({ content: `Error opening ${target}: ${err.message}`, isError: true })
      })
      child.on('spawn', () => {
        child.unref()
        resolveResult({ content: `Opened: ${target}` })
      })
    })
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
