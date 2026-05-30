# P1 三件套实现记录：Plan Mode / Bash 安全 / Agent 外部化

> 日期：2026-05-31
> 基线：commit 2891770（计划文档）→ e45b0cd（全部完成）
> 变更：21 files, +723 / -25 lines, 11 commits
> 测试：148 tests pass, 0 fail, tsc clean

---

## 一、功能概述

参照 `docs/superpowers/specs/2026-05-26-claude-code-feature-gap-analysis.md` 中标注的 P1 差异，按优先级实现了三个独立功能：

### Phase A: Plan Mode（只读探索→审批→执行）

| 组件 | 文件 | 说明 |
|------|------|------|
| 状态机 | `src/agent/plan-mode.ts` | `PlanModeState = 'off' \| 'planning' \| 'approved'`，`checkPlanMode()` 拦截写入工具 |
| 工具拦截门 | `src/agent/tool-pipeline.ts` | doom-loop 检查后、approval gate 前插入 plan-mode gate |
| 状态管理 | `src/agent/loop.ts` | AgentLoop 持有 `planModeState`，每轮 sync 到 config + promptEngine |
| Prompt 注入 | `src/prompt/volatile.ts`, `src/prompt/engine.ts` | planning 状态时注入 `<plan-mode>` volatile 块 |
| TUI 命令 | `src/tui/slash-commands.ts` | `/plan-mode` 进入、`/plan-approve` 退出 |

**允许的工具（planning 状态）：** read_file, read_section, grep, glob, repo_map, repo_graph, inspect_project, related_tests, diff, todo, plan_close, deliver_task, delegate_batch, deliver_task, web_fetch, web_search, recall

### Phase B: Bash 安全补强

| 组件 | 文件 | 说明 |
|------|------|------|
| 注入检测 | `src/agent/approval-risk.ts` | `INJECTION_PATTERNS` — 进程替换 `>()`, zsh zmodload/sysopen, PowerShell -enc |
| 扩展破坏性 | 同上 | `DESTRUCTIVE_EXTENDED_PATTERNS` — docker rm/prune, kubectl delete, truncate -s 0, dd→device, mkfs |
| Sed 绕过 | 同上 | `SED_BYPASS_PATTERNS` — sed 修改 /etc/passwd, .ssh/authorized_keys 等安全关键文件 |
| 环境清洗 | `src/tools/bash.ts` | `sanitizeEnv()` — 保留 PATH/HOME/TERM 等 20 个安全前缀，剥离含 KEY/TOKEN/SECRET/AUTH 等关键词的变量 |

### Phase C: Agent 定义外部化

| 组件 | 文件 | 说明 |
|------|------|------|
| Registry 核心 | `src/agent/profile-registry.ts` | `ProfileDefinition` 接口 + `ProfileRegistry` 类 + 全局 `profileRegistry` 单例 |
| 外部加载 | 同上 | `loadFromDirectory('.rivet/agents/')` 解析 YAML frontmatter + Markdown body |
| 统一入口 | 6 个消费方改用 registry | coordination-policy, worker-prompts, work-order, coordinator, dispatcher-hook, main.tsx |

**内置 6 个 profile：** code_scout, doc_scout, planner, reviewer, verifier, patcher（与原硬编码完全一致）

**用户自定义示例（`.rivet/agents/security-auditor.md`）：**
```markdown
---
name: security_auditor
role: readonly
tools: ["read_file","grep","glob"]
---
You audit code for security vulnerabilities.
```

---

## 二、架构决策

### Plan Mode 为什么在 tool-pipeline 插入而不是 agent loop

tool-pipeline 已有 5 个 pre-gate（cerebellar、PreToolUse hook、repair、reliability、doom-loop），plan-mode gate 作为第 6 个插入，复用相同的 early-return 模式。如果在 loop 层面拦截，需要重写工具分发逻辑；在 pipeline 层面拦截，只需一个 `if (!allowed) return` 并复用 `PlanModeResult` 类型。

### ProfileRegistry 为什么是全局单例而不是依赖注入

6 个消费方分布在 `coordination-policy.ts`、`worker-prompts.ts`、`work-order.ts`、`coordinator.ts`、`dispatcher-hook.ts`、`main.tsx`，其中有些是纯函数（classifyProfile、inferWorkerProfile），没有 class 实例可以注入。全局单例最简单，且 `.rivet/agents/` 目录在进程生命周期内不变。

### sanitizeEnv 的白名单策略

采用"安全前缀 + 敏感关键词"双重过滤：变量名以安全前缀（PATH/HOME/NODE_ENV 等）开头且不含敏感关键词（KEY/TOKEN/SECRET 等）才保留。这确保 `GITHUB_TOKEN`、`OPENAI_API_KEY` 等被剥离，而 `PATH`、`HOME`、`LANG` 等正常传递。

---

## 三、Commit 历史

| Commit | 类型 | 说明 |
|--------|------|------|
| `2891770` | docs | P1 三件套实现计划 |
| `ab63109` | feat | plan-mode 类型/状态机 + 测试（5 tests） |
| `d94ab1f` | feat | tool-pipeline 插入 plan-mode gate |
| `0e52781` | feat | AgentLoop 持有 plan-mode + volatile prompt 注入 |
| `b85c481` | feat | /plan-mode /plan-approve slash commands |
| `2d9ee66` | feat | injection/destructive-extended/sed-bypass 模式检测 |
| `51a49aa` | test | 上述模式的测试（13 new tests） |
| `eb9ba3d` | feat | bash env sanitize + 测试（6 new tests） |
| `0a4262d` | feat | ProfileRegistry + .rivet/agents/ 加载（13 tests） |
| `821636d` | refactor | classifyProfile 统一到 registry |
| `3dbcd93` | refactor | worker-prompts 统一到 registry |
| `e45b0cd` | refactor | work-order/coordinator/dispatcher/main 统一到 registry |

---

## 四、测试覆盖

| 测试文件 | 新增测试数 | 覆盖范围 |
|----------|-----------|----------|
| `src/agent/__tests__/plan-mode.test.ts` | 5 | off/approved/planning 三态 × 允许/阻止工具 |
| `src/agent/__tests__/approval-risk.test.ts` | 13 | 注入4 + 扩展破坏性6 + sed绕过3 |
| `src/tools/__tests__/bash.test.ts` | 6 | sanitizeEnv 剥离/保留/前缀匹配 |
| `src/agent/__tests__/profile-registry.test.ts` | 13 | 6内置profile + 覆盖拒绝 + 自定义加载 + 错误处理 |

**回归验证：** coordinator(15), work-order(16), coordination-policy(6), worker-prompts(10), dispatcher-hook(7) 全部通过。

---

## 五、使用方式

### Plan Mode

```
/plan-mode          # 进入只读探索模式
... 探索代码、理解架构 ...
/plan-approve       # 用户审批，退出 plan mode
```

### Bash 安全

自动生效。`assessToolRisk()` 现在额外检测 19 个新模式，风险等级 high/medium 自动对应。

### Agent 外部化

1. 内置 profile 无需配置，自动生效
2. 创建 `.rivet/agents/my-agent.md` 添加自定义 profile（下次启动加载）
3. 内置 profile 不可被覆盖（返回错误）

---

## 六、已知局限

1. **Plan Mode 无持久化** — `/plan-approve` 后状态丢失，重启 agent 回到 off
2. **ProfileRegistry 启动时加载** — 运行中新增 `.rivet/agents/` 文件需要重启
3. **sanitizeEnv 可能过度剥离** — 某些构建工具依赖非标准 env var（如 `NODE_OPTIONS`），当前策略会丢弃（因不以安全前缀开头）
4. **coordinator.ts 的 `writeProfiles` 硬编码已替换**，但 `worker-evidence.ts` 的 `READ_ONLY_PROFILES` 数组尚未统一到 registry（低优先级）
