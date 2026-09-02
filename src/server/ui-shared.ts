/**
 * 桌面端「非 wire 共享面」的唯一入口。
 *
 * protocol.ts 承载 wire 契约（SSE 事件、会话记录），本模块承载其余需要
 * 两端共享的常量 / 纯函数 / 类型：星域数据表、工具输出标记、日志行解析、
 * 结构化提问 helpers、证据摘要类型。
 *
 * HARD CONSTRAINT（desktop/scripts/check-boundary.js 强制）：
 * - 桌面端指向内核的 import 只允许三个入口：server/protocol、
 *   server/mission-protocol、本模块。
 * - 本模块的 value re-export 只允许指向零依赖（或仅 `import type`）的
 *   叶子模块——任何一条 value import 链出叶子集合，就会把内核运行时
 *   拖进桌面端 bundle。新增共享面时先把实现抽成叶子，再从这里 re-export。
 */

// 星域数据表（纯数据叶子；运行时匹配 API 在 star-domain.ts，不在共享面内）
export {
  STAR_DOMAINS,
  type StarDomain,
  type StarDomainId,
  type DecisionStyle,
} from '../agent/star-domain-data.js'

// 星域产品分层——第一档四颗默认星域与进阶星域（零依赖叶子，欢迎页选择器用）
export {
  STARTER_DOMAIN_IDS,
  getStarDomainTier,
  partitionDomainsByTier,
  type StarDomainTier,
  type StarDomainTierPartition,
} from '../agent/domain-tiers.js'

// 创世碑文（Genesis Stele）——各星域主星模型与碑文记录（纯数据叶子；
// 桌面端「星域图谱 → 创世碑文」页的数据源。单一事实源是仓库根 star.md）
export {
  STAR_GENESIS,
  type GenesisEntry,
  type GenesisFace,
} from '../agent/star-genesis-data.js'

// 工具输出的结构化文案标记（browser-mirror / walkthrough 提取用）
export {
  BROWSER_NAVIGATED_PREFIX,
  BROWSER_SCREENSHOT_OF_PREFIX,
  COMPUTER_USE_A11Y_TREE_PREFIX,
} from '../tools/output-markers.js'

// browser_debug 日志行解析（ToolGroup 渲染网络/控制台行）
export {
  classifyBrowserDebugLine,
  parseNetworkLine,
  type BrowserDebugLineKind,
  type ParsedNetworkRow,
} from '../tools/browser-debug/log-capture.js'

// 结构化提问（QuestionCard 组装答案）
export {
  composeAnswers,
  draftToAnswer,
  type AskAnswerDraft,
} from '../tools/ask-user-question.js'

// 证据摘要（CompletionCurtain / event-reducer 消费的 SSE 载荷类型）
export type { EvidenceSummary, DeliveryVerificationStatus } from '../agent/evidence-types.js'

// 对外权限词表（TUI / 桌面 / 插件同一套监督·自动·全自动）
export {
  PERMISSION_TIERS,
  TIER_HINT,
  TIER_LABEL,
  TIER_TO_WIRE,
  formatPermissionChrome,
  formatPermissionLabel,
  formatTierLabel,
  modeToTier,
  parsePermissionAlias,
  tierToMode,
  type ApprovalWireMode,
  type PermissionLang,
  type PermissionTier,
} from '../agent/approval-vocabulary.js'
