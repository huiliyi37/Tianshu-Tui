/**
 * 行动意图检测器：判断模型是否"宣布了行动但未发出（对应的）工具调用"。
 *
 * 从已删除的 phantom-continuation.ts（abdbd6b2）中提取纯检测逻辑——
 * 只检测，不做决策，不绑定 budget/contract/continue 语义。
 * 消费方：turn-orchestrator 的 no-tool 路径（hasActionIntent）与
 * 只读工具轮路径（hasWriteActionIntent + turnUsedOnlyReadTools，
 * spec 2026-07-05-action-intent-readonly-gate）。
 */

import { profileIsWriteCapable } from './profile-registry.js'

/**
 * 行动承诺标记——"让我…""接下来…""let me…"等，暗示模型打算做某事。
 * 来源：phantom-continuation.ts ACTION_PROMISE_PATTERN + 新增中文变体。
 */
const ACTION_PROMISE_PATTERN =
  /(让我|接下来|现在(?:就)?|下一步|稍后|我来(?!自|了|不|过)|我去|我先|这就|马上|i'?ll\b|i will\b|let me\b|let's\b|going to\b|next[,，]?\s*i|now i)/i

/**
 * 工具动词——模型描述打算使用的工具或操作。
 * 来源：phantom-continuation.ts TOOL_VERB_PATTERN，去掉了"看"（太常见，误报高）；
 * 后补"重写/更新/写入"等写动作词（4df36bcd 系列：宣布"更新计划"未命中旧模式）。
 */
const TOOL_VERB_PATTERN =
  /(grep|ripgrep|read|edit|write|run|test|bash|cat|ls|glob|fetch|curl|查(?:看|找|阅)?|搜索|读取?|修改|编辑|运行|执行|跑(?:一?下|测试)?|改一?下|写一?下|重写|写(?:入|文件)|更新(?:文件|计划|文档)?|看(?:一?下)?(?:代码|文件))/i

/**
 * 写侧动词——承诺的是写入/修改/测试类操作（区别于"查/搜/读"的只读调研）。
 * 只读工具轮的闸门只认写侧承诺：模型说"让我看看这个文件"并 read_file 是
 * 正常调研，不该被提醒；说"更新计划"却只发 grep 才是要拦的失败模式。
 */
const WRITE_VERB_PATTERN =
  /((?:edit|write|fix|patch|apply|commit|rewrite|update|implement|refactor)(?![a-z])|run\s+(?:the\s+)?tests?|typecheck|修改|编辑|重写|更新|写入|写文件|写一?下|提交|修复|实现|重构|落地|删除|删掉|改一?下|改掉|加上|补上|跑(?:一?下)?\s*(?:测试|typecheck)|运行测试|执行测试)/i

/**
 * 祈使收尾：最后一句以裸动作动词开头、无任何承诺词（4df36bcd：
 * 「全部正确。跑 typecheck + 测试。」——没有"让我/接下来"，旧模式漏检，
 * turn 被判 natural-finish 直接收尾）。约束：
 *  - 只看最后一句（。！？!?\n 切分），且句长 ≤ 80 字符（长句多为陈述）；
 *  - 句内含完成态标记（了/已/通过/done…）视为汇报而非承诺，不触发。
 */
const IMPERATIVE_HEAD_RE =
  /^(?:(?:先|再|然后|接着|继续|马上|立即|下面|现在)\s*)?(?:跑|运行|执行|修(?:复|改|正|好|一下|掉|\s)|重写|更新|编辑|提交|构建|部署|安装|重启|验证|重构|(?:re)?run(?![a-z])|fix(?![a-z])|update(?![a-z])|rewrite(?![a-z])|commit(?![a-z])|build(?![a-z])|deploy(?![a-z])|verify(?![a-z]))/i

const COMPLETION_MARKER_RE =
  /(了|已|完成|完毕|通过|失败|成功|中断|报错|✓|✗|done\b|passed\b|failed\b|finished\b)/i

function lastSentence(text: string): string {
  const parts = text.split(/[。！？!?\n]+/)
  for (let i = parts.length - 1; i >= 0; i--) {
    const s = parts[i]!.trim()
    if (s.length > 0) return s
  }
  return ''
}

/** 尾句是否为祈使式行动宣布（动词开头、非完成态汇报、非问句）。 */
export function hasImperativeActionTail(text: string): boolean {
  if (!text) return false
  const tail = text.length > 600 ? text.slice(-600) : text
  // Questions are inquiries, not imperatives — "要我实施吗？" is asking,
  // not declaring an action to take.
  if (/[？?]$/.test(tail.trimEnd())) return false
  const sentence = lastSentence(tail)
  if (!sentence || sentence.length > 80) return false
  return IMPERATIVE_HEAD_RE.test(sentence) && !COMPLETION_MARKER_RE.test(sentence)
}

/**
 * 交付/收尾信号——全文级别（非仅尾句或尾部 600 字符）。
 * 当文本整体是测试报告、交付总结或任务完成声明时，
 * 即使中间某个句子形似祈使命令（"再跑 X"），也不应视为行动意图。
 * 来源：交付总结含 ✓/passed/任务完成 时被 action-intent gate 误判的回归。
 */
export const DELIVERY_SIGNAL_RE =
  /(?:typecheck\s*[✓✗]|^\d+\s*passed|^\d+\/\d+\s*[✓✗]|任务完成[，。]|交付[。！]|commit\s+[0-9a-f]{7}|^[✓✗]\s|(?:^|\n)>?\s*(?:fix|feat|refactor|test|chore|docs|perf)[(:]\s)/mi

/**
 * 检查文本尾部是否宣布了行动：显式承诺（"让我…"+工具动词）或祈使收尾。
 * 只看尾部 600 字符——行动承诺（如果有）通常在回复结尾。
 */
export function hasActionIntent(text: string): boolean {
  if (!text) return false
  // 交付/收尾守卫：全文含强交付信号时直接返回 false，
  // 不再检测尾部 600 字符或尾句——这是已完成的汇报，不是悬空的行动承诺。
  if (DELIVERY_SIGNAL_RE.test(text)) return false
  const tail = text.length > 600 ? text.slice(-600) : text
  if (ACTION_PROMISE_PATTERN.test(tail) && TOOL_VERB_PATTERN.test(tail)) return true
  return hasImperativeActionTail(text)
}

/**
 * 写意图变体：承诺的必须是写侧操作。用于只读工具轮的闸门——
 * 读侧承诺（"让我看看这个文件"）配 read_file 是正常调研，不算失配。
 */
export function hasWriteActionIntent(text: string): boolean {
  if (!text) return false
  if (DELIVERY_SIGNAL_RE.test(text)) return false
  const tail = text.length > 600 ? text.slice(-600) : text
  if (ACTION_PROMISE_PATTERN.test(tail) && WRITE_VERB_PATTERN.test(tail)) return true
  return hasImperativeActionTail(text)
}

/**
 * 会推进"写承诺"的工具——文件写入、状态变更命令、测试执行、计划/交付操作。
 * 故意用白名单（未知工具视为只读）：漏判的代价只是一次多余的 nudge，
 * 反向漏报则让闸门对新写工具静默失效。
 */
const WRITE_ADVANCING_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'hash_edit', 'apply_patch', 'ast_edit',
  'bash', 'sandbox_exec', 'git', 'fastgit',
  'run_tests', 'jest', 'mocha', 'vitest',
  'plan', 'plan_task', 'undo', 'team_orchestrate', 'job', 'browser',
  'create_document', 'create_pdf', 'create_presentation', 'create_spreadsheet',
  'create_image', 'export_file',
])

/** delegate_task 单 profile / delegate_batch tasks[].profile（与 tool-pipeline 同构）。 */
function delegateProfiles(input: Record<string, unknown>): string[] {
  const names: string[] = []
  if (typeof input.profile === 'string') names.push(input.profile)
  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      if (task && typeof task === 'object' && typeof (task as { profile?: unknown }).profile === 'string') {
        names.push((task as { profile: string }).profile)
      }
    }
  }
  return names
}

/**
 * 本轮工具是否全为只读（不推进任何写承诺）。委派算只读，除非派了
 * 写能力 profile（patcher 等）——派只读 scout 做调研同样不推进写操作。
 * 无工具轮返回 false：那是 no-tool 闸门的辖区，不归这里。
 */
export function turnUsedOnlyReadTools(
  toolUses: ReadonlyArray<{ name: string; input?: Record<string, unknown> }>,
): boolean {
  if (toolUses.length === 0) return false
  for (const tu of toolUses) {
    if (WRITE_ADVANCING_TOOLS.has(tu.name)) return false
    if ((tu.name === 'delegate_task' || tu.name === 'delegate_batch') && tu.input) {
      if (delegateProfiles(tu.input).some(profileIsWriteCapable)) return false
    }
  }
  return true
}
