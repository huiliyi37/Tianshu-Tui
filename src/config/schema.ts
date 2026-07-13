import { z } from 'zod'
import { mcpConfigSchema, type McpConfig } from '../mcp/config.js'
import { THEME_NAMES } from '../tui/theme.js'

export const modelConfigSchema = z.object({
  id: z.string(),
  alias: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
  /** Model accepts image inputs (multimodal user messages). Declared per model,
   *  NOT per provider — mixed text/vision model fleets under one provider are
   *  the norm. Gates the computer_use screenshot → conversation vision channel.
   *  Default undefined = text-only (images are dropped, today's behavior). */
  supportsVision: z.boolean().optional(),
  /** Pricing per 1M tokens (USD). Optional — used by insights / cost visualization. */
  pricing: z.object({
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
    cacheRead: z.number().min(0).optional(),
    cacheWrite: z.number().min(0).optional(),
    reasoning: z.number().min(0).optional(),
  }).optional(),
  /** Model tier for routing/fallback decisions. Overrides name-based inference. */
  tier: z.enum(['cheap', 'balanced', 'strong']).optional(),
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
  /** Model to use when falling back to this provider (defaults to 'deepseek-v4-flash'). */
  fallbackModel: z.string().optional(),
  /** Allow strong/pro tier models to be used as fallback. Default false to avoid
   *  cold-start cache-miss cost on large-context pro models. */
  allowProFallback: z.boolean().optional(),
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
  /**
   * First-byte (pre-first-chunk) timeout base override (ms).
   * 默认 undefined = 按 provider/thinking 推导（45/90/180s）。该 base 之上还会随请求
   * 预估输入规模自动上浮以避免大上下文冷启动被误杀；仅当某个自定义/慢 OpenAI 兼容模型
   * 即便小上下文也迟迟不出首 token 时，才需要显式抬高这个 base。
   */
  firstByteTimeoutMs: z.number().int().positive().optional(),
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
  /**
   * Codex-style standing directory grants, applied at session start without an
   * approval round-trip. Each entry is an absolute or ~-relative directory
   * whose whole subtree becomes readable (additionalReadDirs) or read+writable
   * (additionalWriteDirs) beyond the workspace boundary. A drive root
   * ("F:/", "D:\\") grants the entire drive. Project-level config lets a
   * parent-folder workspace pre-authorize sibling/child project dirs.
   */
  additionalReadDirs: z.array(z.string().min(1)).default([]),
  additionalWriteDirs: z.array(z.string().min(1)).default([]),
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

/** Tier 2 LLM speculation: during a tool-batch await window, fire a side-path
 *  LLM request sharing the main session prefix (near-free on DeepSeek prefix
 *  cache) to predict the next read-only tool calls, feeding ShadowQueue.
 *  ⚠ INERT since 2026-07-07: the speculative pre-execution chain is sealed
 *  (stale-read incident — ShadowQueue served pre-edit file content); the
 *  engine is no longer constructed regardless of this setting. Schema kept so
 *  existing configs still parse. See P3Config.speculativeEnabled. */
export const llmSpeculationSchema = z.preprocess(
  value => {
    if (value === true) return { enabled: true }
    if (value === false || value === undefined) return {}
    return value
  },
  z.object({
    enabled: z.boolean().default(false),
    maxPerTurn: z.number().int().positive().default(3),
    maxTokens: z.number().int().positive().default(320),
    timeoutMs: z.number().int().positive().default(8_000),
    minProbability: z.number().min(0).max(1).default(0.5),
    /** Only fire when the executing batch contains a slow tool (bash/run_tests/delegate/...). */
    slowToolsOnly: z.boolean().default(true),
  }).default({}),
)

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
  // 长任务远端兜底。runaway 由 wedged-loop/convergence/watchdog/context-pressure
  // 先行拦截，此值对标 Claude Code/Codex 的"无硬上限"取宽松 4 倍余量（50→200，
  // 会话 5158719d 证明 50 轮迫使用户在正常长任务中反复手动「继续」）。
  // 0 = 无限轮次（真正全自动 YOLO）；wedged-loop 等安全熔断仍然生效。
  maxTurns: z.number().int().nonnegative().default(200),
  mode: z.enum(['code', 'ask', 'plan']).default('code'),
  autoReasoning: z.boolean().default(true),
  /** 默认星域（auto | tianshu | pojun ...）。新会话的初始星域将由此配置项决定。 */
  defaultDomain: z.string().default('auto'),
  /**
   * 重启后一键续跑的兜底模型（可选）。续跑严格沿用会话原模型（前缀缓存亲和）；
   * 仅当原模型不可用且此项配置了可用模型时才切换续跑（UI 明示缓存将重建）。
   * 未配置时 fail-closed：不自动续跑，引导开新会话。绝不静默回退默认模型。
   */
  resumeFallbackModel: z.string().optional(),
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
  /** VSW 隔离验证策略（C4）。auto = §6 矩阵（仅在检测到并行会话或脏基线时
   *  才用快照 worktree 隔离验证——单干净会话保持 in-place，与历史行为一致）；
   *  always = 强制隔离（等价 RIVET_VSW=1）；off = 完全关闭快照管理器。
   *  环境变量 RIVET_VSW=1 仍然生效（强制 always 语义）。 */
  verificationSnapshot: z.enum(['auto', 'always', 'off']).default('auto'),
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
   * C3 检查点间隔 — Auto 模式下每 N 轮暂停并同步进度摘要（0 = 关）。
   * YOLO 和 Manual 模式不读此字段。仅在高风险仍需人工确认的 auto-safe 模式下生效。
   */
  checkpointEveryTurns: z.number().int().min(0).default(0),
  /** Explicit opt-in for current-turn intent retrieval route guidance. */
  intentRetrievalRouter: intentRetrievalRouterSchema,
  /** Tier 2 LLM speculation (shared-prefix next-tool prediction). INERT — chain sealed 2026-07-07. */
  llmSpeculation: llmSpeculationSchema,
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
  /** Optional dedicated multimodal model for image recognition.
   *  When the primary model does not declare supportsVision, images sent by the
   *  user are first routed through this model to produce a text description,
   *  which is then prepended to the user prompt sent to the primary model. */
  visionModel: z.object({
    provider: z.string(),
    model: z.string(),
    /** Prompt template for the vision model. Defaults to a generic Chinese description request. */
    prompt: z.string().optional(),
    /** Max output tokens for the generated description. */
    maxTokens: z.number().int().positive().default(1024),
  }).optional(),
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

export const searchSchema = z.object({
  /** Ordered backend chain for web_search. First available backend with a
   *  non-empty result wins; the rest are skipped. Unknown names are ignored. */
  backends: z.array(z.string()).default(['duckduckgo']),
  /** Env var holding the Brave Search API key (subscription token). */
  braveApiKeyEnv: z.string().default('BRAVE_API_KEY'),
  /** Env var holding the Tavily Search API key. */
  tavilyApiKeyEnv: z.string().default('TAVILY_API_KEY'),
  /** Per-backend request timeout (ms). */
  timeoutMs: z.number().int().positive().default(15_000),
  /** Optional region/country hint passed to backends that support it (Brave). */
  region: z.string().optional(),
}).default({})

export const fetchSchema = z.object({
  /** Per-request timeout (ms) for web_fetch and URL import downloads. */
  timeoutMs: z.number().int().positive().default(15_000),
  /** Maximum response body size (bytes). Larger bodies are cancelled mid-read. */
  maxResponseBytes: z.number().int().positive().default(10_485_760),
  /** Maximum number of redirects to follow. */
  maxRedirects: z.number().int().positive().default(5),
  /** User-Agent header sent with fetch requests. */
  userAgent: z.string().default('Tianshu/1.0 (terminal coding agent)'),
  /** Extract <main>/<article> content from HTML instead of returning full page noise. */
  extractMainContent: z.boolean().default(true),
}).default({})

export type FetchConfig = z.infer<typeof fetchSchema>

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
  /** 天梁 patcher 子代理的默认 tier（config.workers.patcherTier）。
   *  flash 能力足以承担各级风险的执行任务，默认 'cheap'（不因 riskTier 预判降级
   *  ——浪费生产力）；可设 'balanced' 或 'strong' 让执行者用更强模型（如 DeepSeek Pro）。 */
  patcherTier: z.enum(['cheap', 'balanced', 'strong']).default('cheap'),
  /** 失败升档天花板。只约束**失败驱动**的档位升级——规则升档
   *  （consecutiveFailures≥2 → strong）与 Flash→Pro 升档重试；
   *  不影响前置路由（workers.routing 如 planning→capable、planner hardFloor、
   *  瑶光门席位下限、review.profiles 覆盖卡、议事会 modelOverride）。
   *  动机：升档重试是全新会话零缓存全量重跑整个 work order，成本可达 flash
   *  的数十倍；而规划类 worker 从小上下文起步，前置用强模型成本可控。
   *  'off'（默认）= 失败不升档，重试留在原档模型；
   *  'balanced' = 最多升到 balanced 卡重试；'strong' = 旧的自动升 Pro 行为。 */
  escalationCap: z.enum(['off', 'balanced', 'strong']).default('off'),
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

export const envSchema = z.object({
  /** Auto-resolve the real login-shell / registry PATH + toolchain vars so the
   *  agent finds tools (mvn/git/...) even when the app is launched from a GUI
   *  (Explorer/Finder/Dock) with a minimal PATH. Default true; set false to use
   *  the raw process env only. */
  resolve: z.boolean().default(true),
  /** Extra directories appended to PATH for command execution — a manual
   *  escape hatch when auto-resolution still misses a tool. */
  extraPath: z.array(z.string()).default([]),
  /** Extra environment variables injected into command execution. Highest
   *  priority — overrides both process env and resolved values. */
  extraVars: z.record(z.string(), z.string()).default({}),
  /** Windows only: absolute path to a custom Git Bash `bash.exe`. When set,
   *  it seeds `RIVET_GIT_BASH_PATH` at startup so both the agent bash tool
   *  (platform.ts) and the desktop integrated terminal (pty.rs) use it. A real
   *  OS env var of the same name always wins (explicit override). Empty/unset
   *  falls back to the normal probe chain (where git → common dirs → bundled
   *  PortableGit). */
  gitBashPath: z.string().optional(),
  /** Absolute path to a custom `git.exe` (Windows) or `git` binary (macOS/Linux).
   *  When set, it seeds `RIVET_GIT_PATH` at startup so the environment probe
   *  (`/environment`) uses it directly instead of searching PATH. A real OS env
   *  var of the same name always wins (explicit override). Empty/unset falls
   *  back to the normal probe chain (PATH → common install dirs → bundled git). */
  gitPath: z.string().optional(),
}).default({})

export const uiSchema = z.object({
  /** Default TUI color theme used on startup. Runtime /theme switches are not persisted.
   *  Accepts: builtin theme name | 'auto' (detect terminal background via OSC 11 /
   *  COLORFGBG, pick cobalt/paper) | 'custom:<name>' (~/.rivet/themes/<name>.json). */
  theme: z.union([
    z.enum(THEME_NAMES),
    z.literal('auto'),
    z.string().regex(/^custom:[A-Za-z0-9_-]+$/),
  ]).optional(),
  /** Spinner verb pool override. With mode 'replace' (default) it replaces the
   *  built-in pool; 'append' extends it. Empty array = keep defaults. */
  spinnerVerbs: z.array(z.string().min(1)).optional(),
  spinnerVerbsMode: z.enum(['replace', 'append']).optional(),
  /** Accessibility: freeze spinner animation frames and verb rotation. */
  reducedMotion: z.boolean().optional(),
  /** GlanceBar density on startup. 'compact' (default) = mode/model/context%/elapsed;
   *  'full' = everything (goal/todo/effort/cache/cost). Runtime `/glance` toggles. */
  glanceDensity: z.enum(['compact', 'full']).optional(),
  /** Scriptable statusline (Claude Code protocol subset). The command receives a
   *  session-state JSON on stdin and its first stdout line renders above the input
   *  box. See src/tui/statusline.ts for the payload shape. */
  statusLine: z.object({
    command: z.string().min(1),
    intervalMs: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).optional(),
}).default({})

/** Project verify command declarations (A1). Machine-readable source of truth
 *  for the project's verification commands — declared in the project-layer
 *  `.rivet-config.json`, consumed by run_tests (test), the deliver review gate
 *  (typecheck/build for non-TS projects), and bash verification annotation.
 *  Typically generated by /init from the project fingerprint; hand-edits win. */
export const verifySchema = z.object({
  /** Full test command, e.g. "cargo test" / "go test ./..." / "pytest". */
  test: z.string().optional(),
  /** Build command — for compiled languages, build success is a more basic
   *  signal than tests, e.g. "cargo build" / "go build ./...". */
  build: z.string().optional(),
  /** Typecheck command, e.g. "tsc --noEmit" / "cargo check" / "mypy .". */
  typecheck: z.string().optional(),
  /** Lint command, e.g. "eslint ." / "cargo clippy" / "ruff check .".
   *  Declared-only for now: no dedicated lint gate consumes it yet (deferred);
   *  bash verification annotation recognizes it. */
  lint: z.string().optional(),
}).default({})

export const proSchema = z.object({
  /** Whether Pro features are active. Can also be enabled via RIVET_PRO=1
   *  or by placing a non-empty key in ~/.rivet/pro.license. */
  enabled: z.boolean().default(false),
  /** Optional license key (opaque string). The runtime does not validate
   *  signatures; online seat/validation is handled by a licensing service. */
  licenseKey: z.string().optional(),
  /** Per-feature Pro gates. When Pro is active, features default to enabled
   *  unless explicitly set to false here. */
  features: z.object({
    computerUse: z.boolean().default(true),
    chatGateway: z.boolean().default(true),
    /** team_orchestrate mode:'max'（多视角 planner fanout）。 */
    teamMax: z.boolean().default(true),
    /** council_convene rounds≥2（反驳/辩论轮）。 */
    councilMultiRound: z.boolean().default(true),
    /** 无人值守自动化（付费版 v1 · T2）：非 always-review 审查策略 +
     *  含 computer_use 的定时任务。 */
    unattendedAutomation: z.boolean().default(true),
  }).default({}),
}).default({})

export type ProConfig = z.infer<typeof proSchema>

export const configSchema = z.object({
  provider: z.object({
    default: z.string(),
    providers: z.record(z.string(), providerSchema),
  }),
  agent: agentSchema.default({}),
  compact: compactSchema.default({}),
  cache: cacheSchema.default({}),
  search: searchSchema,
  fetch: fetchSchema,
  editor: editorSchema.default({}),
  mcp: mcpConfigSchema.default({}),
  workers: workersSchema,
  skills: skillsSchema,
  mirrors: mirrorsSchema,
  env: envSchema,
  ui: uiSchema,
  verify: verifySchema,
  pro: proSchema,
  plugins: z.object({
    enabled: z.record(z.boolean()).default({}),
  }).default({}),
})

export type Config = {
  provider: { default: string; providers: Record<string, ProviderConfig> }
  agent: AgentConfig
  compact: CompactConfig
  cache: CacheConfig
  search: SearchConfig
  fetch: FetchConfig
  editor: EditorConfig
  mcp: McpConfig
  workers: WorkersConfig
  skills: SkillsConfig
  mirrors: MirrorsConfig
  env: EnvConfig
  ui: UiConfig
  verify: VerifyConfig
  pro: ProConfig
  plugins: { enabled: Record<string, boolean> }
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
export type SearchConfig = z.infer<typeof searchSchema>
export type WorkersConfig = z.infer<typeof workersSchema>
export type SkillsConfig = z.infer<typeof skillsSchema>
export type MirrorsConfig = z.infer<typeof mirrorsSchema>
export type EnvConfig = z.infer<typeof envSchema>
export type UiConfig = z.infer<typeof uiSchema>
export type VerifyConfig = z.infer<typeof verifySchema>
