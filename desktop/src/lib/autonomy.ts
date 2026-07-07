// Autonomy levels (S) — the desktop's 3-step framing over the backend's
// ApprovalMode enum. We expose three user-facing levels and map them to the
// underlying approval modes the agent pipeline understands.
//
//   监督 supervised  → manual                        每个风险操作都问
//   默认 default     → auto-safe                     项目内低风险自动，高风险问
//   自治 autonomous  → dangerously-skip-permissions  项目内全自动；项目外靠沙箱 + 回滚兜底
//
// Safety: the autonomous level only skips approval prompts. The OS sandbox
// (sandbox-profile) still blocks writes outside the project dir, and every
// mutating turn writes a checkpoint, so rollback remains the safety net.
import type { ApprovalMode } from '../runtime/types'
import i18n from '../i18n'

export type AutonomyLevel = 'supervised' | 'default' | 'autonomous'

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['supervised', 'default', 'autonomous']

/** Coerce a persisted/raw string into a valid level; falls back to 'default'. */
export function coerceLevel(s?: string | null): AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(s ?? '') ? (s as AutonomyLevel) : 'default'
}

const LEVEL_TO_MODE: Record<AutonomyLevel, ApprovalMode> = {
  supervised: 'manual',
  default: 'auto-safe',
  autonomous: 'dangerously-skip-permissions',
}

export function levelToMode(level: AutonomyLevel): ApprovalMode {
  return LEVEL_TO_MODE[level]
}

export function modeToLevel(mode?: ApprovalMode): AutonomyLevel {
  switch (mode) {
    case 'manual':
      return 'supervised'
    case 'auto-accept':
    case 'dangerously-skip-permissions':
      return 'autonomous'
    default:
      return 'default' // 'auto-safe' or undefined
  }
}

export interface LevelMeta {
  label: string
  glyph: string
  hint: string
}

// Lazy getters: labels/hints resolve at access time so they follow the active
// i18n language (a plain const would freeze whatever language loaded first).
export const LEVEL_META: Record<AutonomyLevel, LevelMeta> = {
  get supervised(): LevelMeta {
    return { label: i18n.t('autonomy:supervised'), glyph: '◆', hint: i18n.t('autonomy:supervisedHint') }
  },
  get default(): LevelMeta {
    return { label: i18n.t('autonomy:default'), glyph: '◈', hint: i18n.t('autonomy:defaultHint') }
  },
  get autonomous(): LevelMeta {
    return { label: i18n.t('autonomy:autonomous'), glyph: '✦', hint: i18n.t('autonomy:autonomousHint') }
  },
}

/** True for the unattended level whose UX needs guardrail surfacing. */
export function isAutonomous(mode?: ApprovalMode): boolean {
  return modeToLevel(mode) === 'autonomous'
}

// ── Full access (完全访问) ──────────────────────────────────────────
// A composer-level tier above 'autonomous': same approval mode, plus a
// standing whole-disk READ grant (permissions.additionalReadDirs gets the
// filesystem root). Write access stays sandboxed as usual.

/** The union shown by the composer's access-level menu. */
export type AccessChoice = AutonomyLevel | 'full-access'

/** Filesystem root used for the whole-disk read grant on this platform. */
export function fullDiskRootPath(): string {
  return isWindows() ? 'C:\\' : '/'
}

/** True when `p` is a filesystem root ('/' or a Windows drive root like F:\). */
export function isFullDiskRoot(p: string): boolean {
  const t = p.trim()
  return t === '/' || /^[A-Za-z]:[\\/]?$/.test(t)
}

/** Best-effort: are we on Windows, where the write sandbox falls through to none? */
export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return /win/i.test(p || navigator.platform || navigator.userAgent || '')
}
