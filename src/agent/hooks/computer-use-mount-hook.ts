import type { AfterPerceptionRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Computer-Use Mount Hook（任务感知自动挂载）— afterPerception。
 *
 * 失败模式：用户任务明确涉及桌面 GUI 操作（原生应用、窗口点击、系统设置），
 * 但 computer_use 在 EXTENDED 层主控不可见——主控要么幻觉调用（Unknown tool
 * 错误），要么退回「我做不到」，用户不知道还有 /tools enable 逃生口。
 *
 * 机制：
 *   - 仅在会话早期（turn ≤ 1）检测——挂载改 tool fingerprint，中途挂载会
 *     造成一次性全前缀缓存 miss；turn 0-1 时前缀尚短，代价最小。
 *   - 用户意图文本命中桌面 GUI 关键词 → 调 AgentLoop.enableTool('computer_use')
 *     （幂等；未注册时返回 'unknown'，静默跳过——非 Pro / 非 darwin/win32 场景）。
 *   - 挂载成功后经 advisory 告知模型工具已就位（否则模型不知道 schema 变了）。
 *   - 每会话最多挂载一次。
 *
 * 误报代价评估：多挂一个工具只增加 ~1 个 schema 的注意力占用，且 computer_use
 * 每个动作仍需逐应用审批——挂载本身无副作用，宁可略宽不可漏挂。
 */

/** 桌面 GUI 意图关键词（中英）。命中任一即认为任务可能需要 computer_use。 */
const DESKTOP_INTENT_PATTERNS: RegExp[] = [
  // 中文：桌面/原生应用操作意图
  /桌面(应用|软件|自动化|操作)/,
  /(打开|操作|点击|控制|自动化).{0,12}(应用|软件|窗口|菜单|系统设置|偏好设置)/,
  /(gui|界面).{0,8}(自动化|操作|点击)/i,
  /屏幕(截图|录制|上的)/,
  // 常见原生应用名（明确超出 web/CLI 能力范围的目标）
  /(finder|访达|系统设置|system settings|系统偏好|activity monitor|活动监视器)/i,
  /(操作|打开|用|控制)\s*(excel|word|powerpoint|keynote|pages|numbers|photoshop|微信|钉钉|飞书)/i,
  // 英文
  /\b(desktop|native)\s+(app|application|automation)\b/i,
  /\b(click|type|operate)\b.{0,24}\b(app|window|menu|dialog)\b/i,
  /\bcomputer[\s_-]?use\b/i,
]

export function detectDesktopIntent(text: string | null | undefined): boolean {
  if (!text) return false
  return DESKTOP_INTENT_PATTERNS.some(re => re.test(text))
}

export interface ComputerUseMountHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 用户意图文本（任务契约 objective 或首条用户消息）。 */
  getUserIntent: () => string | null
  /** AgentLoop.enableTool 桥——幂等，未注册/非 EXTENDED/门控关闭时返回对应 status。 */
  enableTool: (name: string) => { status: string }
  /** 早期窗口上限（含）。默认 1（turn 0-1）。 */
  maxTurn?: number
}

export function createComputerUseMountHook(deps: ComputerUseMountHookDeps): AfterPerceptionRuntimeHook {
  const maxTurn = deps.maxTurn ?? 1
  let done = false

  return {
    phase: 'afterPerception',
    name: 'computer-use-mount',
    run(ctx: RuntimeHookContext) {
      if (done) return
      // 缓存约束：只在会话早期挂载（fingerprint 变更代价最小的窗口）。
      if (ctx.snapshot.turn > maxTurn) {
        done = true
        return
      }
      if (!detectDesktopIntent(deps.getUserIntent())) return

      done = true
      const result = deps.enableTool('computer_use')
      // unknown = 工具未注册（非 Pro / 平台不支持）；gating-off = 本就全量可见。
      if (result.status !== 'mounted') return

      deps.advisoryBus.submit({
        key: 'computer-use-mounted',
        priority: 0.6,
        category: 'background',
        tier: 'operational',
        content:
          '检测到任务涉及桌面 GUI 操作，computer_use 工具已自动挂载可用。' +
          '用 snapshot(app) 读取应用可访问性树，find/click/type 操作元素；' +
          '每个动作需用户逐应用审批。优先结构化工具（CLI/API），GUI 是兜底。',
        ttl: 2,
      })
    },
  }
}
