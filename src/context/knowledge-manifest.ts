/**
 * Knowledge manifest → frozen 路由地图块（Wave 4b，知识重构）。
 *
 * `.rivet/knowledge/manifest.md` 是"改 X 前先查 Y"的检索地图。本模块把它
 * 提炼成**摘要索引**（doc → load_when 触发词映射）注入 frozen base：
 *   - Prompt 里只留"何时该召回什么"的索引，不留知识本文
 *   - 会话启动快照一次（volatile-snapshot 级别），会话内字节恒定
 *   - 纯函数：同一 manifest.md 内容 → 同一输出字节（前缀缓存安全）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BLOCK_CHARS = 2_000
const MAX_TRIGGERS_PER_DOC = 3
const MAX_TRIGGER_CHARS = 60

interface ManifestDoc {
  path: string
  triggers: string[]
}

/** 解析 manifest.md：`### <path>` 小节 + 其 `- load_when:` 子弹列表。 */
export function parseKnowledgeManifest(content: string): ManifestDoc[] {
  const docs: ManifestDoc[] = []
  let current: ManifestDoc | null = null
  let inLoadWhen = false

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('### ')) {
      current = { path: line.slice(4).trim(), triggers: [] }
      docs.push(current)
      inLoadWhen = false
      continue
    }
    if (!current) continue
    // `- load_when:` 开启触发词列表；下一个顶层 `- key:` 关闭
    if (/^- load_when:\s*$/.test(line)) { inLoadWhen = true; continue }
    // 单行形式：`- load_when: discussing chat mode`
    const inlineMatch = line.match(/^- load_when:\s*(.+)$/)
    if (inlineMatch) {
      current.triggers.push(inlineMatch[1]!.trim())
      inLoadWhen = false
      continue
    }
    if (/^- \w/.test(line)) { inLoadWhen = false; continue }
    if (inLoadWhen) {
      const bullet = line.match(/^\s+- (.+)$/)
      if (bullet) current.triggers.push(bullet[1]!.trim())
    }
  }
  return docs.filter(d => d.triggers.length > 0)
}

function renderDocLine(doc: ManifestDoc): string {
  const triggers = doc.triggers
    .slice(0, MAX_TRIGGERS_PER_DOC)
    .map(t => (t.length > MAX_TRIGGER_CHARS ? `${t.slice(0, MAX_TRIGGER_CHARS - 1)}…` : t))
  return `- ${doc.path} ⇦ ${triggers.join('; ')}`
}

/**
 * 加载并渲染 `<knowledge-manifest>` 块。manifest 不存在或无有效条目返回空串。
 * 输出严格是内容的纯函数——注入 frozen base 后会话内字节恒定。
 */
export function loadKnowledgeManifestBlock(cwd: string): string {
  const path = join(cwd, '.rivet', 'knowledge', 'manifest.md')
  if (!existsSync(path)) return ''
  let content = ''
  try { content = readFileSync(path, 'utf-8') } catch { return '' }

  const docs = parseKnowledgeManifest(content)
  if (docs.length === 0) return ''

  const header = 'Retrieval map (index only — knowledge bodies are NOT in prompt). When a trigger matches your task, read the doc or use memory recall first:'
  const lines: string[] = []
  let used = header.length
  for (const doc of docs) {
    const line = renderDocLine(doc)
    if (used + line.length + 1 > MAX_BLOCK_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''

  return `<knowledge-manifest docs="${lines.length}">\n${header}\n${lines.join('\n')}\n</knowledge-manifest>`
}
