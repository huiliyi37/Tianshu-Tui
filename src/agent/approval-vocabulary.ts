/**
 * 对外权限词表 — 零依赖叶子。
 *
 * 后端 ApprovalMode 四枚举不动。对外只暴露三档：
 *   监督 / 自动 / 全自动（en: Supervise / Auto / Unattended）
 *
 * 桌面经 src/server/ui-shared 消费；禁止从此文件 import 运行时模块。
 * 规格：docs/specs/2026-08-25-权限词统一.md
 */

export const PERMISSION_TIERS = ['supervise', 'auto', 'unattended'] as const
export type PermissionTier = (typeof PERMISSION_TIERS)[number]

/** 与 loop-types.ApprovalMode 字面量对齐，本叶子不 import 以免拖运行时。 */
export type ApprovalWireMode =
  | 'auto-accept'
  | 'auto-safe'
  | 'manual'
  | 'dangerously-skip-permissions'

export type PermissionLang = 'zh' | 'en'

export const TIER_TO_WIRE: Record<PermissionTier, ApprovalWireMode> = {
  supervise: 'manual',
  auto: 'auto-safe',
  unattended: 'dangerously-skip-permissions',
}

export const TIER_LABEL: Record<PermissionLang, Record<PermissionTier, string>> = {
  zh: { supervise: '监督', auto: '自动', unattended: '全自动' },
  en: { supervise: 'Supervise', auto: 'Auto', unattended: 'Unattended' },
}

export const TIER_HINT: Record<PermissionLang, Record<PermissionTier, string>> = {
  zh: {
    supervise: '每个高风险工具都弹确认。最大控制，适合敏感项目。',
    auto: '低/无风险工具自动执行，高风险仍需确认。可配每 N 轮暂停检查点。',
    unattended: '全自动执行，无审批打扰；写边界仍在（沙箱自动开启）。回滚兜底。',
  },
  en: {
    supervise: 'Confirm every high-risk tool. Maximum control.',
    auto: 'Auto-run low/no-risk tools; still confirm high-risk. Optional checkpoint every N turns.',
    unattended: 'No approval prompts; write sandbox stays on. Rollback is the safety net.',
  },
}

const ALIAS_TO_TIER: Record<string, PermissionTier> = {
  supervise: 'supervise',
  manual: 'supervise',
  auto: 'auto',
  default: 'auto',
  unattended: 'unattended',
  yolo: 'unattended',
  yes: 'unattended',
  autonomous: 'unattended',
}

export function modeToTier(mode: string | undefined): PermissionTier {
  switch (mode) {
    case 'manual':
      return 'supervise'
    case 'dangerously-skip-permissions':
      return 'unattended'
    case 'auto-accept':
    case 'auto-safe':
    default:
      return 'auto'
  }
}

export function tierToMode(tier: PermissionTier): ApprovalWireMode {
  return TIER_TO_WIRE[tier]
}

/** 解析用户敲的档位词。`auto-accept` 是隐档，不进三档别名。 */
export function parsePermissionAlias(token: string): PermissionTier | undefined {
  const key = token.trim().toLowerCase()
  return ALIAS_TO_TIER[key]
}

export function formatPermissionLabel(
  mode: string | undefined,
  lang: PermissionLang = 'zh',
): string {
  return TIER_LABEL[lang][modeToTier(mode)]
}

export function formatTierLabel(tier: PermissionTier, lang: PermissionLang = 'zh'): string {
  return TIER_LABEL[lang][tier]
}

/** TUI 底栏 / 欢迎屏用的短标签（与选择器主词同一套）。 */
export function formatPermissionChrome(mode: string | undefined, lang: PermissionLang = 'zh'): string {
  return formatPermissionLabel(mode, lang)
}

export const PERMISSION_PICKER_TIERS: readonly PermissionTier[] = PERMISSION_TIERS
