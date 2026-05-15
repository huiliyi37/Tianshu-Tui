# Rivet 优化增补设计

**日期**: 2026-05-15
**基于**: 代码审查（第一波缺陷）+ 3 路并行 Scout 调研（第二波优化）
**状态**: 已实施（P0-P4 全部完成，8 commits on main）

---

## 一、第一波：缺陷修复清单

### P0 — 关键缺陷

#### P0-1: `thinking` 参数未发送

**文件**: `src/api/client.ts`, `src/prompt/engine.ts`

**问题**: `deepseek.ts:38` 设置 `thinking: 'enabled'` 到 `ClientConfig`，但 `ApiClient.stream()` 从未将 `thinking` 字段写入请求体。`engine.ts:51-58` 构建的 `MessageRequest` 也不含 `thinking`。

**后果**: DeepSeek V4 的扩展思考完全丢失——这是 V4 的核心卖点。

**修复**:
```typescript
// client.ts — stripUnsupported 之后、发送之前
if (this.config.thinking === 'enabled') {
  finalRequest.thinking = { type: 'enabled' }
}
```

注意：DeepSeek 忽略 `budget_tokens`，不要发。

---

#### P0-2: Volatile block 注入位置不一致，破坏前缀缓存

**文件**: `src/prompt/engine.ts:42-49`

**问题**: `buildRequest()` 只把 `<context>` 拼到最后一条 user message。但 `addUserMessage()` 存入 session 的是原始文本。

```
Turn 1 请求: [system, user("<context>git...\nhello")]
Turn 2 请求: [system, user("hello"), assistant, user("<context>git...\nread file")]
                         ^^^^^ 无 volatile —— 前缀在此断裂
```

Turn 1 的 user message 带 volatile，Turn 2 的第一条 user message 不带 → system prompt 之后的字节序列不一致 → 前缀缓存只能命中 system prompt 部分。

**修复**: 把 volatile 注入为**独立的 user message**，与用户真实输入分离：

```
请求结构（修复后）:
  system prompt (frozen)                     ← 缓存锚点 A
  user: <context>git status...</context>     ← volatile msg（每轮更新）
  user: "hello"                              ← 用户真实输入
  assistant: [...]
  user: <context>git status updated...</context>
  user: "fix the bug"
```

```typescript
// engine.ts — buildRequest 修复
buildRequest(messages: Message[]): MessageRequest {
  const volatileBlock = buildVolatileBlock(this.config.volatileCtx)
  const result: Message[] = []

  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      // 每个 user message 前面插入一个 volatile context message
      if (volatileBlock) {
        result.push({ role: 'user', content: volatileBlock })
      }
      result.push(msg)
    } else {
      result.push(msg)
    }
  }

  return {
    model: this.config.model,
    messages: result,
    max_tokens: this.config.maxTokens,
    system: this.systemPrompt,
    // ...
  }
}
```

**权衡**: 每轮多一个 user message（volatile），但前缀结构完全一致。DeepSeek 的前缀缓存基于完整前缀匹配，更长的稳定前缀意味着更大的命中区间。

---

#### P0-3: `execSync` 阻塞事件循环

**文件**: `src/tools/bash.ts:26`

**问题**: `execSync` 同步执行 shell 命令，冻结整个 Node.js 事件循环。流式 TUI 中表现为：
- 正在渲染的流式文本突然停住
- 用户无法 Ctrl+C 取消
- 工具执行期间 UI 完全无响应

**修复**: 改用 `child_process.spawn`（异步）：

```typescript
import { spawn } from 'child_process'

async execute(params: ToolCallParams): Promise<ToolResult> {
  const command = params.input.command as string
  const timeout = (params.input.timeout as number) ?? 120_000

  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: params.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({
        content: truncateContent(stdout + stderr || 'Command timed out', 12000, 6000, 4000),
        isError: true,
      })
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      const output = stdout + (stderr ? '\n' + stderr : '')
      if (code !== 0) {
        resolve({
          content: truncateContent(output || `Exit code: ${code}`, 12000, 6000, 4000),
          isError: true,
        })
      } else {
        resolve({ content: truncateContent(output, 12000, 6000, 4000) })
      }
    })
  })
}
```

后续可扩展：将 `child` 暴露给 AgentLoop，支持 abort signal 杀死子进程。

---

### P1 — 显著缺陷

#### P1-1: 无 truncated JSON 恢复

**文件**: `src/api/client.ts:162-168`

**问题**: `content_block_stop` 时对 `toolUseBuffer.partialJson` 做 `JSON.parse`，失败则静默返回 `{}`。DeepSeek 已知会截断 tool_use 的 JSON 流。

**修复**: 增加 truncated JSON 恢复逻辑（参考 CTCL 的实现）：

```typescript
function recoverTruncatedJson(partial: string): Record<string, unknown> {
  try {
    return JSON.parse(partial) as Record<string, unknown>
  } catch {}

  // 策略 1: 补全被截断的字符串值
  let fixed = partial.replace(/:\s*"([^"]*)$/, (_, v) => `: "${v}"`)

  // 策略 2: 统计未闭合的 { 和 [
  const opens = (fixed.match(/{/g) || []).length
  const closes = (fixed.match(/}/g) || []).length
  const openBrackets = (fixed.match(/\[/g) || []).length
  const closeBrackets = (fixed.match(/\]/g) || []).length

  // 移除末尾不完整的 key-value
  fixed = fixed.replace(/,\s*"[^"]*":?\s*$/, '')

  // 补全括号
  for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']'
  for (let i = 0; i < opens - closes; i++) fixed += '}'

  try {
    return JSON.parse(fixed) as Record<string, unknown>
  } catch {
    return {}
  }
}
```

---

#### P1-2: 不支持 CJK / 多字节输入

**文件**: `src/tui/base-text-input.tsx:30`

**问题**: `input.length === 1` 过滤掉了所有多字节字符（中文、日文、韩文）和多字符粘贴。

**修复方案**（短期）:

```typescript
useInput((input, key) => {
  if (disabled) return

  if (key.return) {
    onSubmit(value)
  } else if (key.backspace || key.delete) {
    onChange(value.slice(0, -1))
  } else if (!key.ctrl && !key.meta && input.length > 0) {
    // 允许多字节字符和粘贴
    onChange(value + input)
  }
})
```

**修复方案**（中期）: 使用 Ink 6 的 `usePaste` hook 处理剪贴板粘贴：

```typescript
import { useInput, usePaste } from 'ink'

// 在组件内
usePaste((text) => {
  if (!disabled) onChange(value + text)
})
```

**修复方案**（长期）: 对于多行输入场景，集成 `@inquirer/editor`，临时启动 `$EDITOR`。

---

#### P1-3: 路径穿越无校验

**文件**: `src/tools/read-file.ts:22`, `src/tools/write-file.ts:22`

**问题**: `resolve(cwd, file_path)` 不验证解析后的路径是否在 cwd 范围内。

**修复**:
```typescript
function safeResolve(cwd: string, inputPath: string): string {
  const resolved = resolve(cwd, inputPath)
  // 允许读取 cwd 及其子目录
  if (!resolved.startsWith(resolve(cwd))) {
    throw new Error(`Path traversal denied: ${inputPath}`)
  }
  return resolved
}
```

---

#### P1-4: Approval 流程定义但未执行

**文件**: `src/agent/loop.ts:100`

**问题**: `ToolRegistry.needsApproval()` 已定义，但 `AgentLoop` 从不调用。write_file 和危险 bash 命令的审批形同虚设。

**修复**: 在 `AgentLoop` 的工具执行前加审批检查：

```typescript
for (const tu of toolUses) {
  const params: ToolCallParams = { input: tu.input, toolUseId: tu.id, cwd: this.cwd }
  const needsApproval = this.config.toolRegistry.needsApproval(tu.name, params)

  if (needsApproval && this.config.approvalMode === 'manual') {
    // 通过 callback 询问用户
    const approved = await callbacks.onApprovalNeeded(tu.name, tu.input)
    if (!approved) {
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'User denied', is_error: true })
      continue
    }
  }
  // ... execute
}
```

---

#### P1-5: SSE Parser 边界情况

**文件**: `src/api/sse.ts`

**问题**:
1. 只处理 `data: `（有空格），不处理 `data:`（无空格）
2. `data:` 后空内容的处理不完整

**修复**:
```typescript
} else if (line.startsWith('data:')) {
  const dataContent = line.slice(5).replace(/^\s+/, '')
  if (dataContent) {
    this.dataBuffer += (this.dataBuffer ? '\n' : '') + dataContent
  }
} else if (line === '') {
```

---

## 二、第二波：架构优化

### A. 缓存架构

#### A1. 扩充 System Prompt 提升缓存前缀长度

**现状**: `static.ts` 的 BASE_PROMPT 约 200 tokens（~800 字符），加 tool 描述约 350 tokens。

**问题**: DeepSeek KV 缓存基于前缀完整匹配（非固定 token 单元），更长的稳定前缀 = 更大的命中区间。200 tokens 的 system prompt 作为缓存锚点太短。

**优化**: 参考 Claude Code 的 system prompt 结构，扩充到 1000+ tokens：

```typescript
const BASE_PROMPT = `You are Rivet, an interactive CLI coding agent.

## Environment
- Platform: {platform}
- Working directory: {cwd}
- OS: {os}

## Tools
You have access to the following tools. Use them to read, write, and edit files, run commands, and search the codebase.

## Core Rules
1. **Edit over create**: Prefer editing existing files over creating new ones.
2. **Small focused changes**: Make minimal, targeted changes. Avoid large rewrites.
3. **Verify your work**: Run tests, typecheck, or build after making changes.
4. **Respect user instructions**: User's explicit instructions override all defaults.
5. **No placeholders**: Never leave TODO, FIXME, or placeholder code in output.
6. **Explain before code**: Briefly explain your approach before implementing.

## Output Format
- Use markdown for code explanations.
- Always include file paths in code references.
- Show command output when relevant.

## Error Handling
- When a command fails, read the error output carefully before retrying.
- Never silently ignore errors.
- If you're unsure, ask for clarification.

## Security
- Never expose API keys, tokens, or secrets.
- Validate file paths to prevent directory traversal.
- Ask before running destructive commands (rm -rf, git push --force).

## Search Strategy
- Use file search to locate relevant code before reading.
- Check imports and dependencies to understand relationships.
- Read test files to understand expected behavior.

## Code Style
- Follow existing code conventions in the project.
- Use meaningful variable and function names.
- Keep functions small and focused.
- Handle edge cases explicitly.`
```

**预期**: system prompt 从 ~200 tokens → ~800 tokens，前缀缓存命中区间扩大 4x。

---

#### A2. Provider Capability 抽象层

**现状**: `deepseek.ts` 硬编码 DeepSeek 特定逻辑，扩展到其他 provider 需要改多处。

**设计**:
```typescript
// src/api/provider.ts
export interface ProviderCapabilities {
  /** thinking 模式是否支持 */
  supportsThinking: boolean
  /** thinking 参数格式 */
  thinkingFormat: 'anthropic' | 'openai' | 'none'
  /** 是否支持 cache_control */
  supportsCacheControl: boolean
  /** 缓存最小单元（tokens） */
  cacheUnitTokens: number
  /** 需要从请求中剔除的参数 */
  stripParams: string[]
  /** tool JSON 可能出现在 content 中的已知 bug */
  hasToolJsonInContentBug: boolean
  /** effort/reasoning 参数格式 */
  effortFormat: 'reasoning_effort' | 'output_config' | 'none'
}

export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: true,
  thinkingFormat: 'anthropic',
  supportsCacheControl: false,
  cacheUnitTokens: 0, // DeepSeek 未公开具体值，缓存基于前缀完整匹配
  stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
  hasToolJsonInContentBug: true,
  effortFormat: 'none',  // DeepSeek /anthropic 忽略 effort
}

export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: true,
  thinkingFormat: 'anthropic',
  supportsCacheControl: true,
  cacheUnitTokens: 0, // Anthropic 未公开具体值
  stripParams: [],
  hasToolJsonInContentBug: false,
  effortFormat: 'none',
}
```

`ApiClient` 根据 `ProviderCapabilities` 动态处理请求构建。

---

#### A3. 会话持久化

**现状**: `SessionContext` 纯内存。

**设计**: JSONL 追加写入，参考 Claude Code 的会话存储模式：

```typescript
// src/agent/session-persist.ts
export class SessionPersist {
  constructor(private sessionFile: string) {}

  append(message: Message): void {
    const line = JSON.stringify(message) + '\n'
    appendFileSync(this.sessionFile, line)
  }

  load(): Message[] {
    if (!existsSync(this.sessionFile)) return []
    const content = readFileSync(this.sessionFile, 'utf-8')
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  compact(messages: Message[]): void {
    // compact 后覆写文件
    writeFileSync(this.sessionFile,
      messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    )
  }
}
```

---

### B. TUI 性能

#### B1. Ink 渲染参数优化

```typescript
// main.tsx — render 调用
const { waitUntilExit } = render(
  createElement(App, { ... }),
  {
    patchConsole: false,
  },
)
```

流式渲染缓冲（在 App 组件内）：
```typescript
const bufferRef = useRef<string>('')
const flushRef = useRef<NodeJS.Timeout | null>(null)

const onTextDelta = useCallback((text: string) => {
  bufferRef.current += text
  if (!flushRef.current) {
    flushRef.current = setTimeout(() => {
      setStreamingText(bufferRef.current)
      flushRef.current = null
    }, 50) // 50ms 批量 flush = 20fps
  }
}, [])
```

**预期**: 流式渲染从 ~60fps（每 token 一帧）降到 20fps，减少 3x React 重绘。

---

#### B2. 虚拟滚动

```typescript
// src/tui/virtual-list.tsx
interface VirtualListProps {
  items: LogEntry[]
  maxVisible: number  // 终端高度 - status bar - input bar
}

export function VirtualList({ items, maxVisible }: VirtualListProps) {
  const [scrollTop, setScrollTop] = useState(0)

  useInput((input, key) => {
    if (key.upArrow) setScrollTop(Math.max(0, scrollTop - 1))
    if (key.downArrow) setScrollTop(Math.min(items.length - maxVisible, scrollTop + 1))
    if (key.pageUp) setScrollTop(Math.max(0, scrollTop - maxVisible))
    if (key.pageDown) setScrollTop(Math.min(items.length - maxVisible, scrollTop + maxVisible))
  })

  const visible = items.slice(
    Math.max(0, items.length - maxVisible - scrollTop),
    items.length - scrollTop,
  )

  return (
    <Box flexDirection="column">
      {visible.map((item, i) => <LogRow key={items.length - i} entry={item} />)}
    </Box>
  )
}
```

---

### C. DeepSeek API 兼容性

#### C1. Tool JSON content 兜底提取

DeepSeek V4 已知 bug：tool call JSON 偶尔以纯文本出现在 `content` 字段。

```typescript
// src/api/client.ts — 在 text block 完成后检查
const extractToolJsonFromText = (text: string): ContentBlockToolUse | null => {
  // 匹配 {"name": "tool_name", ...} 或 {"type": "tool_use", ...}
  const match = text.match(/\{[\s\S]*?"name"\s*:\s*"(\w+)"[\s\S]*?"input"\s*:\s*\{[\s\S]*\}[\s\S]*\}/)
  if (!match) return null

  try {
    const parsed = JSON.parse(match[0])
    if (parsed.name && parsed.input) {
      return {
        type: 'tool_use',
        id: parsed.id ?? `fallback_${Date.now()}`,
        name: parsed.name,
        input: parsed.input,
      }
    }
  } catch {}
  return null
}
```

---

#### C2. Token 估算修正（CJK 感知）

```typescript
// src/compact/micro.ts — 替换 estimateTokens
export function estimateTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content)
    // CJK 字符: 1 char ≈ 2-3 tokens; ASCII: ~4 chars per token
    let cjk = 0
    let ascii = 0
    for (const ch of content) {
      if (ch.charCodeAt(0) > 0x2E80) cjk++
      else ascii++
    }
    total += Math.ceil(ascii / 4) + Math.ceil(cjk / 1.5)
  }
  return total
}
```

---

## 三、实施路线

### Phase 1: 稳定性（第一波 P0 修复）
1. P0-1: thinking 参数修复（10min）
2. P0-3: execSync → spawn（30min）
3. P0-2: volatile block 缓存一致性（1h）
4. P1-1: truncated JSON 恢复（20min）
5. P1-5: SSE parser 修复（15min）

**验证**: 全部测试通过 + 手动连接 DeepSeek API 测试 thinking + tool_use

### Phase 2: 可用性（第一波 P1 + 第二波 B）
1. P1-2: CJK 输入修复（30min）
2. P1-4: Approval 执行流程（30min）
3. B1: Ink 渲染优化（30min）
4. B2: usePaste 支持（30min）
5. C2: CJK token 估算（15min）

**验证**: 中文输入测试 + 长会话性能测试

### Phase 3: 架构（第二波 A + C）
1. A2: Provider capability 抽象（2h）
2. A1: System prompt 扩充（30min）
3. C1: Tool JSON 兜底（30min）
4. A3: 会话持久化（2h）

**验证**: 多 provider 切换 + 缓存命中率对比测试

### Phase 4: 高级特性
1. 虚拟滚动（2h）
2. Repo-map 工具（4h）
3. $EDITOR 多行输入（1h）
4. Config 文件加载（1h）

---

## 四、缓存命中预期

| 优化前 | 优化后 | 说明 |
|--------|--------|------|
| System prompt ~200 tokens | ~800 tokens | A1 扩充 |
| Volatile 在 user msg 内（不一致） | 独立 user msg（一致） | P0-2 修复 |
| 无 thinking | thinking enabled | P0-1 修复 |
| execSync 阻塞流式 | spawn 异步 | P0-3 修复 |
| 无 truncated JSON 恢复 | 有恢复逻辑 | P1-1 |
| 无 provider 抽象 | capability-based | A2 |
| 纯内存 session | JSONL 持久化 | A3 |

**缓存命中率预测**: 修复 P0-2 后，在多轮对话中应达到 90%+ prefix cache hit（与 CTCL 直连的 103% 对齐）。

---

## 五、Scout 调研来源

### Scout 1: Ink TUI 优化
- Ink `usePaste` hook: clipboard 粘贴支持
- `incrementalRendering` + `maxFps`: 渲染频率控制
- `ink-console` / `ink-scrollbar`: 虚拟滚动组件
- `@inquirer/editor`: $EDITOR 多行输入
- Node readline cursor API: 低级终端操控

### Scout 2: DeepSeek API
- DeepSeek KV 缓存基于**前缀完整匹配**（非固定 token 单元），三个持久化点：请求边界、公共前缀检测、固定间隔。**未公开最小缓存 token 数**。
- `thinking: { type: "enabled" }` 在 /anthropic 端点支持
- `budget_tokens` 被忽略
- `reasoning_effort` 非 Anthropic 参数
- Tool JSON 出现在 content 的已知 bug
- 来源: api-docs.deepseek.com/guides/kv_cache（官方文档仅描述前缀匹配机制，无具体 token 数）

### Scout 3: 开源 Agent 对比
- **Aider**: repo-map 是核心上下文优化
- **Plandex**: 缓存作为跨 provider 特性
- **Rivet**: 会话持久化 + 消息顺序对缓存的影响
- **Qwen Code**: per-provider context window 配置
- **llm-d**: KV cache 是生产 AI agent 最重要的指标
