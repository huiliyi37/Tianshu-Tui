/**
 * Zen Mode — 禅模式：读专注开局，动手即解锁。
 *
 * 会话启动（顶层主控会话、zen 启用）把主控可见工具面物理收窄到读面
 * （face 白名单 ∩ 已注册）——模型在开局只看到读工具，不被全量工具 schema
 * 与杂乱注入干扰；首次请求面外工具 → 晋升 full 并放行该调用（零往返、零拒绝）。
 * 兜底晋升通道：首消息分诊（单行且 ≤ maxChars 的琐碎请求不进禅）、步数预算
 * 超时（turn 计）、`/fast` 用户跳过。
 *
 * 与 toolGating 的关系：zen 相位期间 zen 接管工具面（优先于门控）；晋升 full
 * 后回退到门控/描述档位逻辑，二者正交。worker/子代理会话（isTopLevel=false）
 * 永不 arm——它们的工具面由委派方决定。
 */

export type ZenPhase = 'zen' | 'full'

export type ZenPromoteReason = 'tool' | 'timeout' | 'triage' | 'user'

/** 默认读面：read_file/grep/glob 不在 tool-preset 任何档位排除清单（四档全注册）；
 *  repo_map 为 kernel 无条件注册。不含 bash——bash 万能，含则"写"可绕过解锁。 */
export const DEFAULT_ZEN_FACE: readonly string[] = ['read_file', 'grep', 'glob', 'repo_map']

/** structuredRead 附加读面：结构化/关系型只读工具，降低「先读后改」的往返。
 *  仍不含 bash/run_tests——执行与验证必须解锁 full 面。 */
export const DEFAULT_ZEN_STRUCTURED_READ_FACE: readonly string[] = [
  'file_info',
  'related_tests',
  'repo_graph',
  'semantic_search',
  'read_section',
]

/**
 * zen_unlock：禅相位内的「解锁声明」工具——物理收窄切断了模型调用面外工具的
 * 表达通道（真实测试发现：模型看不到 edit_file 就永远调不出它，只能等 timeout），
 * 本工具给模型一个可见的动手意图入口：调用即表达"准备动手"，宿主立即晋升 full
 * 并放行。虚拟工具——不在 toolRegistry（无副作用执行），由 ToolExecutionController
 * 在分派前拦截：调用 → onZenUnlock（promote('tool')）+ 直接返回成功结果。
 * 只在 zen 相位注入 gatedToolDefinitions（full 面自动消失）。
 */
export const ZEN_UNLOCK = 'zen_unlock'

/** zen_unlock 的成功结果文案（模型可见的解锁确认）。 */
export const ZEN_UNLOCK_RESULT = '禅模式已解除：全量工具面已恢复，可调用任意工具。'

/** full 相位幻觉调用 zen_unlock 的文案（promote 返回 false：本就未在禅模式）。 */
export const ZEN_UNLOCK_NOT_ZEN = '当前并非禅模式——全量工具面本就可用，无需解锁。'

/**
 * 禅相位内调用未注册工具时的可行动提示：不晋升（幻觉调用不构成动手证据），
 * 但把 registry 的 Unknown tool 报错从「死路」变成「解锁声明通道」。
 */
export function zenUnregisteredHint(toolName: string): string {
  return `当前处于禅模式（只读工具面），\`${toolName}\` 不在读面内且未注册。若这确实是动手/执行类意图，请先调用 \`${ZEN_UNLOCK}\`（intent 简述要做什么）解锁全量工具，再发起对应调用。`
}

/** zen_unlock 的工具定义（zen 相位注入面）。 */
export function zenUnlockDefinition(): import('../api/types.js').ToolDefinition {
  return {
    name: ZEN_UNLOCK,
    description: '禅模式（读专注）下的解锁声明。当前工具面仅含读工具；当任务需要修改文件、执行命令、运行测试等动手操作时，调用本工具声明动手意图，系统将立即解除禅模式并恢复全量工具。参数 intent 简述你要执行的操作。',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '要执行的动手操作简述（如"修改 src/main.ts 修复报错"）' },
      },
      required: ['intent'],
    },
  }
}

/** Zen 模式配置（原始形态，全可选——resolveZenConfig 物化默认）。 */
export interface ZenConfig {
  /** 总开关。默认 true。false → 恒全量面（不 arm、不晋升、恒放行）。 */
  enabled?: boolean
  /** 读面——zen 相位下暴露给主控的只读工具名白名单。默认由 faceMode 决定。 */
  face?: readonly string[]
  /** 读面档位：minimal = DEFAULT_ZEN_FACE；structuredRead = minimal + 结构化
   *  只读工具（file_info/related_tests/repo_graph/semantic_search/read_section）。
   *  显式 face 优先于 faceMode。默认 minimal（字节级保持既有行为）。 */
  faceMode?: 'minimal' | 'structuredRead'
  /** 步数预算（turn 计）：zen 相位经历 ≥ timeoutSteps 个用户 turn 自动晋升 full。
   *  0 = 禁用超时晋升。默认 8。 */
  timeoutSteps?: number
  /** 首消息分诊：单行 && 长度 ≤ maxChars && 无附件 → 首轮请求前晋升（琐碎请求不进禅）。
   *  默认 { enabled: true, maxChars: 80 }。 */
  triage?: { enabled?: boolean; maxChars?: number }
  /** 禅相位裁剪 CVM 动态注入块（sensorium/策略 profile/知识碎片/星域提醒/遥测摘要）。
   *  保留 git-status/recent-commits/项目指令/计划指针。默认 true。 */
  appendixLean?: boolean
}

/** resolveZenConfig 校验后的正规形态（全默认已物化）。 */
export interface ResolvedZenConfig {
  enabled: boolean
  face: readonly string[]
  faceMode: 'minimal' | 'structuredRead'
  timeoutSteps: number
  triage: { enabled: boolean; maxChars: number }
  appendixLean: boolean
}

/** 配置校验失败（fail-loud）——错误必须显式暴露，绝不静默降级。 */
export class ZenConfigError extends Error {
  constructor(message: string) {
    super(`zen 配置错误：${message}`)
    this.name = 'ZenConfigError'
  }
}

const ZEN_CONFIG_KEYS = new Set(['enabled', 'face', 'faceMode', 'timeoutSteps', 'triage', 'appendixLean'])

/** 默认配置：开启 + minimal 读面 + 8 turn 预算 + 短消息分诊 + appendix 收敛。 */
function defaultZenConfig(): ResolvedZenConfig {
  return {
    enabled: true,
    face: [...DEFAULT_ZEN_FACE],
    faceMode: 'minimal',
    timeoutSteps: 8,
    triage: { enabled: true, maxChars: 80 },
    appendixLean: true,
  }
}

/**
 * 运行时校验未知配置为正规 ResolvedZenConfig，fail-loud：任何结构错误直接抛
 * ZenConfigError。反例（均抛错）：非对象、未知键、enabled 非布尔、face 非数组/
 * 空数组/含非字符串/含空串/重复名、timeoutSteps 非整数/负数、triage 未知键/
 * enabled 非布尔/maxChars 非正整数、appendixLean 非布尔。
 * raw 为 undefined/null → 默认开启配置（生产入口未显式配置即启用）。
 */
export function resolveZenConfig(raw: unknown): ResolvedZenConfig {
  if (raw === undefined || raw === null) return defaultZenConfig()
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ZenConfigError('zen 配置必须是对象')
  }
  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!ZEN_CONFIG_KEYS.has(key)) {
      throw new ZenConfigError(`未知键 "${key}"（仅支持 ${[...ZEN_CONFIG_KEYS].join(', ')}）`)
    }
  }

  const enabled = obj.enabled ?? true
  if (typeof enabled !== 'boolean') {
    throw new ZenConfigError(`enabled 必须是布尔值（收到 ${JSON.stringify(enabled)}）`)
  }

  const faceModeRaw = obj.faceMode ?? 'minimal'
  if (faceModeRaw !== 'minimal' && faceModeRaw !== 'structuredRead') {
    throw new ZenConfigError(`faceMode 必须是 'minimal' 或 'structuredRead'（收到 ${JSON.stringify(faceModeRaw)}）`)
  }
  const faceMode: ResolvedZenConfig['faceMode'] = faceModeRaw

  let face: readonly string[]
  if (obj.face === undefined) {
    face = faceMode === 'structuredRead'
      ? [...DEFAULT_ZEN_FACE, ...DEFAULT_ZEN_STRUCTURED_READ_FACE]
      : [...DEFAULT_ZEN_FACE]
  } else {
    const f = obj.face
    if (!Array.isArray(f)) throw new ZenConfigError('face 必须是字符串数组')
    if (f.length === 0) throw new ZenConfigError('face 不能为空——zen 相位至少需要一个读工具')
    const seen = new Set<string>()
    for (const tool of f) {
      if (typeof tool !== 'string' || tool.trim() === '') {
        throw new ZenConfigError(`face 必须是非空字符串工具名（收到 ${JSON.stringify(tool)}）`)
      }
      if (seen.has(tool)) throw new ZenConfigError(`face 含重复工具名 "${tool}"`)
      seen.add(tool)
    }
    face = [...f]
  }

  const timeoutSteps = obj.timeoutSteps ?? 8
  if (typeof timeoutSteps !== 'number' || !Number.isInteger(timeoutSteps) || timeoutSteps < 0) {
    throw new ZenConfigError(`timeoutSteps 必须是非负整数（0 = 禁用超时晋升；收到 ${JSON.stringify(timeoutSteps)}）`)
  }

  let triage: { enabled: boolean; maxChars: number }
  const triageRaw = obj.triage === undefined ? {} : obj.triage
  if (triageRaw === null || typeof triageRaw !== 'object' || Array.isArray(triageRaw)) {
    throw new ZenConfigError('triage 必须是对象')
  }
  const t = triageRaw as Record<string, unknown>
  for (const key of Object.keys(t)) {
    if (key !== 'enabled' && key !== 'maxChars') {
      throw new ZenConfigError(`triage 未知键 "${key}"（仅支持 enabled, maxChars）`)
    }
  }
  const triageEnabled = t.enabled ?? true
  if (typeof triageEnabled !== 'boolean') {
    throw new ZenConfigError(`triage.enabled 必须是布尔值（收到 ${JSON.stringify(triageEnabled)}）`)
  }
  const maxChars = t.maxChars ?? 80
  if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars <= 0) {
    throw new ZenConfigError(`triage.maxChars 必须是正整数（收到 ${JSON.stringify(maxChars)}）`)
  }
  triage = { enabled: triageEnabled, maxChars }

  const appendixLean = obj.appendixLean ?? true
  if (typeof appendixLean !== 'boolean') {
    throw new ZenConfigError(`appendixLean 必须是布尔值（收到 ${JSON.stringify(appendixLean)}）`)
  }

  return { enabled, face, faceMode, timeoutSteps, triage, appendixLean }
}

export type ZenFaceVerdict = 'in-face' | 'out-of-face' | 'unregistered'

/**
 * 面判定三态：
 *  - in-face：在 face 白名单内（读工具，放行且不晋升）
 *  - out-of-face：不在 face 但已注册（写工具——zen 相位下面外调用的晋升触发点）
 *  - unregistered：连注册表都没有（幻觉调用，执行必失败——不构成晋升证据，放行不晋升）
 * registered 缺省时不区分 out-of-face / unregistered（凡不在 face 即面外）。
 */
export function isZenFaceTool(
  name: string,
  face: readonly string[],
  registered?: ReadonlySet<string>,
): ZenFaceVerdict {
  if (face.includes(name)) return 'in-face'
  if (registered && !registered.has(name)) return 'unregistered'
  return 'out-of-face'
}

/** 首消息分诊纯判定：单行（无换行）&& 长度 ≤ maxChars → 琐碎请求，跳过禅。 */
export function shouldTriagePromote(message: string, maxChars: number): boolean {
  return !message.includes('\n') && message.length <= maxChars
}

/** 步数预算纯判定：timeoutSteps > 0 且 zenTurns ≥ timeoutSteps → 应晋升。 */
export function isZenBudgetExhausted(zenTurns: number, timeoutSteps: number): boolean {
  return timeoutSteps > 0 && zenTurns >= timeoutSteps
}

/** 相位变化通知载荷（onPhaseChange）：arm 时 reason 为 undefined。 */
export interface ZenPhaseSnapshot {
  zenPhase: ZenPhase
  zenPromoteReason?: ZenPromoteReason
  zenStats: {
    armed: boolean
    promoteReason?: ZenPromoteReason
    zenTurns: number
  }
}

export interface ZenPhaseControllerOpts {
  /** 顶层主控会话 true；worker/子代理传 false → 永不 arm（工具面由委派方决定）。 */
  isTopLevel: boolean
  /** 当前注册工具名（读面 = 配置 face ∩ 注册）。 */
  registeredNames: () => readonly string[]
  /** 面应用：相位变化时刷新工具面（loop 侧实现为 updateTools——参数保留为契约
   *  签名，实际由 gatedToolDefinitions 按 isZen 过滤，loop 实现忽略参数值）。 */
  applyFace: (names: readonly string[]) => void
  /** 相位变化通知（arm 与每次 promote）：meta 落盘 / UI 徽章。 */
  onPhaseChange?: (phase: ZenPhase, reason?: ZenPromoteReason) => void
}

/**
 * zen 相位状态机。初始相位 full——只有 arm() 才进入 zen（读面收窄），
 * 因此未 arm（worker 会话 / zen 禁用）天然全量、恒放行，无需单独分支。
 * 不变量：至多一次有效 arm（重复 arm 幂等）；promote 后不回 zen。
 */
export class ZenPhaseController {
  private phase: ZenPhase = 'full'
  private zenTurns = 0
  private promoteReason: ZenPromoteReason | null = null

  constructor(
    private readonly config: ResolvedZenConfig,
    private readonly opts: ZenPhaseControllerOpts,
  ) {}

  get enabled(): boolean {
    return this.config.enabled
  }

  get isZen(): boolean {
    return this.config.enabled && this.phase === 'zen'
  }

  get currentPhase(): ZenPhase {
    return this.phase
  }

  get lastPromoteReason(): ZenPromoteReason | null {
    return this.promoteReason
  }

  get face(): ReadonlySet<string> {
    return new Set(this.config.face)
  }

  get resolvedConfig(): ResolvedZenConfig {
    return this.config
  }

  /** 进入 zen 相位（会话启动调用）。非顶层 / disabled → 无操作（恒 full）。
   *  幂等：已 zen 时重复调用无操作。arm 成功后 applyFace + onPhaseChange('zen')。
   *  initialZenTurns 供 resume 恢复步数预算——已到预算立即 promote(timeout)，
   *  防止「resume 重置计数」把超时晋升变成可无限续期的漏洞。 */
  arm(initialZenTurns = 0): void {
    if (!this.config.enabled || !this.opts.isTopLevel) return
    if (this.phase === 'zen') return
    const restoredTurns = Number.isInteger(initialZenTurns) && initialZenTurns >= 0
      ? initialZenTurns
      : 0
    this.phase = 'zen'
    this.zenTurns = restoredTurns
    this.promoteReason = null
    if (isZenBudgetExhausted(this.zenTurns, this.config.timeoutSteps)) {
      this.promote('timeout')
      return
    }
    this.opts.applyFace(this.currentFace())
    this.opts.onPhaseChange?.('zen')
  }

  /** 首消息分诊：zen 且单行短消息且无附件 → 晋升（首轮请求前调用）。纯判定不改
   *  状态之外的相位——命中即 promote。 */
  maybeTriage(message: string, hasAttachments: boolean): void {
    if (!this.isZen || hasAttachments) return
    if (this.config.triage.enabled && shouldTriagePromote(message, this.config.triage.maxChars)) {
      this.promote('triage')
    }
  }

  /** 工具请求（执行分派前逐个调用）：zen 且面外（已注册但不在读面）→ 晋升 full。
   *  恒返回 true（放行语义——promote 在内部完成，不拒绝、不重试、零往返）。
   *  未注册工具（幻觉调用）不晋升（执行必失败，不构成动手证据）。 */
  onToolRequest(name: string): boolean {
    if (
      this.isZen
      && isZenFaceTool(name, this.config.face, new Set(this.opts.registeredNames())) === 'out-of-face'
    ) {
      this.promote('tool')
    }
    return true
  }

  /** 每用户 turn 结束（或边界）调用：步数预算计数；≥ timeoutSteps → 晋升。 */
  tick(): void {
    if (!this.isZen) return
    this.zenTurns++
    if (isZenBudgetExhausted(this.zenTurns, this.config.timeoutSteps)) {
      this.promote('timeout')
    }
  }

  /** /fast 用户跳过：立即晋升 full。 */
  fast(): void {
    this.promote('user')
  }

  /** 当前面：zen → 配置 face ∩ 已注册；full → 全注册名。 */
  currentFace(): readonly string[] {
    const registered = new Set(this.opts.registeredNames())
    if (this.phase !== 'zen') return [...registered]
    return this.config.face.filter(name => registered.has(name))
  }

  /** meta 持久化快照。 */
  snapshot(): ZenPhaseSnapshot {
    return {
      zenPhase: this.phase,
      zenPromoteReason: this.promoteReason ?? undefined,
      zenStats: {
        armed: this.promoteReason !== null || this.phase === 'zen',
        promoteReason: this.promoteReason ?? undefined,
        zenTurns: this.zenTurns,
      },
    }
  }

  /** 通用晋升入口（幂等：非 zen / disabled 返回 false）。内部通道与 /fast 共用。 */
  promote(reason: ZenPromoteReason): boolean {
    if (!this.config.enabled || this.phase !== 'zen') return false
    this.phase = 'full'
    this.promoteReason = reason
    this.opts.applyFace(this.currentFace())
    this.opts.onPhaseChange?.('full', reason)
    return true
  }
}

/** resume 折叠结果：相位 + 已消耗的禅 turn 数（非法/缺省 → 0，保守不抛错）。 */
export interface ZenMetaFold {
  phase: ZenPhase
  zenTurns: number
}

/**
 * 从会话 meta 恢复上次相位与步数预算（resume）。meta 无 zenPhase 记录 / 值非法
 * → undefined（调用方按「无记录」处理：fresh 会话走 arm，full 保持全量——
 * 保守：无记录 ≠ 禅相位）。zenStats.zenTurns 非负整数才采信，否则归零。
 */
export function foldZenFromMeta(meta: unknown): ZenMetaFold | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const record = meta as Record<string, unknown>
  const phase = record.zenPhase
  if (phase !== 'zen' && phase !== 'full') return undefined
  const stats = record.zenStats
  const rawTurns = stats !== null && typeof stats === 'object'
    ? (stats as Record<string, unknown>).zenTurns
    : undefined
  const zenTurns = Number.isInteger(rawTurns) && (rawTurns as number) >= 0
    ? rawTurns as number
    : 0
  return { phase, zenTurns }
}

/**
 * 从会话 meta 恢复上次相位（resume）。meta 无 zenPhase 记录 / 值非法 → undefined
 * （调用方按「无记录」处理：fresh 会话走 arm，full 保持全量——保守：无记录 ≠ 禅相位）。
 * 需要恢复步数预算的调用方请使用 {@link foldZenFromMeta}。
 */
export function foldFromMeta(meta: unknown): ZenPhase | undefined {
  return foldZenFromMeta(meta)?.phase
}
