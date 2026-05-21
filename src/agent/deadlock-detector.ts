/**
 * DeadlockDetector — 图论死锁检测
 *
 * Worker 等待资源分配图中的环检测：
 *
 *   Worker A → [file-1] ← Worker B
 *   Worker B → [file-2] ← Worker A   ← 死锁！
 *
 * 使用 DFS 环检测算法。每次锁请求失败时触发检测。
 */

import type { SemanticLock, LockIntent } from './semantic-lock.js'
import { getLockCompatibility } from './semantic-lock.js'

// ─── Types ────────────────────────────────────────────────

export interface WaitEdge {
  /** 等待者 session ID */
  waiter: string
  /** 占有者 session ID */
  holder: string
  /** 等待的资源（文件） */
  resource: string
}

export interface DeadlockReport {
  /** 死锁环中的 session ID 列表 */
  cycle: string[]
  /** 涉及的资源 */
  resources: string[]
  /** 建议的受害者（最近请求的 session） */
  victim: string
}

// ─── Detection ────────────────────────────────────────────

/**
 * 构建 Wait-For Graph
 *
 * 给定一个等待锁的 intent 和当前的活跃锁，
 * 构建"谁在等谁"的有向图。
 */
export function buildWaitForGraph(
  waitingSessionId: string,
  waitingIntent: LockIntent,
  activeLocks: SemanticLock[],
): WaitEdge[] {
  const edges: WaitEdge[] = []

  for (const file of waitingIntent.files) {
    // 找到占有这个文件的锁
    for (const lock of activeLocks) {
      if (lock.sessionId === waitingSessionId) continue
      if (!lock.intent.files.includes(file)) continue

      const compat = getLockCompatibility(waitingIntent.operation, lock.intent.operation)
      if (compat === 'exclusive') {
        edges.push({
          waiter: waitingSessionId,
          holder: lock.sessionId,
          resource: file,
        })
      }
    }
  }

  return edges
}

/**
 * 从多个等待请求构建完整的 Wait-For Graph
 */
export function buildFullWaitForGraph(
  waiters: Array<{ sessionId: string; intent: LockIntent }>,
  activeLocks: SemanticLock[],
): WaitEdge[] {
  const edges: WaitEdge[] = []
  for (const { sessionId, intent } of waiters) {
    edges.push(...buildWaitForGraph(sessionId, intent, activeLocks))
  }
  return edges
}

/**
 * DFS 环检测（Tarjan 风格三色标记）
 *
 * 从邻接表中检测是否存在环。返回找到的第一个环。
 * 使用 resultBox 模式：在 DFS 内部直接捕获结果，不依赖外部 path 提取。
 */
export function detectCycle(edges: WaitEdge[]): DeadlockReport | null {
  if (edges.length === 0) return null

  // 构建邻接表：waiter → [holder, ...]
  const adj = new Map<string, Set<string>>()
  const resourceMap = new Map<string, string>() // "waiter→holder" → resource

  for (const edge of edges) {
    if (!adj.has(edge.waiter)) adj.set(edge.waiter, new Set())
    adj.get(edge.waiter)!.add(edge.holder)
    resourceMap.set(`${edge.waiter}→${edge.holder}`, edge.resource)
  }

  // 三色标记
  const WHITE = 0 // 未访问
  const GRAY = 1  // 在当前 DFS 栈中
  const BLACK = 2 // 已完成
  const color = new Map<string, number>()
  const allNodes = new Set<string>()
  for (const edge of edges) {
    allNodes.add(edge.waiter)
    allNodes.add(edge.holder)
  }
  for (const node of allNodes) {
    color.set(node, WHITE)
  }

  // 结果盒子：DFS 内部发现环时直接写入
  let foundCycle: string[] | null = null
  let foundResources: string[] | null = null
  const stack: string[] = [] // 当前 DFS 路径

  function dfs(node: string): boolean {
    color.set(node, GRAY)
    stack.push(node)

    const neighbors = adj.get(node)
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (foundCycle) return true // 已经找到环，快速退出

        const neighborColor = color.get(neighbor) ?? WHITE
        if (neighborColor === GRAY) {
          // 找到环！从 stack 中提取环
          const cycleStart = stack.indexOf(neighbor)
          foundCycle = [...stack.slice(cycleStart), neighbor]
          // 收集环上涉及的资源
          foundResources = []
          for (let i = cycleStart; i < stack.length; i++) {
            const from = stack[i]!
            const to = (i + 1 < stack.length) ? stack[i + 1]! : neighbor
            foundResources.push(resourceMap.get(`${from}→${to}`) ?? 'unknown')
          }
          return true
        }
        if (neighborColor === WHITE) {
          if (dfs(neighbor)) return true
        }
      }
    }

    stack.pop()
    color.set(node, BLACK)
    return false
  }

  for (const node of allNodes) {
    if (color.get(node) === WHITE) {
      if (dfs(node) && foundCycle && foundResources) {
        const cycle: string[] = foundCycle
        const resources: string[] = foundResources
        const victim = cycle.reduce((a, b) => (a > b ? a : b))
        return {
          cycle,
          resources: [...new Set(resources)],
          victim,
        }
      }
    }
  }

  return null
}

/**
 * 检测死锁并返回解决方案
 *
 * 返回需要释放锁的受害者 session ID。
 */
export function detectAndResolve(
  waiters: Array<{ sessionId: string; intent: LockIntent }>,
  activeLocks: SemanticLock[],
): DeadlockReport | null {
  const edges = buildFullWaitForGraph(waiters, activeLocks)
  return detectCycle(edges)
}
