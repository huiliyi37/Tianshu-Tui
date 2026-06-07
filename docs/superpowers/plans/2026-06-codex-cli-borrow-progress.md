# Codex CLI 安全借鉴 — 实施进度

> 基于 `2026-06-codex-cli-borrow.md` 的分析，本次会话完成了 P0 和 P1。
> 会话：天枢·天璇域 · 2026-06

---

## P0: DANGEROUS_BASH_PATTERNS + INJECTION_PATTERNS 强化 ✅

### 提交

`feat(security): harden DANGEROUS_BASH_PATTERNS + INJECTION_PATTERNS`

### 变更文件

| 文件 | 变更 |
|------|------|
| `src/agent/approval-risk.ts` | 新增 4 个危险命令模式 + 5 个注入模式 |
| `src/agent/__tests__/approval-risk.test.ts` | 13 个新测试用例 |

### 新增 DANGEROUS_BASH_PATTERNS（4 条）

| 模式 | 防护目标 |
|------|----------|
| `/\b(?:shutdown\|reboot\|halt\|poweroff)\b/` | 系统控制命令 — 阻断/关闭/重启 |
| `/\bnpm\s+(?:publish\|unpublish)\b/` | 不可逆的包注册表操作 |
| `/\bxargs\b.*\brm\b/` | 通过管道批量删除文件 |
| `/\bbase64\b[^\n]*\|\s*(?:sh\|bash\|zsh\|fish)\b/` | Base64 编码混淆执行 |

### 新增 INJECTION_PATTERNS（5 条）

| 模式 | 防护目标 |
|------|----------|
| `/\bsource\b.*\/etc\/\|^\.\s+\/etc\//` | 加载系统配置文件 |
| `/\benv\b.*\b(?:SHELL\|PATH\|HOME\|LD_PRELOAD\|DYLD_INSERT_LIBRARIES)=/` | 环境变量覆盖提权 |
| `/\b(?:python\|perl\|ruby\|node)\s+-[ec]\s/` | 解释器内联代码执行 |
| `/\bcrontab\b/` | Cron 持久化后门 |
| `/\bsystemctl\b.*\b(?:enable\|start\|stop\|restart\|mask)\b/` | Systemd 服务操控 |

### 修复

- **Force-push 检测 bug**：原实现通过 `DANGEROUS_BASH_PATTERNS[length-1]` 引用 force-push 模式，新模式追加后索引失效。改为使用独立常量 `FORCE_PUSH_PATTERN` 引用。

### 测试覆盖

100 个测试全部通过（原 87 + 新增 13）。

---

## P1: 会话元数据 + Rollout 记录 ✅

### 提交

`feat(session): add structured metadata + Rollout records`

### 变更文件

| 文件 | 变更 |
|------|------|
| `src/context/types.ts` | 扩展 `SessionMetadata` 接口 |
| `src/agent/session-persist.ts` | 新增 `initMetadata`、`updateMetadata`、`listSessionsWithMetadata` |
| `src/agent/loop.ts` | 在 mutation listener 中写入元数据 |
| `src/agent/__tests__/session-persist.test.ts` | 7 个新测试用例 |

### SessionMetadata 新增字段

```typescript
interface SessionMetadata {
  sessionId: string
  createdAt: number          // 首次创建时间
  updatedAt: number          // 最后变更时间
  compactEvents: CompactEvent[]
  lastLedger?: ContextLedger
  model?: string             // 主模型名称
  title?: string             // 首条用户消息（自动提取前 120 字符）
  status?: 'active' | 'completed' | 'archived'
  turnCount?: number         // 用户消息计数
  toolCallCount?: number     // 工具调用计数
  tokenUsage?: {
    prompt: number           // 输入 token（含 cache read + creation）
    completion: number       // 输出 token
    total: number            // 合计
  }
}
```

### 新增 API

| 方法 | 说明 |
|------|------|
| `initMetadata(init?)` | 幂等初始化：只在 `.meta.json` 不存在时创建，带默认值 |
| `updateMetadata(patch)` | 部分合并：不覆盖未提及的字段，`tokenUsage` 嵌套合并 |
| `listSessionsWithMetadata()` | 静态方法：返回所有会话的元数据，按 `updatedAt` 降序排列 |

### 数据流

```
loop.ts mutation listener
  ├─ user message → extract title (first 120 chars), increment turnCount
  ├─ assistant message with tool_calls → increment toolCallCount
  └─ every append → update tokenUsage from session.getTotalUsage()
```

### 元数据文件格式

存储在 `~/.rivet/sessions/{sessionId}.meta.json`，原子写入（`writeFileAtomicSync`）。

### 测试覆盖

22 个测试全部通过（原 15 + 新增 7），覆盖：init 默认值、幂等性、部分合并、tokenUsage 合并、createdAt 保留、undefined 处理、排序列表。

---

## P2: codex exec 等价物 — 待实施

参考 Codex CLI 的 `codex exec` 无头模式：
- `--ephemeral` 不持久化会话
- stdin 管道输入
- 纯文本输出（非 TUI）
- 适合 CI/CD 集成

---

## 与 Codex CLI 的对比（更新）

| 特性 | Codex CLI | 天枢（本次之前） | 天枢（本次之后） |
|------|-----------|----------------|----------------|
| 危险命令检测 | ExecPolicy + PermissionProfile | 基础 DANGEROUS_BASH_PATTERNS | 16 条模式 + 10 条注入模式 |
| 系统控制防护 | OS 级沙箱 | sudo 模式覆盖 | sudo + bare shutdown/reboot/halt |
| 混淆执行检测 | 沙箱隔离 | curl\|bash | +base64\|shell、+解释器内联 |
| 持久化后门检测 | 无 | 无 | +crontab、+systemctl |
| 会话元数据 | Rollout + ThreadStore | 仅 sessionId + updatedAt | +model/title/status/turn/token |
| 会话列表浏览 | ThreadsPage + Cursor | listSessions() 返回 ID | listSessionsWithMetadata() 排序浏览 |
