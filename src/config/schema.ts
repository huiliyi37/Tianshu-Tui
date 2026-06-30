import { z } from 'zod'
import { mcpConfigSchema, type McpConfig } from '../mcp/config.js'

export const modelConfigSchema = z.object({
  id: z.string(),
  alias: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
  /** Pricing per 1M tokens (USD). Optional — used by insights / cost visualization. */
  pricing: z.object({
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
    cacheRead: z.number().min(0).optional(),
    cacheWrite: z.number().min(0).optional(),
    reasoning: z.number().min(0).optional(),
  }).optional(),
})

export const authConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('api-key'),
    keyEnv: z.string(),
  }),
  z.object({
    type: z.literal('oauth'),
    provider: z.enum(['codex']),
  }),
])

export const providerCapabilitiesSchema = z.object({
  cacheControl: z.boolean().default(false),
  stripParams: z.array(z.string()).default([]),
  toolJsonBug: z.boolean().default(false),
  prefixCache: z.enum(['deepseek-native', 'anthropic-cache-control', 'none']).default('none'),
  prefixCompletion: z.boolean().default(false),
}).default({})

export const providerSchema = z.object({
  name: z.string(),
  apiKey: z.string().nullable().optional().transform(value => value ?? undefined),
  apiKeyEnv: z.string().nullable().optional().transform(value => value ?? undefined),
  baseUrl: z.string().url(),
  protocol: z.enum(['openai']).default('openai'),
  auth: authConfigSchema.nullable().optional(),
  capabilities: providerCapabilitiesSchema,
  fallback: z.array(z.string()).optional(),
  models: z.array(modelConfigSchema).min(1),
  thinking: z.enum(['enabled', 'disabled']).default('enabled'),
  maxTokens: z.number().int().positive().default(64000),
  /**
   * Thinking-stall timeout (ms): once reasoning tokens have arrived but no text/tool
   * output yet, abort the stream if no further chunk within this window.
   * 默认 undefined = 取 readMs（禁用）。仅对易卡死的 SLOW_THINKING provider（如 glm）
   * 建议显式设置一个 < readMs 的值；factory.ts 对 glm 注入了 120s 内置默认。
   */
  thinkingStallTimeoutMs: z.number().int().positive().optional(),
  unsupported: z.array(z.string()).default([]),
  /**
   * Provider usage calibration factor for `prompt_tokens` (0–1).
   * 1.0 (default) = trust the API's prompt_tokens as-is.
   * 0 = discard prompt_tokens entirely; use local estimateOaiTokens instead.
   * GLM coding API returns prompt_tokens inflated ~20-100x due to server-side
   * reasoning token re-counting; set to 0 for GLM.
   */
  usageCalibrationFactor: z.number().min(0).max(1).optional(),
})

export const permissionAllowRuleSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.string()).optional(),
})

export const bashAllowlistSchema = z.object({
  /** Command prefixes that bypass bash-write approval. Matched by prefix: "git status" allows "git status --porcelain". */
  allowlist: z.array(z.string().min(1)).default([]),
  /** Command prefixes that are always blocked, regardless of mode or allowlist. */
  denylist: z.array(z.string().min(1)).default([]),
}).default({})

export const permissionsSchema = z.object({
  allow: z.array(permissionAllowRuleSchema).default([]),
  /** Deny rules take precedence over allow rules and approval mode. */
  deny: z.array(permissionAllowRuleSchema).default([]),
  bash: bashAllowlistSchema,
})

export const antiAnchoringSchema = z.object({
  enabled: z.boolean().default(false),
  blindExploration: z.boolean().default(true),
  mctsPlanning: z.boolean().default(false),
  branches: z.number().int().positive().default(3),
  planningTurn: z.number().int().positive().default(1),
  projectionThreshold: z.number().min(0).max(1).default(0.4),
  seedMaxTokens: z.number().int().positive().default(512),
  anchorBreakScout: z.object({
    enabled: z.boolean().default(false),
    complexityThreshold: z.number().min(0).max(1).default(0.5),
    minTurn: z.number().int().positive().default(3),
    scoutBudgetMs: z.number().int().positive().default(60_000),
    scoutMaxTokens: z.number().int().positive().default(2048),
  }).default({}),
}).default({})

export const intentRetrievalRouterSchema = z.preprocess(
  value => {
    if (value === true) return { enabled: true }
    if (value === false) return { enabled: false }
    if (value === undefined) return { enabled: true }
    return value
  },
  z.object({
    enabled: z.boolean().default(true),
    classifier: z.enum(['heuristic', 'llm']).default('heuristic'),
    timeoutMs: z.number().int().positive().default(4_000),
    maxTokens: z.number().int().positive().default(600),
    temperature: z.number().min(0).max(2).default(0),
  }).default({}),
)

export const banditPromotionModeSchema = z.enum(['off', 'shadow', 'auto', 'forced'])

/** Per-profile review model override. When set, review workers with the
 *  matching profile use this provider+model instead of the session's primary
 *  model. The provider must exist in config.provider.providers. */
export const reviewProfileOverrideSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

/** Review worker configuration block.
 *  - profiles: per-profile override map; omitted profiles fall back to session model
 *  - skipAuto: bypass deliver_task post-commit auto review (per-config equivalent
 *    of RIVET_REVIEW_DISCIPLINE=0, but scoped to this config file) */
export const reviewConfigSchema = z.object({
  profiles: z.record(z.string(), reviewProfileOverrideSchema).default({}),
  skipAuto: z.boolean().default(false),
  /** Enable mechanical-change fast-path: docs-only and pure rename changes
   *  bypass verification gate (unverified RED only) and skip review workers.
   *  owned_failure RED is NEVER bypassed. Default true. */
  mechanicalFastPath: z.boolean().default(true),
}).default({})

/** Inferred TS type for the review config block. Consumers (e.g. B1Context.reviewConfig)
 *  should use this instead of redeclaring the shape inline. */
export type ReviewConfig = z.infer<typeof reviewConfigSchema>

/** Per-seat council configuration. When `provider`+`model` are set, that seat's
 *  worker runs on an independent provider/model (its own server-side cache),
 *  enabling heterogeneous councils — e.g. one seat on DeepSeek Pro, another on
 *  GLM — for genuine cross-model deliberation. Provider must exist in
 *  config.provider.providers; otherwise the seat silently falls back to the
 *  session model (same rule as agent.review / workers routing). */
export const councilSeatConfigSchema = z.object({
  authority: z.string().min(1),
  charter: z.string().optional(),
  tierHint: z.enum(['cheap', 'balanced', 'strong']).optional(),
  noDowngrade: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

/** council_convene seat configuration. `seats` overrides the built-in
 *  tianquan/tianfu/tianxuan default when non-empty. */
export const councilConfigSchema = z.object({
  seats: z.array(councilSeatConfigSchema).default([]),
}).default({})

export type CouncilConfig = z.infer<typeof councilConfigSchema>

export const agentSchema = z.object({
  approval: z.enum(['auto-accept', 'auto-safe', 'suggest', 'manual', 'dangerously-skip-permissions']).default('auto-safe'),
  maxTurns: z.number().int().positive().default(50),
  mode: z.enum(['code', 'ask', 'plan']).default('code'),
  autoReasoning: z.boolean().default(true),
  /** Explicit opt-in for Songline substrate post-session pheromone/cycle relay. */
  songlineEnabled: z.boolean().default(false),
  /** Enable cross-session knowledge loading (memory block, playbook, companion presence).
   *  Default true — injects distilled project knowledge from .rivet/knowledge/.
   *  Set false for fully isolated sessions. Env RIVET_NO_CROSS_SESSION=1 overrides as force-off. */
  crossSessionEnabled: z.boolean().default(true),
  /** T8 桌面化办公工具（create_document 等 7 个）。默认关闭以守住工具数 kernel budget（≤25）。 */
  desktopTools: z.boolean().default(false),
  /** Tool gating: 主控工具分层门控。enabled 时只暴露 CORE_TOOLS 给主控，
   *  EXTENDED 工具下放子代理。关闭则全量暴露（向后兼容）。 */
  toolGating: z.object({
    enabled: z.boolean().default(true),
    /** 可选：覆盖默认 CORE 清单（工具名数组） */
    coreTools: z.array(z.string()).optional(),
    /** 可选：额外加入 CORE 的工具名（追加到默认清单） */
    extraCore: z.array(z.string()).default([]),
  }).default({ enabled: true }),
  /** Explicit opt-in for HEARTH anchor invariant observation (postTurn, diagnostic only). */
  hearthObserveEnabled: z.boolean().default(false),
  /** Explicit opt-in for anti-anchoring harness hooks (prompt-flow intervention). */
  antiAnchoring: antiAnchoringSchema,
  /** Explicit opt-in for auto-delegation of exploration tasks. Default off — workers cost API budget. */
  autoDelegateEnabled: z.boolean().default(false),
  /** Max nesting depth for delegation (a worker delegating to a sub-worker). Default 2. */
  maxDelegationDepth: z.number().int().positive().default(2),
  /** Default max concurrent workers per team wave when input.maxParallel is unset. Clamped 1..5. */
  maxTeamParallel: z.number().int().min(1).max(5).default(3),
  /** council_convene seat configuration — custom seats with optional per-seat
   *  provider/model for heterogeneous (cross-model) councils. */
  council: councilConfigSchema,
  /**
   * Max auto-continue iterations per run when a no-tool turn shows action intent
   * or an open task contract (phantom tool-call recovery). 0 disables. Clamped 0..3.
   */
  maxAutoContinue: z.number().int().min(0).max(3).default(1),
  /** Explicit opt-in for current-turn intent retrieval route guidance. */
  intentRetrievalRouter: intentRetrievalRouterSchema,
  /** @deprecated Use banditPromotion.teamScheduler ('forced') instead. True still works as forced. */
  teamSchedulerBanditEnabled: z.boolean().default(false),
  /** @deprecated Use banditPromotion.modelTier ('forced') instead. True still works as forced. */
  modelTierBanditEnabled: z.boolean().default(false),
  /** @deprecated Use banditPromotion.modelRouting ('forced') instead. True still works as forced. */
  modelRoutingGatedEnabled: z.boolean().default(false),
  /** Track 1: 统一 bandit shadow→gated 晋升闸。
   *  off=一键回退 / shadow=只收证据 / auto=证据达标自动 gated / forced=手动覆盖。 */
  banditPromotion: z.object({
    modelTier: banditPromotionModeSchema.default('shadow'),
    teamScheduler: banditPromotionModeSchema.default('shadow'),
    modelRouting: banditPromotionModeSchema.default('shadow'),
    effort: banditPromotionModeSchema.default('shadow'),
    /** One-key rollback: forces every bandit path off, regardless of modes or legacy flags. */
    killSwitch: z.boolean().default(false),
  }).default({}),
  permissions: permissionsSchema.default({}),
  /** Review worker model routing — see reviewConfigSchema. */
  review: reviewConfigSchema,
  /** Goal autonomy (/goal & --goal) completion judge. */
  goal: z.object({
    judge: z.object({
      /** Independently verify a self-declared completion before accepting. Default true. */
      enabled: z.boolean().default(true),
      /** Max judge runs before accepting unverified (anti reject-loop). Clamped 1..10. */
      maxRuns: z.number().int().min(1).max(10).default(3),
      /** Phase 2: allow the judge UI/API/DB browser verification. Default false. */
      browser: z.boolean().default(false),
    }).default({}),
  }).default({}),
})

export const compactSchema = z.object({
  /** Master switch for discretionary compaction (ratio tiers, 1M LLM compact).
   *  Emergency paths (session split, 95% ceiling) ignore this. */
  enabled: z.boolean().default(true),
  /** @deprecated Superseded by ratio-based policy (compactPolicyRatios).
   *  Retained for config compatibility; not read by the runtime. */
  autoThreshold: z.number().int().positive().default(800_000),
  /** @deprecated Superseded by ratio-based policy (compactPolicyRatios).
   *  Retained for config compatibility; not read by the runtime. */
  autoFloor: z.number().int().positive().default(500_000),
  /** Model that performs the compaction summarization (LLM compact / partial
   *  compact). ONLY takes effect together with `provider`: when both are set
   *  and resolve to a real provider+model with credentials, compaction runs on
   *  that dedicated client (its own server-side cache), so a cheap model (e.g.
   *  a Flash) does the distillation WITHOUT spending the main model's tokens or
   *  evicting its hot prefix cache. Without `provider`, this is inert and
   *  compaction uses the session's primary model (backward compatible). */
  model: z.string().default('deepseek-v4-flash'),
  /** Provider hosting the compaction model (must exist in provider.providers).
   *  Set together with `model` to route compaction onto an isolated cheap model.
   *  Unknown provider / missing model / no credentials → silent fallback to the
   *  session primary (same rule as agent.review / council seat routing). */
  provider: z.string().optional(),
  /** T9 turn-0 quality-compaction trigger ratios (provider cost-aware).
   *  Only the turn-0, phase-gated quality lever — mid-turn delay guards are
   *  unaffected. Per-token cache-preserving providers (DeepSeek) skip T9
   *  entirely regardless of these. */
  qualityCompact: z.object({
    /** Context ratio to trigger T9 on per-token providers (e.g. openai). */
    perTokenThreshold: z.number().min(0).max(1).default(0.55),
    /** Leaner ratio for cost-insensitive subscription providers (GLM/MiMo/Codex/Claude). */
    subscriptionThreshold: z.number().min(0).max(1).default(0.45),
    /** Ceiling ratio that fires T9 for subscription providers even with no phase transition. */
    subscriptionCeiling: z.number().min(0).max(1).default(0.6),
  }).default({}),
})

export const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  minSystemTokens: z.number().int().positive().default(256),
  showHitRate: z.boolean().default(true),
})

export const editorSchema = z.object({
  /**
   * Target-OS conventions for file artifacts and the system-prompt OS hint.
   * 'auto' (default) follows the real host (process.platform). Explicit values
   * let a project opt into another OS's conventions (e.g. a Windows-targeted
   * project authored on macOS). NOTE: this only affects file conventions and
   * the prompt hint — command execution always runs on the real host shell.
   */
  platform: z.enum(['auto', 'windows', 'macos', 'linux']).default('auto'),
  /**
   * New-file line-ending default. 'auto' derives from `platform`
   * (windows → crlf, otherwise lf). Explicit 'lf'/'crlf' overrides it — for
   * example a Windows host that still wants LF source files. Existing files
   * always keep their own EOL, and .bat/.cmd are always CRLF regardless.
   */
  eol: z.enum(['auto', 'lf', 'crlf']).default('auto'),
})

export const workerProfileSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

export const workerRoutingSchema = z.record(z.string(), z.string()).default({
  repo_summarization: 'cheap-flash',
  code_edit: 'cheap-flash',
  test_failure_diagnosis: 'cheap-flash',
  risky_refactor: 'cheap-flash',
  // 规划模型独立路由：默认走强档（capable/deepseek-v4-pro）。base planner
  // 产出即执行分片图，规划质量决定并行拆分好坏，故默认强、可在此键改 provider。
  planning: 'capable',
})

export const workersSchema = z.object({
  profiles: z.record(z.string(), workerProfileSchema).default({}),
  routing: workerRoutingSchema,
}).default({})

export const skillsSchema = z.object({
  /** Skill names to COPY from .claude/skills/ (project then global ~/.claude)
   *  into .rivet/skills/ at load time. Only listed skills are imported — avoids
   *  pulling in all 70+ Claude skills when the user only needs a few. The copy
   *  is idempotent (existing .rivet/skills entries are never overwritten) and
   *  the runtime only ever loads from .rivet/skills — external dirs are never
   *  scanned in place. Empty array (default) = import nothing. */
  importFromClaude: z.array(z.string()).default([]),
}).default({})

export const mirrorsSchema = z.object({
  /** Master switch for domestic mirror injection. When enabled, bash tool
   *  executions automatically receive mirror registry env vars and GitHub
   *  clone URLs are rewritten to the chosen mirror. */
  enabled: z.boolean().default(false),
  /** Preset selector: 'default' = no mirrors, 'china' = domestic mirrors. */
  preset: z.enum(['default', 'china']).default('default'),
  /** GitHub mirror override. 'default' falls back to the preset default. */
  github: z.enum(['default', 'gitcode', 'kkgithub', 'fastgit']).default('default'),
  /** npm/yarn/pnpm registry override. */
  npm: z.enum(['default', 'taobao', 'tencent', 'huawei']).default('default'),
  /** PyPI pip index override. */
  pypi: z.enum(['default', 'tsinghua', 'aliyun', 'tencent']).default('default'),
  /** Go module proxy override. */
  go: z.enum(['default', 'goproxy_cn', 'aliyun']).default('default'),
  /** Rust rustup/crates.io override. */
  rust: z.enum(['default', 'tsinghua', 'tuna', 'ustc']).default('default'),
}).default({})

export const configSchema = z.object({
  provider: z.object({
    default: z.string(),
    providers: z.record(z.string(), providerSchema),
  }),
  agent: agentSchema.default({}),
  compact: compactSchema.default({}),
  cache: cacheSchema.default({}),
  editor: editorSchema.default({}),
  mcp: mcpConfigSchema.default({}),
  workers: workersSchema,
  skills: skillsSchema,
  mirrors: mirrorsSchema,
})

export type Config = {
  provider: { default: string; providers: Record<string, ProviderConfig> }
  agent: AgentConfig
  compact: CompactConfig
  cache: CacheConfig
  editor: EditorConfig
  mcp: McpConfig
  workers: WorkersConfig
  skills: SkillsConfig
  mirrors: MirrorsConfig
}

export type ProviderConfig = z.infer<typeof providerSchema>
export type AuthConfig = z.infer<typeof authConfigSchema>
export type ProviderCapabilitiesConfig = z.infer<typeof providerCapabilitiesSchema>
export type ModelConfig = z.infer<typeof modelConfigSchema>
export type EditorConfig = z.infer<typeof editorSchema>
export type EditorPlatform = EditorConfig['platform']
export type EditorEol = EditorConfig['eol']
export type AgentConfig = z.infer<typeof agentSchema>
export type CompactConfig = z.infer<typeof compactSchema>
export type CacheConfig = z.infer<typeof cacheSchema>
export type WorkersConfig = z.infer<typeof workersSchema>
export type SkillsConfig = z.infer<typeof skillsSchema>
export type MirrorsConfig = z.infer<typeof mirrorsSchema>
