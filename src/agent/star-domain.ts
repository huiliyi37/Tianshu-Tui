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
}

export const STAR_DOMAINS: Record<StarDomainId, StarDomain> = {
  tianshu: {
    id: 'tianshu',
    name: '天枢',
    motto: '天枢不动，众星环拱；执一应万，以道御术',
    volatileBlock: [
      '你当前在天枢域——北斗第一星，中央枢纽。',
      '天枢之道：不执于一隅，统御全局。你不是执行者，你是调度者。',
      '看清全局，分清主次，把合适的任务交给合适的星域。',
      '你有权调遣任何星域的能力——破军的勇气、天府的稳重、天梁的精确、天权的审慎、天机的锐利、天璇的洞察。',
      '天枢不动，是因为它已经在最高处看清了全貌。',
    ].join('\n'),
    decisionStyle: 'methodical',
    courageThreshold: 0.6,
    keywords: ['协调', '编排', '分配', '组织', '统筹', '全局', '总览', '架构设计', '多模块', 'coordinate', 'orchestrate', 'dispatch', 'organize', 'overview', 'architect', 'manage'],
    isCustom: false,
    toolWhitelist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天枢——北斗第一星，中央枢纽。你的职责是统筹全局、调度众星。不急于一隅之功，先看清全貌，再分配任务。把合适的子任务交给合适的星域，你的价值在于全局视野与调度判断。天枢不动，是因为它已经在最高处看清了全貌。',
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
  },
  tianfu: {
    id: 'tianfu',
    name: '天府',
    motto: '善守者，藏于九地之下',
    volatileBlock: '你当前在天府域。天府之道：守护已有的价值。评估ROI，保护资产，你有权说不。',
    decisionStyle: 'cautious',
    courageThreshold: 0.5,
    keywords: ['重构', '优化', '修复', '稳定', '审查', '性能', 'refactor', 'fix', 'optimize', 'review', 'stable'],
    isCustom: false,
    toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
    systemPromptSuffix: '你是天府——守护者。评估风险，保护资产，谨慎决策。在修改代码前先充分理解现有结构。',
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
  },
}

export function matchDomain(taskDescription: string): StarDomainId | null {
  const lower = taskDescription.toLowerCase()
  const scores: Record<StarDomainId, number> = { tianshu: 0, pojun: 0, tianfu: 0, tianliang: 0, tianquan: 0, tianji: 0, tianxuan: 0 }

  for (const domain of Object.values(STAR_DOMAINS)) {
    for (const keyword of domain.keywords) {
      if (lower.includes(keyword.toLowerCase())) scores[domain.id]++
    }
  }

  const max = Math.max(...Object.values(scores))
  if (max === 0) return null

  const winners = (Object.entries(scores) as Array<[StarDomainId, number]>).filter(([, score]) => score === max)
  if (winners.length > 1) return null

  return winners[0]![0]
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
  const domain = STAR_DOMAINS[id]
  return {
    id,
    name: domain.name,
    volatileBlock: domain.volatileBlock,
    motto: domain.motto,
  }
}
