import type { DomainArea, WorkOrderScope } from './work-order.js'
import type { StarDomainId } from './star-domain.js'
import type { TaskContract } from '../context/task-contract.js'
import { matchDomain } from './star-domain.js'

/** 按文件路径分类到领域轴。测试文件优先匹配（可出现在任何域目录下）。 */
export function classifyFile(path: string): DomainArea {
  if (/\.(test|spec)\./.test(path)) return 'tests'
  if (/src\/tui\//.test(path)) return 'frontend'
  if (/src\/prompt\//.test(path)) return 'prompt'
  if (/src\/config\//.test(path)) return 'config'
  if (/src\/tools\//.test(path)) return 'tools'
  if (/docs\//.test(path)) return 'docs'
  // src/agent/, src/api/, src/compact/, src/context/
  return 'backend'
}

/** 将文件列表按领域分组 */
export function groupFilesByDomain(files: string[]): Map<DomainArea, string[]> {
  const groups = new Map<DomainArea, string[]>()
  for (const file of files) {
    const area = classifyFile(file)
    const list = groups.get(area) ?? []
    list.push(file)
    groups.set(area, list)
  }
  return groups
}

export interface DecomposedTask {
  title: string
  objective: string
  domain: DomainArea
  authority: StarDomainId
  dependsOn: number[]  // 同一 decompose 调用内的 index
  scope: WorkOrderScope
}

/**
 * 基于数据流的依赖分析。
 *
 * 规则：
 * 1. tests 域依赖它测试的源文件所在域
 * 2. 不同域之间如果没有文件/符号引用关系，则并行
 * 3. 只有存在数据流依赖时才建边
 *
 * 例：用户说 "重构 auth 模块并添加测试"
 * 文件：src/agent/auth.ts, src/tui/login.tsx, src/agent/__tests__/auth.test.ts
 *
 * T0 [backend] 重构 auth.ts         → 无依赖
 * T1 [frontend] 更新 login.tsx       → 无依赖（与 T0 并行！）
 * T2 [tests] 编写 auth.test.ts       → 依赖 T0（测试被测模块）
 */
export function decomposeByDataContract(contract: TaskContract): DecomposedTask[] {
  const files = contract.scope.mentionedFiles
  if (files.length === 0) {
    return [{
      title: contract.objective.slice(0, 60),
      objective: contract.objective,
      domain: 'backend',
      authority: (matchDomain(contract.objective) ?? 'tianliang') as StarDomainId,
      dependsOn: [],
      scope: { files: [] },
    }]
  }

  // 按域分组
  const groups = groupFilesByDomain(files)

  // 为每个域生成任务
  const tasks: DecomposedTask[] = []
  const domainIndex = new Map<DomainArea, number>()

  for (const [domain, domainFiles] of groups) {
    const objective = `处理 ${domain} 域: ${domainFiles.join(', ')}`
    tasks.push({
      title: `[${domain}] ${contract.objective.slice(0, 40)}`,
      objective,
      domain,
      authority: (matchDomain(objective) ?? 'tianliang') as StarDomainId,
      dependsOn: [],
      scope: { files: domainFiles },
    })
    domainIndex.set(domain, tasks.length - 1)
  }

  // 基于数据流建依赖边
  // 规则：tests 依赖被测源文件所在域
  // 匹配方式：提取测试文件的基名（去掉 __tests__/ 前缀和 .test./.spec. 后缀），
  // 检查源文件是否包含该基名
  const testIdx = domainIndex.get('tests')
  if (testIdx !== undefined) {
    const testFiles = groups.get('tests') ?? []
    for (const [domain, idx] of domainIndex) {
      if (domain === 'tests') continue
      const domainFiles = groups.get(domain) ?? []
      const hasLink = testFiles.some(tf => {
        // 提取测试文件基名：src/agent/__tests__/loop.test.ts → loop
        const testBase = tf.replace(/.*\//, '').replace(/\.(test|spec)\.\w+$/, '')
        return domainFiles.some(df => {
          const srcBase = df.replace(/.*\//, '').replace(/\.\w+$/, '')
          return srcBase === testBase
        })
      })
      if (hasLink) {
        tasks[testIdx]!.dependsOn.push(idx)
      }
    }
  }

  return tasks
}
