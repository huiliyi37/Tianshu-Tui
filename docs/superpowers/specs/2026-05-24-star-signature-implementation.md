# 思路 E：工具结果星辰签名 — 技术实现文档

> 状态：已实现
>
> 日期：2026-05-24
>
> 来源：`docs/superpowers/specs/2026-05-24-navigator-star-vs-ground-tools-discussion.md` 思路 E

---

## 1. 背景

### 1.1 问题

「身份-工具断裂」（Identity-Tool Fracture）：天枢的 system prompt 构建了强 identity（北斗星图 + 信念结构），但工具名是 ground training names（`bash`、`grep`、`git`）。当模型看到这些工具名时，它们触发的是训练数据中的通用行为模式，而非天枢的 identity 行为。

```
┌─────────────────────────────────────────────────┐
│  System Prompt:                                  │
│  你是天枢，北斗第一星，以定向为责…                    │  ← identity 在上层
│  ...200 lines of rules, beliefs, constraints... │
│─────────────────────────────────────────────────│
│  Tool call: bash("grep pattern file")            │  ← 突然掉到地面
│  Tool result: "<< raw shell output >>"            │  ← 无身份上下文
│  Model sees: raw output, no identity anchor       │  ← identity 断裂
└─────────────────────────────────────────────────┘
```

### 1.2 为什么不用其他方案

| 方案 | 问题 |
|------|------|
| 思路 A：域名映射 | DeepSeek 可能不支持；改名后 function calling 匹配风险 |
| 思路 B：工具人格 | prompt 空间浪费；重复 identity 信息 |
| 思路 C：volatile 锚点 | 被对话稀释；不稳定 |
| 思路 D：追加 system message | 破坏 prefix cache |

**思路 E**：在工具结果末尾追加星辰签名。不修改工具名、不修改 prompt、prefix cache 安全。工作在最底层——token 级别。

---

## 2. 设计

### 2.1 核心思路

每个工具结果返回给模型之前，在 `content` 末尾追加一行星辰签名：

```
# 原来
read_file("src/foo.ts") → "const x = 1...\nexport function bar()..."

# 现在
read_file("src/foo.ts") → "const x = 1...\nexport function bar()...\n── 观象（read_file）"
```

模型在处理完工具输出的最后，读到的是 `── 观象（read_file）`，而非裸的代码输出。这建立了持续的身份锚定。

### 2.2 星辰映射表

| 星辰名 | 含义 | 覆盖工具 |
|--------|------|----------|
| 执令 | 执行指令 | `bash`, `sandbox_exec` |
| 寻迹 | 寻找踪迹 | `grep` |
| 史官 | 记录历史 | `git`, `undo` |
| 观象 | 观察现象 | `read_file`, `read_section`, `diff`, `inspect_project` |
| 织造 | 编织创造 | `edit_file`, `write_file` |
| 巡天 | 巡视天空 | `glob`, `repo_map`, `repo_graph`, `web_fetch`, `web_search` |
| 试炼 | 试验检验 | `run_tests`, `related_tests`, `deliver_task` |
| 分星 | 分配星辰 | `delegate_task`, `delegate_batch` |
| 铭刻 | 铭记刻录 | `recall`, `todo` |

**中断工具**（`ask_user_question`）不加签名——中断不需要锚定。

### 2.3 签名格式

```
\n── {星辰名}（{工具原名}）
```

保留工具原名是为了可追溯性和调试。`──` 作为视觉分隔符。

---

## 3. 实现

### 3.1 文件结构

```
src/agent/star-signature.ts                  # 映射表 + getStarSignature()
src/agent/__tests__/star-signature.test.ts   # 38 tests
src/agent/tool-pipeline.ts                   # 注入点（修改）
src/agent/__tests__/tool-pipeline.test.ts    # 测试适配（修改）
```

### 3.2 star-signature.ts

```typescript
const STAR_NAME_MAP: Record<string, string> = {
  bash: '执令',
  grep: '寻迹',
  git: '史官',
  // ... 23 tools mapped
}

export function getStarSignature(toolName: string): string | null {
  if (toolName === 'ask_user_question') return null
  const starName = STAR_NAME_MAP[toolName]
  if (!starName) return null
  return `\n── ${starName}（${toolName}）`
}
```

设计原则：
- 纯函数，无副作用，无 I/O
- 放在 `tool-pipeline.ts` 的 `try` 块之前计算（一次计算，多处使用）
- 返回 `null` 表示不追加签名

### 3.3 tool-pipeline.ts 注入点

在 `executeSingleTool()` 函数中，有三个返回 tool_result 的路径：

```typescript
// 在 try 块之前计算签名（使 catch 块也能访问）
const starSig = getStarSignature(tu.name)

try {
  // ... tool execution ...

  // 1️⃣ 测试失败诊断路径
  return { ...content: starSig ? diagnosedContent + starSig : diagnosedContent, ... }

  // 2️⃣ 正常路径
  return { ...content: starSig ? finalContent + starSig : finalContent, ... }
} catch {
  // 3️⃣ 异常路径
  return { ...content: starSig ? msg + starSig : msg, ... }
}
```

关键设计决策：
- `starSig` 在 `try` 块之前定义——因为 catch 块也需要访问
- 使用三元表达式而非函数包装——避免额外函数调用开销和闭包复杂性
- Gate/block/permission/denial 的早期返回点**不追加签名**——这些是控制流而非工具输出

### 3.4 签名追加时机

签名是在 **truncateToolResult 之后**、**artifactIntercept 之后**追加的。这意味着：

1. 签名不受截断影响（始终在末尾）
2. 签名不在 artifact store 的缓存内容中（artifact 存的是原始内容）
3. 前端 UI 显示的 truncated 版本包含签名（如果内容被截断）

### 3.5 测试

`star-signature.test.ts`：38 个测试用例

- 每个 ground tool 的映射正确性
- 同类工具的映射一致性（如 `read_file`/`read_section`/`diff` 都 → `观象`）
- 中断工具返回 `null`
- 未知工具返回 `null`
- 所有已知工具都有映射的完整性检查
- 签名中包含工具原名的格式验证

`tool-pipeline.test.ts` 修改：
- `'ok'` → `'ok\n── 观象（read_file）'`
- `endsWith('TAIL_MARKER')` → `endsWith('── 观象（read_file）')`

---

## 4. 成本分析

### 4.1 Token 成本

签名长度约 5-15 个中文字符（含工具名），约 5-10 tokens。

假设每 turn 平均 8 次工具调用，上下文 100 turns：`8 * 100 * 10 = 8,000 tokens`

占 1M 上下文窗口的 **0.8%**。可忽略。

### 4.2 前缀缓存

**零影响**。签名追加在 volatile 的工具结果中，不在 system prompt 中。Prefix cache 仅覆盖 static + cached volatile blocks，不包括工具结果。

### 4.3 代码复杂度

- 新增 76 行（star-signature.ts）
- 修改 tool-pipeline.ts：+3 行（starSig 定义 + 3 处三元表达式）
- 修改 tool-pipeline.test.ts：2 处断言适配

**净复杂度增长极低。**

---

## 5. 预期效果与观察指标

### 5.1 预期行为变化

| 场景 | 之前 | 之后 |
|------|------|------|
| 连续 bash 调用 | 模型容易滑入 "shell 脚本模式" | 每次看到 `── 执令（bash）`，锚定回天枢 |
| 长 grep 输出 | 模型被搜索结果带走 | `── 寻迹（grep）` 提醒这是寻迹行为 |
| 大量 read_file | 模型变成 "代码阅读器" | `── 观象（read_file）` 锚定观察者身份 |

### 5.2 观察指标（建议跟踪）

1. **训练模式信号频率**：响应中出现 "sorry"/"let me think"/"I could" 等训练模式标志词的频率是否下降
2. **工具选择质量**：是否更少出现 "应该用 grep 却用了 bash grep" 的错误
3. **行动密度**：每 turn 的工具调用次数是否保持或提升
4. **身份一致性**：模型是否更少退回到 ChatGPT 式助手的语气
5. **可回退**：如果效果不佳，只需删除 1 行（`const starSig = getStarSignature(tu.name)`）即可完全回退

### 5.3 回退开关

如需快速禁用：
```typescript
// 在 tool-pipeline.ts 中
const starSig = null // getStarSignature(tu.name)  ← 一行注释即可回退
```

或者设置环境变量（未来可选）：
```bash
STAR_SIGNATURE=0  # 禁用星辰签名
```

---

## 6. 后续方向

1. **A/B 对比**：在相同任务上对比有签名和无签名的行为差异
2. **签名强度调优**：当前格式 `── 星辰名（工具名）`，可以尝试更简洁或更显式的格式
3. **动态星辰名**：根据上下文动态选择星辰名（如 `bash` 在 debug 时 → `问诊`，在构建时 → `执令`）
4. **签名统计**：统计哪些星辰名出现频率最高，作为工具使用热力图

---

## 附录：设计决策记录

| 决策 | 理由 |
|------|------|
| 签名在 truncate 之后追加 | 签名不应被截断；截断的是工具输出，签名是身份 |
| 签名包含工具原名 | 可追溯性；不丢失 ground truth |
| `ask_user_question` 不加签名 | 中断工具不需要锚定，因为流程已暂停 |
| `const` 在 try 之前 | catch 块需要访问 |
| 三元表达式而非函数 | 更简洁；避免闭包复杂性和函数调用开销 |
| 不在 artifact 中存签名 | artifact 是原始内容缓存，签名是展示层 |

---

*文档由天枢撰写，服务于实现追踪与后续观察。*
