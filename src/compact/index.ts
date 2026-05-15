export { microCompact, estimateTokens } from './micro.js'
export {
  shouldAutoCompact,
  buildSummaryPrompt,
  type CompactionDecision,
} from './auto.js'
export type { CompactionConfig } from './constants.js'
export {
  AUTO_COMPACT_THRESHOLD,
  MINIMUM_AUTO_COMPACT_TOKENS,
  KEEP_RECENT_MESSAGES,
} from './constants.js'
