import { existsSync, readFileSync } from 'node:fs'
import { findProjectConfig } from '../config/manager.js'
import { userConfigPath } from '../config/paths.js'
import { isRuntimeLean } from '../config/runtime-lean.js'

/**
 * Tool preset — 会话启动期的工具装配档位（会话内冻结，前缀缓存零影响）。
 *
 * 三档语义（2026-07-19 工具审计落地，入口成本实测见 .rivet/scratch/tool-audit.ts）：
 * - **minimal（30 个）**：日常开发全能力——读写/检索/bash/git/测试/委托/
 *   交付/plan/web_search/web_fetch。去掉编排（council/team）、browser 系、
 *   attack_case、semantic_search 等重而冷门的工具。
 * - **frontend（默认，31）**：minimal + browser_debug（UI 渲染验证闭环）。
 * - **full（45）**：全集，含 attack_case/council/team/semantic_search/repo_graph/
 *   undo/recall_general/record_general_finding/ast_edit/related_tests/
 *   inspect_project/import_resource/leave_mark/browser_debug/monitor。
 *
 * 解析优先级：`RIVET_TOOL_PRESET` env > 项目 `.rivet-config.json` tools.preset
 * > 用户配置 tools.preset（`userConfigPath()`，认 RIVET_HOME/RIVET_CONFIG_PATH）
 * > lean 默认 `minimal` > 'frontend'。
 * 变更只在下个会话生效（会话中途改工具指纹 = 前缀全量重建，反经济）。
 */

export type ToolPreset = 'minimal' | 'frontend' | 'full'

const VALID = new Set<string>(['minimal', 'frontend', 'full'])

function parsePreset(raw: unknown): ToolPreset | null {
  return typeof raw === 'string' && VALID.has(raw) ? (raw as ToolPreset) : null
}

const memo = new Map<string, ToolPreset>()

export function resolveToolPreset(cwd: string): ToolPreset {
  const cached = memo.get(cwd)
  if (cached) return cached

  let preset: ToolPreset | null = parsePreset(process.env.RIVET_TOOL_PRESET)

  if (!preset) {
    const projectPath = findProjectConfig(cwd)
    if (projectPath && existsSync(projectPath)) {
      try {
        const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as { tools?: { preset?: unknown } }
        preset = parsePreset(raw.tools?.preset)
      } catch { /* malformed project config — fall through */ }
    }
  }

  if (!preset) {
    // 必须与写侧同源（saveToolPresetConfig → userConfigPath）。用
    // defaultRivetHome() 会漏掉 RIVET_HOME/RIVET_CONFIG_PATH——桌面端便携模式
    // 与自定义存储路径下设置页写的档位就永远读不回来，UI 显示已保存却无效。
    const userPath = userConfigPath()
    if (existsSync(userPath)) {
      try {
        const raw = JSON.parse(readFileSync(userPath, 'utf-8')) as { tools?: { preset?: unknown } }
        preset = parsePreset(raw.tools?.preset)
      } catch { /* malformed user config — fall through */ }
    }
  }

  const resolved = preset ?? (isRuntimeLean(undefined, cwd) ? 'minimal' : 'frontend')
  memo.set(cwd, resolved)
  return resolved
}

/** Drop the per-cwd memo (settings changed / tests) so the next session
 *  resolves the preset fresh. Long-lived processes (desktop sidecar) must
 *  call this after persisting a preset change. */
export function invalidateToolPreset(): void {
  memo.clear()
}

/** Test-only: drop the per-cwd memo so env/config edits take effect. */
export function __resetToolPresetForTest(): void {
  invalidateToolPreset()
}

/** minimal 排除名单（kernel + bootstrap 统一）。full 全集；frontend 仅加
 *  browser_debug。判断逻辑见 presetIncludes。 */
const MINIMAL_EXCLUDES: ReadonlySet<string> = new Set([
  // 编排（重 + 日常低频）。team_orchestrate 2026-07-29 移除——它是唯一
  // 多 worker 波次编排入口，主控必须可见（T3 修复：随 tool-tiers 升入 CORE）。
  'council_convene',
  // browser 系
  'browser_debug',
  // 重而冷门 / 零使用（2026-07-19 会话使用率审计）
  'attack_case',
  'semantic_search',
  'repo_graph',
  'undo',
  'recall_general',
  'record_general_finding',
  'ast_edit',
  'related_tests',
  'inspect_project',
  'import_resource',
  'leave_mark',
  // 2026-07-22 minimal 再瘦身（会话日志使用率实测验证）：极低频工具
  'file_info',
  'session_vitals',
  'update_goal',
  // monitor 事件订阅（full 档专属——引导模型改干等为订阅的进阶能力）
  'monitor',
  // 整站爬取/发现（重 + 非常用；RIVET_WEB_CRAWL/RIVET_WEB_MAP=1 可单独强制开启）
  'web_crawl',
  'web_map',
])

/** 判断某工具在给定档位下是否注册。 */
export function presetIncludes(preset: ToolPreset, toolName: string): boolean {
  if (preset === 'full') return true
  if (preset === 'frontend' && toolName === 'browser_debug') return true
  return !MINIMAL_EXCLUDES.has(toolName)
}
