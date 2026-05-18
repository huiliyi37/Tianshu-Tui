import { createHash } from 'node:crypto'

/**
 * 计算 JSON 行的 SHA-256 校验和（取前 8 字节 hex = 16 字符）
 * 格式: `{json}|{checksum}`
 * 
 * 为什么用 SHA-256 前 8 字节而不是 CRC32：
 * - CRC32 碰撞率高（2^32 空间），不适合数据完整性验证
 * - SHA-256 前 8 字节提供 2^64 空间，碰撞概率极低
 * - 性能差异可忽略（JSONL 每行通常 <1KB）
 */
export function computeLineChecksum(jsonLine: string): string {
  const hash = createHash('sha256').update(jsonLine).digest('hex')
  return hash.slice(0, 16) // 前 8 字节 = 16 hex 字符
}

/**
 * 为 JSON 行添加校验和
 * @param jsonLine - 纯 JSON 字符串（不含换行）
 * @returns 带校验和的行：`{json}|{checksum}`
 */
export function appendChecksum(jsonLine: string): string {
  const checksum = computeLineChecksum(jsonLine)
  return `${jsonLine}|${checksum}`
}

/**
 * 验证并提取 JSON 行
 * @param line - 带校验和的行或旧格式行
 * @returns 解析结果：{ valid, json, isLegacy, error? }
 */
export function verifyAndExtract(line: string): {
  valid: boolean
  json: string
  isLegacy: boolean
  error?: string
} {
  const trimmed = line.trim()
  if (!trimmed) {
    return { valid: false, json: '', isLegacy: false, error: 'Empty line' }
  }

  // 检查是否有校验和分隔符
  const lastPipe = trimmed.lastIndexOf('|')
  if (lastPipe === -1) {
    // 旧格式：无校验和，尝试直接解析
    return { valid: true, json: trimmed, isLegacy: true }
  }

  // 新格式：验证校验和
  const jsonPart = trimmed.slice(0, lastPipe)
  const storedChecksum = trimmed.slice(lastPipe + 1)

  // 校验和格式验证（16 字符 hex）
  if (!/^[0-9a-f]{16}$/.test(storedChecksum)) {
    // 不是有效校验和格式，可能是 JSON 中包含 | 字符
    return { valid: true, json: trimmed, isLegacy: true }
  }

  // 额外验证：检查 jsonPart 是否是有效 JSON
  // 如果不是有效 JSON，说明是旧格式中包含 | 字符
  try {
    JSON.parse(jsonPart)
  } catch {
    return { valid: true, json: trimmed, isLegacy: true }
  }

  const computedChecksum = computeLineChecksum(jsonPart)
  if (computedChecksum !== storedChecksum) {
    return {
      valid: false,
      json: jsonPart,
      isLegacy: false,
      error: `Checksum mismatch: expected ${computedChecksum}, got ${storedChecksum}`
    }
  }

  return { valid: true, json: jsonPart, isLegacy: false }
}

/**
 * 批量验证 JSONL 行
 * @param lines - 原始行数组
 * @returns 验证结果：{ validLines, invalidCount, legacyCount }
 */
export function verifyLines(lines: string[]): {
  validLines: string[]
  invalidCount: number
  legacyCount: number
} {
  let invalidCount = 0
  let legacyCount = 0
  const validLines: string[] = []

  for (const line of lines) {
    const result = verifyAndExtract(line)
    if (result.valid) {
      validLines.push(result.json)
      if (result.isLegacy) legacyCount++
    } else {
      invalidCount++
    }
  }

  return { validLines, invalidCount, legacyCount }
}
