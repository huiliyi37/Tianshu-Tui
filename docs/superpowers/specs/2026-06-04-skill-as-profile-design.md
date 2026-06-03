# Skill-as-Profile — 子代理技能封装架构设计

> 日期：2026-06-04
> 实现：`9637fcc`
> 状态：已实现（内置 8 profile + 用户自定义扩展机制）

---

## 1. 问题

子代理（worker）的工具集和 prompt 注入散落在 `dispatch.ts` 等多处硬编码中。新增一种 worker 角色需要改 3-4 个文件。同时，worker 的 system prompt 注入会破坏主 agent 的 exact-prefix cache（因为每个 worker 的 prompt 不同，prefix 字节就变了）。

## 2. 设计：ProfileRegistry 单一数据源

### 2.1 ProfileDefinition

```typescript
interface ProfileDefinition {
  name: string               // 唯一标识，对应 WorkerProfile enum
  role: AgentRole             // 'brain' | 'hands' | 'readonly'
  allowedTools: string[]      // 允许的工具列表
  expertisePrompt: string     // 教 worker 如何做它的 job
  defaultKind?: string        // 默认 WorkOrderKind
  defaultMaxTokens?: number   // 默认 token 预算
  builtIn?: boolean           // 是否内置 profile
}
```

### 2.2 AgentRole 决定调度路径

| Role | 调度路径 | 工具集 | 典型 profile |
|------|----------|--------|-------------|
| `readonly` | 只读探索 | READ_ONLY_TOOLS | code_scout, doc_scout, reviewer, architect, troubleshooter |
| `hands` | 可写执行 | WRITE_TOOLS | verifier, patcher |
| `brain` | 规划分发 | delegate_task, delegate_batch | planner |

工具集定义：
- `READ_ONLY_TOOLS`: read_file, read_section, glob, grep, diff, inspect_project, repo_map, repo_graph, related_tests
- `WRITE_TOOLS`: READ_ONLY_TOOLS + edit_file, write_file, bash, run_tests

### 2.3 内置 Profile（8 个）

| Profile | Role | 工具 | 用途 |
|---------|------|------|------|
| `code_scout` | readonly | READ_ONLY | 代码定位与追踪 |
| `doc_scout` | readonly | READ_ONLY | 文档搜索 |
| `planner` | brain | delegate_* | 任务分解与分发 |
| `reviewer` | readonly | READ_ONLY | 代码审查 |
| `verifier` | hands | WRITE | 测试运行与验证 |
| `patcher` | hands | WRITE | 代码编辑与补丁 |
| `architect` | readonly | READ_ONLY + lsp_* | 架构分析（依赖方向、耦合、分层违规） |
| `troubleshooter` | readonly | READ_ONLY | 根因诊断（5 步方法论） |

### 2.4 用户自定义扩展

用户在 `.rivet/agents/*.md` 放置 YAML frontmatter + Markdown body 文件：

```yaml
---
name: security-auditor
role: readonly
tools: ["read_file", "grep", "glob", "repo_graph"]
---

## Security Auditor Methodology

1. Check for hardcoded secrets...
2. Verify input validation...
```

解析规则：
- YAML 字段：`name`, `role`, `tools` (JSON array), `defaultKind`, `maxTokens`
- `tools` 使用 JSON array 语法（`["item1", "item2"]`）
- 不允许覆盖内置 profile（`builtIn: true` 的条目）
- body（`---` 后的内容）直接作为 `expertisePrompt`

### 2.5 Prefix Cache 安全

**关键设计**：worker 的 `expertisePrompt` 不注入主 agent 的 system prompt。

Worker 有独立的 session 和 cache。主 agent 调用 `delegate_task` 时，worker 的 system prompt 由 `expertisePrompt` 构建，与主 agent 的 prefix cache 完全隔离。这是 skill-as-profile 相比 prompt 注入方案的核心优势——"不注入主 prompt"就是保护 prefix cache。

---

## 3. 调用链

```
delegate_task / delegate_batch
  → ProfileRegistry.get(profileName)  // 获取 profile 定义
  → 根据 role 选择工具集
  → expertisePrompt 作为 worker 的 system prompt
  → worker 独立 session 执行
```

---

## 4. 测试覆盖

已有 17 个测试（`src/agent/__tests__/profile-registry.test.ts`），覆盖：

- 内置 profile 数量（8 个）
- role 映射（readonly/hands/brain）
- 只读 profile 列表
- 写入 profile 列表
- 禁止覆盖内置 profile
- 从目录加载自定义 profile
- YAML 解析（role 校验、tools 数组、maxTokens）
- 不存在目录的优雅降级
- 数组解析失败时的错误报告

测试覆盖充分。

---

## 5. 后续方向

| 方向 | 描述 | 优先级 |
|------|------|--------|
| 动态工具集 | profile 的工具集根据项目配置动态调整 | 低 |
| profile 继承 | 自定义 profile 可 extend 内置 profile | 中 |
| 运行时热加载 | 文件变化时自动 reload `.rivet/agents/` | 低 |
| profile 能力声明 | 声明式描述 profile 擅长的任务类型，自动路由 | 中 |
