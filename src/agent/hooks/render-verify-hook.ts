import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Render-Verify Hook（渲染自检）— postTurn advisory。
 *
 * 失败模式：agent 改完 UI 文件（.tsx/.jsx/.vue/.svelte/.css/.html）后直接
 * 交付，不检查渲染结果——纯代码审查无法捕获布局错位、样式断裂、组件缺失
 * 等视觉问题。
 *
 * 机制：
 *   - 检测本会话是否编辑了 UI 文件（touchedUiFiles flag）
 *   - 检测是否出现了视觉验证动作（browser screenshot / computer_use
 *     snapshot / browser_debug — sawVisualVerify flag）
 *   - 有 UI 编辑 + 零视觉验证 → 提交 advisory
 *   - 能力降级：browser / computer_use 未注册时 advisory 切换为人工过目提示
 *   - 冷却：每会话最多 2 次
 *   - 环境变量 RIVET_RENDER_VERIFY=0 禁用
 *
 * 反证 3（误报防护）：.tsx 纯逻辑重构也可触发 touchedUiFiles。v1 由扩展名
 * 判断，admitting 一定误报率；后续可加 diff 启发（className/style/标签结构）
 * 收紧判据。冷却机制兜底。
 */

/** UI 文件扩展名（不含测试和 scratch）。 */
const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.css', '.html'])

/** 视觉验证工具名。 */
const VISUAL_TOOLS = new Set(['browser', 'computer_use', 'browser_debug'])

export interface RenderVerifyHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 检查 browser/computer_use 是否已注册（能力降级分支）。缺省假定可用。 */
  getVisualToolsAvailable?: () => boolean
  /** 每会话最大触发次数。默认 2。 */
  maxFires?: number
}

export function createRenderVerifyHook(deps: RenderVerifyHookDeps): PostTurnRuntimeHook {
  const maxFires = deps.maxFires ?? 2
  let fireCount = 0

  return {
    phase: 'postTurn',
    name: 'render-verify',
    run(ctx: RuntimeHookContext) {
      const { snapshot } = ctx
      if (!snapshot.touchedUiFiles) return
      if (snapshot.sawVisualVerify) return
      if (fireCount >= maxFires) return

      fireCount++

      const visualAvailable = deps.getVisualToolsAvailable?.() ?? true
      const advice = visualAvailable
        ? 'UI 文件已修改但尚未检查渲染结果。交付前用 browser 截图或 computer_use 查看实际渲染效果，确认布局/样式/组件无误后再交付。'
        : 'UI 文件已修改，但当前环境缺少视觉验证工具（无 Playwright 或非 Pro）。交付前请人工过目渲染结果，确认视觉无误后再交付。'

      deps.advisoryBus.submit({
        key: 'render-verify',
        priority: 0.55,
        category: 'discipline',
        tier: 'operational',
        content: advice,
        ttl: 1,
      })
    },
  }
}

/**
 * 判断文件路径是否为 UI 文件（扩展名匹配，排除测试和 scratch）。
 */
export function isUiFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  // 排除测试文件
  if (lower.includes('__tests__') || lower.includes('.test.') || lower.includes('.spec.')) return false
  // 排除 scratch 临时探针
  if (lower.includes('.rivet/scratch/')) return false
  // 扩展名匹配
  for (const ext of UI_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

/**
 * 判断文件路径是否为视觉验证工具调用目标。
 */
export function isVisualVerifyTool(toolName: string): boolean {
  return VISUAL_TOOLS.has(toolName)
}
