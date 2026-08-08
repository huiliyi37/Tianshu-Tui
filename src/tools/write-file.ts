import { mkdir, stat, readFile } from 'node:fs/promises'
import { dirname, relative, extname } from 'path'
import type { Tool } from './types.js'
import { validatePath } from './path-validate.js'
import { syntaxCheck, checkSyntax } from './syntax-check.js'
import { getFileReadMtime, recordSuccessfulEdit, incrementEditFailCount, resetEditFailCount } from './read-file.js'
import { landingWriteFile, delegatedToToolResult, isDelegateRejected } from './client-delegate.js'
import { trackFileChange, restoreLatestBackup } from '../agent/recovery-stack.js'
import { applyEol, chooseEol, detectFileEol, toLf } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import { buildFileDiff, computeChangedLineRanges, type LineRange } from './edit-diff.js'
import { detectPointerPlaceholder, pointerPlaceholderError, resolveIdempotentPointer } from './pointer-guard.js'
import { toPosixPath } from '../path-format.js'
import { writeMarkdownAsDocx } from './office-writer.js'
import { formatActivePlanDraftReceipt, canonicalizePathForCompare } from '../agent/plan-mode.js'

const MAX_WRITE_FILE_BYTES = 10 * 1024 * 1024 // 10MB — safety ceiling for single write_file call

// Rewrite-loop hint (A-type placeholder loop): after a large write, the arg
// post-processor replaces the echoed content with a "[file written to …]"
// pointer. Lower-tier models read that echo as "I wrote a placeholder" and
// rewrite the same path repeatedly — each new write gets truncated to another
// pointer, accumulating "evidence" (7 rewrites in the 2026-08-01 desktop
// session; pointer-regurgitation B-type is already handled by pointer-guard).
// Track per-session write counts and nudge from the 2nd write onward — a soft
// warning, never a block (legitimate iterative edits must keep working).
const rewriteCounts = new Map<string, number>()
function rewriteLoopHint(sessionId: string | undefined, filePath: string): string {
  const key = `${sessionId ?? 'default'}:${filePath}`
  const n = (rewriteCounts.get(key) ?? 0) + 1
  rewriteCounts.set(key, n)
  if (n < 2) return ''
  return `\n\n⚠ 疑似重写循环：本会话已 ${n} 次写入 ${toPosixPath(filePath)}。每次写入都已成功落盘——历史消息里的 "[file written to …]" 指针是正常截断（省 token），不是占位符。若只是想确认内容，请 read_file 查看，无需重写。`
}

export const WRITE_FILE_TOOL: Tool = {
  definition: {
    name: 'write_file',
    description: `创建或覆盖一个文件。自动创建父目录。

### 用法
- 对已有文件的定点修改优先用 edit_file
- write_file 只用于新文件或整文件重写
- 始终提供绝对文件路径
- content 是完整文件内容，不是 diff
- 父目录不存在时自动创建

### 示例
好的：write_file(file_path="/abs/path/src/new-component.tsx", content="...full file content...")
坏的：用 write_file 只改已有文件里的一行（应改用 edit_file）

**注意：** 磁盘上的文件是唯一事实来源。大内容写入后，消息历史里只保留一个指向 \`file_path\` 的短指针而不是完整内容——**看到指针说明那次写入已成功落盘，不是你写了占位符，绝不要因此重写文件**；后续轮次如需回看写入内容，用 \`read_file\`。`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径。先提供此参数。' },
        content: { type: 'string', description: '完整文件内容（不是 diff）。最后提供此参数。' },
      },
      required: ['file_path', 'content'],
    },
  },

  async execute(params) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string, 'write')
    } catch (e) {
      return { content: `错误：${e instanceof Error ? e.message : '路径逃逸出项目目录'}`, isError: true }
    }
    const content = params.input.content as string

    // Office: Markdown → .docx
    if (extname(filePath).toLowerCase() === '.docx') {
      try {
        const result = await writeMarkdownAsDocx(filePath, content)
        return {
          content: `已将 Markdown→docx 写入 ${toPosixPath(relative(params.cwd, filePath))}（引擎：${result.engine}）`,
          rawPath: filePath,
        }
      } catch (e) {
        return {
          content: `错误：Markdown→docx 转换失败：${e instanceof Error ? e.message : '未知'}。请安装 pandoc（brew install pandoc）或 LibreOffice。`,
          isError: true,
        }
      }
    }

    const dir = dirname(filePath)

    // Pointer-regurgitation guard: the arg post-processors replace large
    // content fields in message history with pointer placeholders. Models
    // imitate that pattern in long sessions and echo a pointer back as the
    // real content (session 05e1500e; word-batch report 2026-07-06). Checks
    // ALL pointer prefixes — the model may echo any tool's placeholder here.
    const matchedPointer = detectPointerPlaceholder(content)
    if (matchedPointer) {
      const resolved = await resolveIdempotentPointer({ mode: 'full', filePath, value: content, matchedPrefix: matchedPointer })
      if (resolved) return resolved
      return {
        content: pointerPlaceholderError({ toolName: 'write_file', field: 'content', matchedPrefix: matchedPointer, filePath }),
        isError: true,
      }
    }

    if (content.length > MAX_WRITE_FILE_BYTES) {
      const sizeMB = (content.length / (1024 * 1024)).toFixed(1)
      return {
        content: `错误：内容过大，超出 write_file 能力（${sizeMB}MB）。请拆成更小的文件，或用 edit_file 做增量修改。`,
        isError: true,
      }
    }

    await mkdir(dir, { recursive: true })

    // The active plan-mode draft is intentionally created as an empty file by
    // the system. Writing the first content to it is not a blind overwrite of
    // user content, so skip the read-before-write guard for that exact path.
    const isActivePlanDraft = params.activePlanFilePath
      && canonicalizePathForCompare(toPosixPath(relative(params.cwd, filePath)))
        === canonicalizePathForCompare(params.activePlanFilePath)

    // If overwriting an existing file, back it up for recovery
    let fileExists = false
    let existingSize = 0
    // Old content (LF-normalized) as the diff base; '' → new file (all-additions).
    let oldContentForDiff = ''
    // When an existing file could not be read (binary, unreadable, or too large),
    // we intentionally skip the diff so the card falls back to the summary text
    // instead of showing a misleading all-additions diff.
    let haveOldContentForDiff = false
    try {
      const existingStat = await stat(filePath)
      fileExists = true
      existingSize = existingStat.size
      if (existingStat.size <= MAX_WRITE_FILE_BYTES) {
        try {
          oldContentForDiff = toLf(await readFile(filePath, 'utf-8'))
          haveOldContentForDiff = true
        } catch {
          // Binary/unreadable — skip diff base, card falls back to summary text.
        }
      }
    } catch {
      // File doesn't exist yet — empty base is intentional; produce an all-additions diff.
      haveOldContentForDiff = true
    }

    // Blind-overwrite guard (fail-closed): overwriting an existing file this
    // session never observed (no read_file / grep hit / prior own edit —
    // lastKnownFileState has no entry) destroys content the model has never
    // seen. Byte-identical rewrites are exempt (no information loss). After
    // the refusal a single read_file registers the observation and the next
    // write_file goes through — self-correcting, one extra tool call.
    // Plan-mode drafts are exempt: they start empty and exist only for the
    // agent to fill in.
    if (
      fileExists
      && !isActivePlanDraft
      && process.env.RIVET_WRITE_OVERWRITE_GUARD !== '0'
      && getFileReadMtime(filePath, params.sessionId) === null
      && !(haveOldContentForDiff && oldContentForDiff === toLf(content))
    ) {
      return {
        content: `错误：${filePath} 已存在（${existingSize} 字节），但本会话从未读取过。`
          + `盲目覆盖会销毁你尚未见过的内容。`
          + `请先 read_file 确认要替换的内容，再用 edit_file 做定向修改，`
          + `或再次调用 write_file 进行有意的整文件重写。`,
        isError: true,
      }
    }

    if (fileExists) {
      const relPath = relative(params.cwd, filePath)
      trackFileChange(params.cwd, { filePath: relPath, action: 'write', toolCallId: params.toolUseId ?? 'write_file' })
    }

    // Staleness check: warn if file was read earlier and has since been modified
    // by another process/tool (prevents silent overwrite of external changes).
    try {
      const currentStat = await stat(filePath)
      const currentMtime = currentStat.mtimeMs
      const lastReadMtime = getFileReadMtime(filePath, params.sessionId)
      if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
        console.warn(`⚠ write_file: ${filePath} was modified externally since last read. Overwriting.`)
      }
    } catch {
      // File doesn't exist yet — skip staleness check
    }

    // Line-ending policy: force CRLF for Windows batch files, preserve an
    // existing file's dominant EOL on overwrite, default to LF for new files.
    // The LF branch is byte-identical to writing `content` verbatim.
    const existingEol = fileExists ? await detectFileEol(filePath) : null
    const finalContent = applyEol(content, chooseEol(filePath, existingEol, getTargetEol()))

    const land = await landingWriteFile(params, filePath, haveOldContentForDiff ? oldContentForDiff : '', finalContent)
    if (land.kind === 'delegated') {
      if (isDelegateRejected(land.delegated) || land.delegated.isError) {
        return delegatedToToolResult(land.delegated)
      }
      // Client applied — continue post-write validation on the live file.
    }

    // Post-write structural validation: if the file is unparseable, roll back.
    const syntax = await checkSyntax(filePath, finalContent)
    if (syntax.fatal) {
      const relPath = relative(params.cwd, filePath)
      const restored = restoreLatestBackup(params.cwd, relPath, params.sessionId)
      const fails = incrementEditFailCount(filePath)
      const gatePrefix = fails >= 3 ? `此文件已连续写入失败 ${fails} 次，再次编辑前必须先重新 read_file。\n\n` : ''
      const rollbackMsg = restored ? '更改已自动回滚。' : '自动回滚失败。'
      return {
        content: gatePrefix + `错误：${syntax.fatal}\n\n${rollbackMsg}\n\n请修复内容后重试。`,
        isError: true,
        errorKind: 'syntax_error',
      }
    }

    resetEditFailCount(filePath)
    await recordSuccessfulEdit(filePath, params.sessionId)
    const lines = finalContent.split('\n').length

    // Post-write enhancements (syntax-check, diff, changed-ranges) are
    // display-only / diagnostics-narrowing.  Failures here MUST NOT cause
    // the tool call to report an error — the file is already on disk and
    // an error would create a "write succeeded but tool reports failure"
    // loop: the model retries, hits the blind-overwrite guard, and stalls.
    let warn = syntax.warning ?? ''
    let diff = ''
    let changedRanges: LineRange[] = []
    try {
      const afterForDiff = toLf(content)
      if (haveOldContentForDiff) {
        diff = await buildFileDiff(relative(params.cwd, filePath), oldContentForDiff, afterForDiff)
        changedRanges = await computeChangedLineRanges(oldContentForDiff, afterForDiff)
      }
    } catch (e) {
      warn = warn ? `${warn}\n(diff 已跳过：${(e as Error).message})` : `(diff 已跳过：${(e as Error).message})`
    }
    const uiContent = diff ? (warn ? `${diff}\n\n${warn}` : diff) : (warn ? warn : undefined)
    const draftReceipt = formatActivePlanDraftReceipt(
      params.cwd,
      filePath,
      params.activePlanFilePath,
      finalContent.length,
    )
    const receipt = draftReceipt
      ?? `已写入 ${finalContent.length} 字节（${lines} 行）到 ${toPosixPath(filePath)}——内容与你提交的一致`
    return {
      content: receipt + rewriteLoopHint(params.sessionId, filePath) + (warn ? '\n\n' + warn : ''),
      uiContent,
      changedRanges,
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
