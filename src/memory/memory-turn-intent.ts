/**
 * Memory turn intent — 决定本轮跨会话记忆检索用哪段文本做 query。
 *
 * 背景（记忆幻觉治理 P1）：turnMode 为 followUp 时 taskContract.objective 仍是
 * 旧任务，直接拿它检索会把旧任务记忆持续注入「已解决/换新问题」的短消息。
 * 但普通追问（继续/实施/好）又必须沿用旧 objective 以保持字节稳定与任务记忆
 * 连贯。这里只识别明确的任务切换信号，其余一律沿用旧 objective。
 */

const SYSTEM_REMINDER_START = '<system-reminder>'

/** 意图路由里参与换题判断的最小结构信号（避免 memory 层反向依赖 agent 类型）。 */
export interface MemoryIntentRouteSignal {
  confidence: number
  taskKinds: readonly string[]
}

export interface MemoryIntentRouteSignals {
  /** 本轮 buildForTurn 之前的检索路由（旧任务的意图面）。 */
  previous?: MemoryIntentRouteSignal
  /** 本轮 buildForTurn 之后的检索路由（当前输入的意图面）。 */
  current?: MemoryIntentRouteSignal
}

const ROUTE_SWITCH_CONFIDENCE = 0.6

/** 旧任务已收口的显式信号：已解决 / 前面修好了 / 之前完成了 … */
const CLOSURE_RE = /(?:已(?:经)?|前面|之前|上面|刚才|都)[^。\n]{0,12}(?:解决|完成|修好|修完|搞定|做好|做完|弄好|弄完|处理好|好了|可以了)|(?:已经|已)\s*(?:ok|done)/i

/** 明确指向另一个话题：看看新问题 / 问个别的事 / 换个需求 … */
const NEW_TOPIC_RE = /(?:看(?:看|一下)|问(?:个|一下)|说(?:个|一下)|换(?:个|一下)|提(?:个|一下)|聊(?:个|一下))[^。\n]{0,12}(?:新|别的|另外|另一个|需求|任务|事情|话题|功能)/i

/** 纯续做指令与轻确认——这些不是新问题，继续用旧 objective 检索。 */
const CONTINUATION_RE = /^(?:继续|然后|然后呢|接着|下一步|实施|执行|开做|开始做|接着做|做\s*[PpTtSs]\d+|do it|go on|continue|next|好|行|ok|可以)[。.!！？\s]*$/i

/** 去掉尾部附加的 <system-reminder>…（真实用户文本在前时）或整段就是系统提醒。 */
export function stripSystemReminderSuffix(input: string): string {
  const idx = input.indexOf(SYSTEM_REMINDER_START)
  return (idx >= 0 ? input.slice(0, idx) : input).trim()
}

/**
 * 意图路由是否发生了实质换题：当前高置信分类与旧任务意图面无交集，
 * 且不是 social_idle（闲聊不应驱动记忆换题）。
 */
function routeShifted(previous: MemoryIntentRouteSignal | undefined, current: MemoryIntentRouteSignal | undefined): boolean {
  if (!previous || !current) return false
  if (current.confidence < ROUTE_SWITCH_CONFIDENCE) return false
  if (current.taskKinds.length === 0 || current.taskKinds.includes('social_idle')) return false
  return current.taskKinds.every(kind => !previous.taskKinds.includes(kind))
}

/**
 * 本轮记忆检索 query。
 * - task/chat：用真实用户文本（去掉系统提醒尾巴）；纯系统提醒回落到 objective。
 * - followUp：默认沿用旧 objective；以下任一信号才改用当前文本，把旧任务记忆
 *   从自动注入中切走：
 *     ① 显式「旧任务已收口」；
 *     ② 显式「换新话题」；
 *     ③ 意图路由高置信换题（旧 taskKinds 与当前 taskKinds 无交集）。
 */
export function memoryQueryForTurn(
  input: string,
  turnMode: 'chat' | 'followUp' | 'task',
  activeObjective: string | undefined,
  routeSignals?: MemoryIntentRouteSignals,
): string {
  const real = stripSystemReminderSuffix(input)
  if (!real) return activeObjective ?? input.trim()

  if (turnMode !== 'followUp') return real
  if (CONTINUATION_RE.test(real)) return activeObjective ?? real
  if (CLOSURE_RE.test(real) || NEW_TOPIC_RE.test(real)) return real
  if (routeShifted(routeSignals?.previous, routeSignals?.current)) return real
  return activeObjective ?? real
}
