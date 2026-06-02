# 天枢 2026-06-03 会话开发记录

> 跨维度借鉴：Claude Code · Gemini CLI · Codex CLI · oh-my-pi
> 会话产出：11 个逻辑提交，~400 行新增

## 已完成功能

### 一、Claude Code 借鉴

| 功能 | 描述 | 提交 |
|------|------|------|
| LSP changeFile 通知 | edit_file/write_file/apply_patch 后通知 typescript-language-server 文件已变更 | `1511888` |
| LSP 管线集成 | LspManager 通过 AgentConfig → ToolPipelineDeps 传递，实现 changeFile 自动调用 | `f4072a6` |
| edit_file OOM 守卫 | 拒绝编辑 >100KB 的文件，引导使用 apply_patch 或 sed | `ba296be` |
| write_file OOM 守卫 | 拒绝写入 >10MB 的内容，引导使用 bash heredoc | `ba296be` |

### 二、流式工具执行器 (L0 遥测)

| 功能 | 描述 | 提交 |
|------|------|------|
| L0 遥测 | stream + tools 时序写入 sensorium.jsonl，每 turn 记录 streamDurationMs / toolsDurationMs / totalTurnMs | `a62e981` |
| 遥测结论 | 工具执行 <300ms，API 延迟 4.5-127s。流式执行 ROI 太低，不建议继续 L1-L3 | — |

### 三、Gemini CLI 借鉴 (P0)

| 功能 | 描述 | 提交 |
|------|------|------|
| 动态窗口标题 | 根据 agent 状态设置 process.title：⏳/🔧/⚠️ + 项目名 | `64834a2` |
| 慢渲染监控 | 200ms 间隔检测事件循环阻塞，输出到 stderr | `64834a2` |

### 四、Codex CLI 借鉴 (P0)

| 功能 | 描述 | 提交 |
|------|------|------|
| bash 命令白名单 | `agent.permissions.bash.allowlist` 配置，前缀匹配的命令绕过 bash-write 审批 | `df3ed71` |
| PermissionConfig 流线 | 从 Zod schema → createAgentConfig → AgentConfig → tool-pipeline 完整连线 | `df3ed71` |

### 五、oh-my-pi 借鉴

| 功能 | 描述 | 提交 |
|------|------|------|
| **hash_edit** | 按内容哈希编辑文件。锚点 `L5:a1b2c3d4` 格式，1-3 个锚点定义替换范围，SHA256 截 8 位 hex | `11954dc` |
| **时间旅行流规则** | 正则匹配累积流文本 → 中止流 → 注入提醒 → 重试。零上下文税 | `e1e314d` |
| edit_file → hash_edit 温跃层 | old_string 未找到时自动建议 hash_edit 锚点 | `d5e2467` |
| edit_file 过期检测 | 利用 read_file 的 fileReadHistory，mtime 不匹配时拒绝编辑 | `4ad1a1f` |

## 写安全体系总览

经过本轮完善，天枢的写管线现在有完整的纵深防御：

```
                      ┌────────────────────────┐
                      │    Pre-Execution        │
                      ├────────────────────────┤
  edit_file ──────────┤  OOM guard (100KB)     │
  write_file ─────────┤  OOM guard (10MB)      │
  bash ───────────────┤  Dangerous patterns    │
  edit_file ──────────┤  Stale mtime detection │
  hash_edit ──────────┤  Anchor hash verification│
  bash ───────────────┤  Command allowlist     │
                      ├────────────────────────┤
                      │    Post-Failure         │
                      ├────────────────────────┤
  edit_file ──────────┤  → hash_edit hint      │
  edit_file ──────────┤  → closest match diff  │
  hash_edit ──────────┤  → stale anchor report │
                      └────────────────────────┘
```

## 未完成事项

### P0（高价值，低工作量）

| 功能 | 来源 | 状态 |
|------|------|------|
| `codex exec` 等价物 | Codex CLI | 未开始 |
| AST 编辑 (ast_edit) | omp | 未开始 — 需要 tree-sitter 集成 |
| 预览-接受模式 | omp | 未开始 — apply_patch --check 部分覆盖 |

### P1（中等价值）

| 功能 | 来源 | 状态 |
|------|------|------|
| 按键优先级系统 | Gemini CLI | 未开始 — 解决 Option+Backspace 等冲突 |
| CoreToolCallStatus 扩展 | Gemini CLI | 未开始 — 7 态细粒度状态机 |
| Session Browser + 元数据 | Codex CLI / Gemini CLI | 未开始 — SessionPersist.meta.json 已有基础 |
| 基本沙箱 | Codex CLI | 未开始 — macOS Seatbelt / Landlock |
| Kitty Keyboard Protocol | Gemini CLI | 未开始 — 只影响少数终端 |

### P2（高工作量，中等价值）

| 功能 | 来源 | 状态 |
|------|------|------|
| Alternate Buffer + Mouse | Gemini CLI | 未开始 |
| Skills 系统 | Codex CLI | 未开始 |
| 网络代理 | Codex CLI | 未开始 |
| 用户自定义 Hooks | Codex CLI | 未开始 |

### P3（低优先级）

| 功能 | 来源 | 状态 |
|------|------|------|
| 实时音频 (Realtime API) | Codex CLI | 未开始 |
| 溢出检测 | Gemini CLI | 未开始 — artifact 系统已部分解决 |

### L0 遥测 → 决定不继续

| 功能 | 原因 |
|------|------|
| 流式工具执行 (L1-L3) | 工具执行 <300ms，节省太低 |
| 推测性读 (L1) | 只读工具本身已几乎即时 |
| worktree 沙箱 + 后悔窗 (L2) | 工程量大，当前 auto-safe 模式足够 |

## 关键设计原则（天府域守护）

1. **小改动 > 大架构**：hash_edit 170 行，TTSR 54 行，edit_file 温跃层 30 行。每次改动独立测试、独立提交、独立回滚。
2. **遥测先行**：L0 数据否定了 L1-L3 流式执行的价值，避免了数周的工程投入。
3. **温跃层连接硬线**：不是让模型选择工具，而是在失败边界上引导。`edit_file` 失败 → 自动建议 `hash_edit` 锚点。
4. **纵深防御**：写管线的每个入口都有独立的安全检查。不依赖单一机制。
