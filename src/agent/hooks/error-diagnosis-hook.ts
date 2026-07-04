import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { FailureClass } from '../failure-classifier.js'

/**
 * Error Diagnosis Hook — postTool 注入对应错误的用户向诊断建议。
 *
 * 当工具返回错误时，复用 failure-classifier 已完成的分类，
 * 从注册表中查找诊断条目，通过 advisoryBus 按需注入到 agent 上下文。
 *
 * 这替代了 static.ts 中冗长的静态错误转译表——知识不再永久占据
 * prompt 空间，只在错误实际发生时注入。
 *
 * Cooldown: 每轮最多 1 条诊断，避免错误风暴淹没上下文。
 * Tier: operational (priority 0.52) — 高于 lossy-observation (0.48)，
 * 低于 discipline-reanchor (0.55)，确保不挤压更高优先级信号。
 */

interface DiagnosisEntry {
  /** 错误根因——向 agent 解释这是什么错误 */
  diagnosis: string
  /** 用户向下一步——agent 应告知用户的行动 */
  userAction: string
}

const REGISTRY: Partial<Record<FailureClass, DiagnosisEntry>> = {
  type_error: {
    diagnosis: 'TypeScript 类型错误——编译期类型不匹配。',
    userAction: '类型不匹配，不是运行时 bug。检查类型定义和接口签名——可能是属性名拼错、类型窄化不当、或泛型参数遗漏。',
  },
  assertion: {
    diagnosis: '测试断言失败——预期值与实际值不符。',
    userAction: '断言失败。先对比预期值和实际值：是测试写错了还是实现有 bug？不要盲目改代码让测试通过。',
  },
  missing_dep: {
    diagnosis: '缺少依赖——命令或包未安装。',
    userAction: '系统缺少此命令或包。需要安装（如 npm install / pip install）或使用替代方案。这不是代码问题。',
  },
  timeout: {
    diagnosis: '操作超时——命令在限时内未完成。',
    userAction: '操作超时。可增大 timeout 参数、拆分任务分批执行、或检查是否有死循环/未完成的异步调用。',
  },
  snapshot: {
    diagnosis: '快照变更——测试快照与当前输出不匹配。',
    userAction: '快照发生了变化。如果改动是有意的，更新快照即可；如果无意，说明产生了意外的输出差异。',
  },
  module_resolution: {
    diagnosis: '模块解析失败——import 路径找不到对应文件。',
    userAction: 'import 路径或文件不存在。检查文件是否已创建、路径拼写是否正确、package.json exports 是否匹配。',
  },
  env_missing: {
    diagnosis: '环境变量/凭证缺失——所需的 API key 或配置未设置。',
    userAction: '缺少环境变量或 API 凭证。需要设置对应的环境变量（如 API_KEY）或配置项。这不是代码逻辑问题。',
  },
  permission_denied: {
    diagnosis: '权限不足——文件或操作被系统拒绝。',
    userAction: '没有操作权限。检查文件权限（chmod）、沙箱策略、或是否在受限目录中操作。',
  },
  context_window_exceeded: {
    diagnosis: '上下文窗口已满——token 数量超过模型上限。',
    userAction: '上下文窗口已满。运行 /compact 缩减上下文，或开启新会话继续。不需要修改代码。',
  },
  api_error: {
    diagnosis: 'API 服务异常——外部服务返回了错误。',
    userAction: '外部 API 服务异常（429/500/502/503）。等待后重试即可，不是代码问题。',
  },
  syntax_error: {
    diagnosis: '语法/编译错误——代码不符合语言规则。',
    userAction: '存在语法错误。检查对应的语法位置——可能是括号不匹配、关键字拼错、或意外的 token。',
  },
  format_error: {
    diagnosis: '格式错误——JSON 解析失败或输出格式不正确。',
    userAction: '输出格式不正确（JSON 解析失败/malformed）。重试时调整输出格式——确保 JSON 字符串正确转义、大括号配对。',
  },
  flaky: {
    diagnosis: '不稳定测试——同一测试在不同运行中结果不一致。',
    userAction: '测试可能不稳定。多次运行确认——如果每次失败不同，标记为 flaky 并单独排查（通常是并发/时序问题）。',
  },
}

const ADVISORY_PREAMBLE = '【天枢·诊断】'

export interface ErrorDiagnosisHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

export function createErrorDiagnosisHook(deps: ErrorDiagnosisHookDeps): PostToolRuntimeHook {
  let lastFiredTurn = -1

  return {
    phase: 'postTool',
    name: 'error-diagnosis',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // Only fire on errors
      if (!tool.isError) return
      // Only when failureClass is available
      if (!tool.failureClass) return
      // Unknown class — no diagnosis to give
      if (tool.failureClass === 'unknown') return
      // At most 1 diagnosis per turn
      if (ctx.snapshot.turn === lastFiredTurn) return

      const entry = REGISTRY[tool.failureClass]
      if (!entry) return

      lastFiredTurn = ctx.snapshot.turn
      deps.advisoryBus.submit({
        key: `error-diagnosis:${tool.failureClass}`,
        priority: 0.52,
        category: 'discipline',
        tier: 'operational',
        content: `${ADVISORY_PREAMBLE} ${tool.name} 失败 (${tool.failureClass})：${entry.diagnosis} → ${entry.userAction}`,
        ttl: 1,
      })
    },
  }
}
