import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

export interface ToolVersion {
  available: boolean
  version?: string
  command: string
  /** Absolute path when found on PATH, otherwise the bare command name. */
  path?: string
}

export interface PythonEnvInfo {
  python: ToolVersion
  uv: ToolVersion
  git: ToolVersion
  node: ToolVersion
  platform: NodeJS.Platform
}

const PYTHON_INSTALL_GUIDE: Record<string, string> = {
  darwin: 'macOS 推荐：brew install python\n或从 https://www.python.org/downloads/ 下载安装包。',
  win32: 'Windows 推荐：\n1. Microsoft Store 搜索并安装 "Python 3.12"\n2. 或从 https://www.python.org/downloads/windows/ 下载安装程序，安装时勾选 "Add Python to PATH"。',
  linux: 'Linux 推荐：\nsudo apt update && sudo apt install python3 python3-pip python3-venv\n（Fedora 用 dnf install python3 python3-pip）',
}

const UV_INSTALL_GUIDE: Record<string, string> = {
  darwin: 'macOS: curl -LsSf https://astral.sh/uv/install.sh | sh\n或: brew install uv',
  win32: 'Windows PowerShell: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
  linux: 'Linux: curl -LsSf https://astral.sh/uv/install.sh | sh',
}

const GIT_INSTALL_GUIDE: Record<string, string> = {
  darwin: 'macOS: xcode-select --install\n或: brew install git',
  win32: 'Windows: https://git-scm.com/download/win 下载安装程序，安装时勾选 "Git from the command line".',
  linux: 'Linux: sudo apt install git\n（Fedora 用 dnf install git）',
}

function platformName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return 'Linux'
}

/** Try to locate a command on PATH and return its absolute path if found. */
export async function which(command: string): Promise<string | undefined> {
  try {
    const shell = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(shell, [command], { timeout: 5000 })
    const first = stdout.split('\n')[0]?.trim()
    return first && first.length > 0 ? first : undefined
  } catch {
    return undefined
  }
}

async function getVersion(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5000 })
    const line = stdout.split('\n')[0]?.trim()
    return line && line.length > 0 ? line : undefined
  } catch {
    return undefined
  }
}

async function detectTool(
  commands: string[],
  versionArgs: string[],
): Promise<ToolVersion> {
  for (const command of commands) {
    const path = await which(command)
    if (path) {
      const version = await getVersion(path, versionArgs)
      return { available: true, command, path, version }
    }
  }
  return { available: false, command: commands[0] ?? '' }
}

/** Detect Python, uv, git, node availability on the host. */
export async function detectEnv(cwd?: string): Promise<PythonEnvInfo> {
  const pythonCommands = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python']
  const [python, uv, git, node] = await Promise.all([
    detectTool(pythonCommands, ['--version']),
    detectTool(['uv'], ['--version']),
    detectTool(['git'], ['--version']),
    detectTool(['node'], ['--version']),
  ])
  return {
    python,
    uv,
    git,
    node,
    platform: process.platform,
  }
}

/** Build a human-readable guidance block for missing tools. */
export function formatEnvGuidance(info: PythonEnvInfo): string {
  const lines: string[] = []
  if (!info.python.available) {
    lines.push(`未检测到 Python（${platformName(info.platform)}）。`)
    lines.push(PYTHON_INSTALL_GUIDE[info.platform] ?? PYTHON_INSTALL_GUIDE.linux!)
    lines.push('')
  }
  if (!info.git.available) {
    lines.push(`未检测到 Git（${platformName(info.platform)}）。`)
    lines.push(GIT_INSTALL_GUIDE[info.platform] ?? GIT_INSTALL_GUIDE.linux!)
    lines.push('')
  }
  if (info.python.available && !info.uv.available) {
    lines.push('已检测到 Python。推荐安装 uv 以自动管理 Python 版本和依赖：')
    lines.push(UV_INSTALL_GUIDE[info.platform] ?? UV_INSTALL_GUIDE.linux!)
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** Per-platform install commands for a missing tool. */
export function getInstallCommand(tool: 'python' | 'git' | 'uv', platform: NodeJS.Platform): string {
  const map = tool === 'python' ? PYTHON_INSTALL_GUIDE : tool === 'git' ? GIT_INSTALL_GUIDE : UV_INSTALL_GUIDE
  return map[platform] ?? map.linux!
}

/** True if cwd looks like a Python project. */
export function isPythonProject(cwd: string): boolean {
  const markers = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']
  return markers.some(m => existsSync(join(cwd, m)))
}

export interface UvSetupResult {
  ok: boolean
  message: string
  command?: string
}

/**
 * Recommend the right uv command to bootstrap a Python project.
 * Does not execute anything — callers (e.g. slash command) run the returned command.
 */
export function recommendUvSetup(cwd: string): UvSetupResult {
  if (!isPythonProject(cwd)) {
    return { ok: false, message: '当前目录不像 Python 项目（缺少 pyproject.toml / requirements.txt / setup.py）。' }
  }
  if (existsSync(join(cwd, 'pyproject.toml'))) {
    return { ok: true, message: '检测到 pyproject.toml，将使用 uv sync 安装依赖。', command: 'uv sync' }
  }
  if (existsSync(join(cwd, 'requirements.txt'))) {
    return { ok: true, message: '检测到 requirements.txt，将使用 uv venv + uv pip install 安装依赖。', command: 'uv venv && uv pip install -r requirements.txt' }
  }
  return { ok: false, message: '检测到 Python 项目标记，但未找到 pyproject.toml 或 requirements.txt。' }
}

/** Build a one-line hint appended to bash not-found errors. */
export function buildNotFoundHint(missingCommand: string, platform: NodeJS.Platform): string {
  if (missingCommand === 'python' || missingCommand === 'python3' || missingCommand === 'py') {
    return `\n[环境缺失] ${getInstallCommand('python', platform)}`
  }
  if (missingCommand === 'git') {
    return `\n[环境缺失] ${getInstallCommand('git', platform)}`
  }
  if (missingCommand === 'uv') {
    return `\n[环境缺失] ${getInstallCommand('uv', platform)}`
  }
  return ''
}

/** Best-effort extract the missing command name from a not-found error body. */
export function extractMissingCommand(body: string, command: string): string {
  const m1 = body.match(/The term '([^']+)' is not recognized/i)
  if (m1) return m1[1]!
  const m2 = body.match(/'([^']+)' is not recognized as an internal/i)
  if (m2) return m2[1]!
  const m3 = body.match(/command not found:\s*(\S+)/i)
  if (m3) return m3[1]!
  const m4 = body.match(/(\S+):\s*command not found/i)
  if (m4) return m4[1]!
  return command.trim().split(/\s+/)[0] ?? ''
}
