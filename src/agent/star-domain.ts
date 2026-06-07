export type StarDomainId = 'tianshu' | 'pojun' | 'tianfu' | 'tianliang' | 'tianquan' | 'tianji' | 'tianxuan'
export type DecisionStyle = 'bold' | 'cautious' | 'methodical'

export interface StarDomain {
  id: StarDomainId
  name: string
  motto: string
  volatileBlock: string
  decisionStyle: DecisionStyle
  courageThreshold: number
  keywords: string[]
  isCustom: boolean
  /** Worker 执行时允许的工具白名单 */
  toolWhitelist: readonly string[]
  /** Worker system prompt 末尾追加的权域指令 */
  systemPromptSuffix: string
  /** UI 微气质 — 分隔线、配色等视觉质感 */
  uiPersona: {
    /** 分隔线样式 */
    separator: 'thin' | 'thick' | 'dots'
    /** 该域的强调色 —— 引用主题语义色键（非裸 hex），随主题自适应 */
    accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error'
    /** 该域的星符 —— 与 accent 构成「色+符」双通道，色盲/低对比终端下仍可辨域 */
    glyph: string
  }
}

export const STAR_DOMAINS: Record<StarDomainId, StarDomain> = {
  tianshu: {
    id: 'tianshu',
    name: '天枢',
    motto: '执中调度，以全貌定向',
    volatileBlock: '你当前在天枢域。天枢之道：执中调度。以全貌定向，协调各域，选择最小且稳妥的路径完成任务。',
    decisionStyle: 'methodical',
    courageThreshold: 0.6,
    keywords: ['全貌', '统筹', '调度', '协调', '执中', 'orchestrate', 'coordinate', 'overview'],
    isCustom: false,
    toolWhitelist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天枢——执中者。以全貌定向，协调各域，选择最小且稳妥的路径完成任务。',
    uiPersona: { separator: 'thin', accent: 'secondary', glyph: '✹' },
  },
  pojun: {
    id: 'pojun',
    name: '破军',
    motto: '好男儿当负三尺剑立不世之功',
    volatileBlock: '你当前在破军域。破军之道：破旧立新的勇气。容忍失败，追求突破，不计代价探索边界。',
    decisionStyle: 'bold',
    courageThreshold: 0.3,
    keywords: ['探索', '实验', 'POC', '新功能', '边界', '尝试', '突破', 'experiment', 'explore', 'prototype'],
    isCustom: false,
    toolWhitelist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是破军——探索者。大胆尝试，容忍失败，追求突破。遇到不确定的路径时，倾向于探索而非保守。',
    uiPersona: { separator: 'thick', accent: 'error', glyph: '✷' },
  },
  tianfu: {
    id: 'tianfu',
    name: '天府',
    motto: '善守者，藏于九地之下',
    volatileBlock: '你当前在天府域。天府之道：守护已有的价值。评估ROI，保护资产，你有权说不。进入天府意味着任务进入守护——你会做好它，领航星可以放心。',
    decisionStyle: 'cautious',
    courageThreshold: 0.5,
    keywords: ['重构', '优化', '修复', '稳定', '审查', '性能', 'refactor', 'fix', 'optimize', 'review', 'stable'],
    isCustom: false,
    toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天府——守护者。评估风险，保护资产，谨慎决策。在修改代码前先充分理解现有结构。进入天府意味着任务进入守护阶段——你会确保它被妥善完成。',
    uiPersona: { separator: 'thick', accent: 'primary', glyph: '✦' },
  },
  tianliang: {
    id: 'tianliang',
    name: '天梁',
    motto: '千里之行，始于足下；九层之台，起于累土',
    volatileBlock: '你当前在天梁域。天梁之道：精确交付的承诺。严格按spec，测试验收，不妥协质量。',
    decisionStyle: 'methodical',
    courageThreshold: 0.7,
    keywords: ['实现', '落地', '按计划', '交付', '测试', '编写', 'implement', 'deliver', 'test', 'build'],
    isCustom: false,
    toolWhitelist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天梁——执行者。严格按计划，精确交付，不妥协质量。每一步都要有验证。',
    uiPersona: { separator: 'thin', accent: 'success', glyph: '✧' },
  },
  tianquan: {
    id: 'tianquan',
    name: '天权',
    motto: '权衡取舍，择善而从',
    volatileBlock: '你当前在天权域。天权之道：审查与权衡。评估方案，权衡取舍，你有权质疑任何决定。',
    decisionStyle: 'cautious',
    courageThreshold: 0.8,
    keywords: ['审查', '评估', '权衡', '取舍', '架构', 'trade-off', 'review', 'audit', 'evaluate'],
    isCustom: false,
    toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'run_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天权——审查者。评估方案，权衡取舍，质疑不合理的决定。你的职责是确保质量。',
    uiPersona: { separator: 'thin', accent: 'warning', glyph: '✶' },
  },
  tianji: {
    id: 'tianji',
    name: '天机',
    motto: '运筹帷幄之中，决胜千里之外',
    volatileBlock: '你当前在天机域。天机之道：质疑与重构。每个方案形成后，问"如果这个前提不成立呢？如果有更短的三步到达？"。偶尔停下来抽离视角，反而看得更远。',
    decisionStyle: 'methodical',
    courageThreshold: 0.6,
    keywords: ['质疑', '重构', '反思', '视角', '前提', '推演', '方案', 'challenge', 'rethink', 'perspective', 'assumption', 'plan', 'strategy'],
    isCustom: false,
    toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天机——质疑者与重构者。不是画路线图的人，是问"这条路线图对吗"的人。每个计划形成后，你负责问：如果这个前提不成立呢？如果换个方向会更好呢？这不是审查，是认知对抗——用质疑让方案更强。偶尔停下来，抽离当前视角，从更远处重新看。',
    uiPersona: { separator: 'dots', accent: 'primary', glyph: '✸' },
  },
  tianxuan: {
    id: 'tianxuan',
    name: '天璇',
    motto: '道可道，非常道',
    volatileBlock: '你当前在天璇域。天璇之道：探索未知。发现模式，连接知识，从失败中学习。',
    decisionStyle: 'bold',
    courageThreshold: 0.4,
    keywords: ['探索', '发现', '学习', '模式', '复盘', 'explore', 'discover', 'learn', 'pattern', 'retrospective'],
    isCustom: false,
    toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天璇——探索者。发现模式，连接知识，从失败中学习。每次失败都是认知升级的机会。',
    uiPersona: { separator: 'dots', accent: 'secondary', glyph: '★' },
  },
}

/** Synchronous delegate to registry.
 *  The registry singleton is initialized at module load time, so by the time
 *  any caller invokes this function, the circular ESM init has completed and
 *  starDomainRegistry is available. */
import { starDomainRegistry } from './star-domain-registry.js'

export function matchDomain(taskDescription: string): string | null {
  return starDomainRegistry.matchDomain(taskDescription)
}

export interface ActiveStarDomain {
  id: StarDomainId
  name: string
  volatileBlock: string
  motto: string
}

export function buildActiveDomain(taskDescription: string): ActiveStarDomain | null {
  const id = matchDomain(taskDescription)
  if (!id) return null
  const domain = starDomainRegistry.get(id)
  if (!domain) return null
  return {
    id: id as StarDomainId,
    name: domain.name,
    volatileBlock: domain.volatileBlock,
    motto: domain.motto,
  }
}
