import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from './paths.js'

/**
 * P2 Wave 3: profile 分层（对标 dsh $DSH_HOME/profiles 的最小等价）。
 *
 * profile 是命名配置覆盖块：`$RIVET_HOME/profiles/<name>.json`，作为配置加载
 * 链的一层（defaults → user → project → **profile** → session overlay）。
 * 选择：`RIVET_PROFILE=<name>` env 或 `--profile <name>` CLI flag（main.ts 注入 env）。
 *
 * 内置 profile（代码常量，无需落盘）：
 * - `default`：无覆盖（缺省即 default）
 * - `lean`：禁用重 hook（dream / skill-distill / anchor-break-scout），与
 *   RIVET_LEAN 资源档同向
 *
 * 回滚语义：删 profile 文件或换 profile 即回滚（文件即配置，无状态）。
 * 热更：profile 文件变更经 config-watcher 生效（watch 用户配置的同一机制；
 *  profile 文件在 watcher 启动时已存在才会被监听——documented limitation）。
 */

export const PROFILE_DIR_NAME = 'profiles'

export function profilesDir(): string {
  return join(rivetHome(), PROFILE_DIR_NAME)
}

export function profilePath(name: string): string {
  return join(profilesDir(), `${name}.json`)
}

/** 解析生效的 profile 名：显式 flag 优先于 RIVET_PROFILE env；无则 undefined。 */
export function resolveProfileName(flag?: string): string | undefined {
  const name = flag?.trim()
  if (name) return name
  const env = process.env.RIVET_PROFILE?.trim()
  return env || undefined
}

/**
 * 解析 RIVET_HOOKS_DISABLED env（逗号分隔，去空白）。undefined = env 未设。
 * 装配与热更两条路径共用（loop-factory re-export），保证 env 优先级一致。
 */
export function resolveHookDisabledEnv(): string[] | undefined {
  const env = process.env.RIVET_HOOKS_DISABLED
  if (env !== undefined && env.trim() !== '') {
    return env.split(',').map(s => s.trim()).filter(s => s.length > 0)
  }
  return undefined
}

/** 读取用户 profile 文件的配置覆盖块。文件缺失/坏 JSON → 空覆盖（fail-closed 不生效）。 */
export function loadProfileOverlay(name: string): Record<string, unknown> {
  const p = profilePath(name)
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** 内置 lean profile：禁用重 hook（dream-distill 会话复盘 / skill-distill / anchor-break-scout）。
 *  hook id 与 create-runtime-hooks.ts 装配的 name 字段逐一核对（dream-hook.ts:41 等）。 */
export const LEAN_PROFILE: Record<string, unknown> = {
  hooks: {
    disabled: ['dream-distill', 'skill-distill', 'anchor-break-scout'],
  },
}

/** 解析 profile 覆盖块：内置名（lean）优先于用户文件；default/空 → 无覆盖。 */
export function resolveProfileOverlay(name: string | undefined): Record<string, unknown> {
  if (!name) return {}
  if (name === 'default') return {}
  if (name === 'lean') return LEAN_PROFILE
  return loadProfileOverlay(name)
}
