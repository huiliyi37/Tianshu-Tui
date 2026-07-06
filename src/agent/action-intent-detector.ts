/**
 * 行动意图检测器：判断模型是否"宣布了行动但未发出工具调用"。
 *
 * 从已删除的 phantom-continuation.ts（abdbd6b2）中提取纯检测逻辑——
 * 只检测，不做决策，不绑定 budget/contract/continue 语义。
 * 消费方：turn-orchestrator 的 no-tool 路径（轻量闸门）。
 */

/**
 * 行动承诺标记——"让我…""接下来…""let me…"等，暗示模型打算做某事。
 * 来源：phantom-continuation.ts ACTION_PROMISE_PATTERN + 新增中文变体。
 */
const ACTION_PROMISE_PATTERN =
  /(让我|接下来|现在(?:就)?|下一步|稍后|我来(?!自|了|不|过)|我去|我先|这就|马上|i'?ll\b|i will\b|let me\b|let's\b|going to\b|next[,，]?\s*i|now i)/i

/**
 * 工具动词——模型描述打算使用的工具或操作。
 * 来源：phantom-continuation.ts TOOL_VERB_PATTERN，去掉了"看"（太常见，误报高）。
 */
const TOOL_VERB_PATTERN =
  /(grep|ripgrep|read|edit|write|run|test|bash|cat|ls|glob|fetch|curl|查(?:看|找|阅)?|搜索|读取?|修改|编辑|运行|执行|跑(?:一?下|测试)?|改一?下|看(?:一?下)?(?:代码|文件))/i

/**
 * 检查文本尾部是否同时包含行动承诺和工具动词。
 * 只看尾部 600 字符——行动承诺（如果有）通常在回复结尾。
 */
export function hasActionIntent(text: string): boolean {
  if (!text) return false
  const tail = text.length > 600 ? text.slice(-600) : text
  return ACTION_PROMISE_PATTERN.test(tail) && TOOL_VERB_PATTERN.test(tail)
}
