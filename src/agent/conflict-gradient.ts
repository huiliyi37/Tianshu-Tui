/**
 * ConflictGradient — 四色冲突梯度检测
 *
 * 不再是非黑即白的"冲突/不冲突"，而是一个连续的梯度：
 * 🟢 Green  → 无文件重叠，直接并行
 * 🟡 Yellow → 文件重叠但意图互补，并行但加入合并队列
 * 🟠 Orange → 文件重叠且意图可能冲突，序列化
 * 🔴 Red    → 文件重叠且意图冲突，阻止
 */

import type { SemanticLock, LockIntent } from './semantic-lock.js'
import { getLockCompatibility } from './semantic-lock.js'

// ─── Types ────────────────────────────────────────────────

export type ConflictLevel = 'green' | 'yellow' | 'orange' | 'red'

export interface ConflictAssessment {
  /** 冲突级别 */
  level: ConflictLevel
  /** 重叠的文件 */
  overlappingFiles: string[]
  /** 详细说明 */
  detail: string
  /** 处理建议 */
  recommendation: string
  /** 涉及的锁 */
  locksA: SemanticLock[]
  locksB: SemanticLock[]
}

// ─── Detection ────────────────────────────────────────────

/**
 * 检测两个 session 之间的冲突梯度
 *
 * 算法：
 * 1. 计算两个 session 的文件集合交集
 * 2. 无交集 → Green
 * 3. 有交集，检查操作兼容性
 *    - compatible → Yellow（文件重叠但操作兼容）
 *    - conditional → Orange（需要进一步检查）
 *    - exclusive → Red（操作互斥）
 */
export function detectConflictGradient(
  locksA: SemanticLock[],
  locksB: SemanticLock[],
): ConflictAssessment {
  if (locksA.length === 0 || locksB.length === 0) {
    return {
      level: 'green',
      overlappingFiles: [],
      detail: 'One or both sessions have no active locks',
      recommendation: 'Proceed in parallel',
      locksA,
      locksB,
    }
  }

  // 同一 session 不冲突
  if (locksA[0] && locksB[0] && locksA[0].sessionId === locksB[0].sessionId) {
    return {
      level: 'green',
      overlappingFiles: [],
      detail: 'Same session',
      recommendation: 'Proceed',
      locksA,
      locksB,
    }
  }

  const filesA = new Set(locksA.flatMap(l => l.intent.files))
  const filesB = new Set(locksB.flatMap(l => l.intent.files))

  // 计算交集
  const overlap = [...filesA].filter(f => filesB.has(f))

  if (overlap.length === 0) {
    return {
      level: 'green',
      overlappingFiles: [],
      detail: 'No file overlap between sessions',
      recommendation: 'Proceed in parallel',
      locksA,
      locksB,
    }
  }

  // 检查重叠文件上的操作兼容性
  let maxCompat: import('./semantic-lock.js').LockCompatibility = 'compatible'
  const compatDetails: string[] = []

  for (const lockA of locksA) {
    for (const lockB of locksB) {
      const fileOverlap = lockA.intent.files.filter(f => lockB.intent.files.includes(f))
      if (fileOverlap.length === 0) continue

      const compat = getLockCompatibility(lockA.intent.operation, lockB.intent.operation)
      compatDetails.push(
        `${lockA.intent.operation} vs ${lockB.intent.operation} on [${fileOverlap.join(', ')}]: ${compat}`,
      )

      if (compat === 'exclusive') {
        maxCompat = 'exclusive'
      } else if (compat === 'conditional' && maxCompat === 'compatible') {
        maxCompat = 'conditional'
      }
    }
  }

  // 检查 domain hints 互补性
  const domainsA = new Set(locksA.flatMap(l => l.intent.domainHints ?? []))
  const domainsB = new Set(locksB.flatMap(l => l.intent.domainHints ?? []))
  const domainOverlap = [...domainsA].filter(d => domainsB.has(d))
  const domainsComplementary = domainsA.size > 0 && domainsB.size > 0 && domainOverlap.length === 0

  if (maxCompat === 'exclusive') {
    return {
      level: 'red',
      overlappingFiles: overlap,
      detail: `Exclusive operations on shared files: ${compatDetails.join('; ')}`,
      recommendation: 'Block: reassign one worker to different files or wait',
      locksA,
      locksB,
    }
  }

  if (maxCompat === 'conditional') {
    // conditional + domain 互补 → 可能安全
    if (domainsComplementary) {
      return {
        level: 'yellow',
        overlappingFiles: overlap,
        detail: `Conditional operations but domains complementary: ${compatDetails.join('; ')}`,
        recommendation: 'Proceed in parallel with merge queue monitoring',
        locksA,
        locksB,
      }
    }
    return {
      level: 'orange',
      overlappingFiles: overlap,
      detail: `Conditional operations with potential conflict: ${compatDetails.join('; ')}`,
      recommendation: 'Serialize: wait for first worker to complete before starting second',
      locksA,
      locksB,
    }
  }

  // compatible 但有文件重叠
  return {
    level: 'yellow',
    overlappingFiles: overlap,
    detail: `Compatible operations on shared files: ${compatDetails.join('; ')}`,
    recommendation: 'Proceed in parallel with merge queue',
    locksA,
    locksB,
  }
}

/**
 * 检测一个新 intent 与现有所有锁的冲突
 */
export function assessIntentConflict(
  newIntent: LockIntent,
  existingLocks: SemanticLock[],
  sessionId: string,
): ConflictAssessment {
  const otherLocks = existingLocks.filter(l => l.sessionId !== sessionId)
  if (otherLocks.length === 0) {
    return {
      level: 'green',
      overlappingFiles: [],
      detail: 'No other sessions hold locks',
      recommendation: 'Proceed',
      locksA: [],
      locksB: [],
    }
  }

  // 创建临时锁用于检测
  const tempLock: SemanticLock = {
    sessionId,
    intent: newIntent,
    acquiredAt: Date.now(),
    lastHeartbeat: Date.now(),
    ttl: 0,
  }

  return detectConflictGradient([tempLock], otherLocks)
}

/** 冲突级别排序值（越高越严重） */
export function conflictLevelValue(level: ConflictLevel): number {
  switch (level) {
    case 'green': return 0
    case 'yellow': return 1
    case 'orange': return 2
    case 'red': return 3
  }
}

/** 比较两个冲突级别 */
export function isWorseThan(a: ConflictLevel, b: ConflictLevel): boolean {
  return conflictLevelValue(a) > conflictLevelValue(b)
}
