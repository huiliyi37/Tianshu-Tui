# Wave 5: Trust Infrastructure — 深度头脑风暴设计文档

## 背景

### 用户需求
ACF Phase 1-4 已完成（commit 7608885），Wave 1-4 已合并到 main。下一步：补强 TUI 能力，让 Rivet 在日常编码任务中的成功率和效率超越 Claude Code。

### 项目上下文
- Rivet: 基于 DeepSeek V4 的终端编码代理，Ink 6 + React TUI
- 已完成: headless, permissions, cost tracking, custom commands, onboarding, session fork, approval edit, auto-reasoning, LSP diagnostics, HTTP/SSE API, vim mode, @file completer, command palette, external editor, git worktree, stream-json, prompt SSE, composable CLI
- ACF 分支: pressure-monitor, anchor-registry, persistent-store, proactive-inject, recall tool, provider-profile, cache-strategy
- 测试: 712 pass, 0 fail

### 调研发现摘要

**竞品 (Scout 1):**
- 用户痛点 #1: context rot（15-20 轮后退化）
- 用户痛点 #2: lost work / 无法精细回滚
- 2026 趋势: per-tool-call time-travel, /goal persistent loop, "game engine" TUI
- Claude Code 有 checkpoint 但只是 per-session；没有人让用户"看见"上下文管理

**跨领域创新 (Scout 2):**
- DAW 焦点通道 + 作用域撤销栈: 每个工作面独立 undo
- BAML 部分对象流式渲染: 语义块级流式
- lazygit 优先级分组响应式隐藏: 信息密度随终端宽度自适应
- 决策边界批量呈现: 按步骤批量渲染，不逐字符滚屏

**代码库审计 (Scout 3):**
- 5 个 AgentConfig 字段未接线 (lspEnabled, hooks, fileHistory, permissions, autoReasoning)
- 4 个工具已实现未注册 (undo, inspect_project, repo_map, related_tests)
- 5 个 slash commands 无 handler (/scroll, /fork, /evidence, /undo, /vim)

**反证 (Scout 4):**
- Checkpoint 是 per-run 粒度，不是 per-tool-call
- FileHistory 内存不持久化，session 重启后丢失
- 只有 3 个功能真正"传参即用"（autoReasoning, lspEnabled, 工具注册）
- /scroll /fork /vim 是"未实现"不是"未接线"

---

## 三轮思考过程

### 第一轮：变异

```
[VARIATION]
生态位: 开源终端编码代理 / DeepSeek V4 优化 / 对标 Claude Code+Codex / 单开发者维护
选择压力: (1) 日常任务成功率 (2) 不丢用户工作 (3) 比 Claude Code 省钱 4x
已占据: Claude Code(全功能巨兽), Aider(轻量多模型), Codex(沙箱安全)
空位: 没有人做到"按工具调用粒度 time-travel + DeepSeek 缓存经济"的组合
```

**V1 (主流：功能激活 sprint)**
用户在终端输入 rivet，发现 undo/inspect_project/repo_map/autoReasoning/LSP 全部可用。第一步：在 main.tsx 传入 autoReasoning: true, lspEnabled: true，在 default-registry.ts 注册 4 个工具。结果：agent 的代码搜索能力 + 自适应推理 + LSP 诊断立即生效。

**V2 (邻近：增量快照链)**
用户执行 /undo 3，回滚到第 3 次工具调用前的状态。第一步：把 FileHistory 从内存改为 JSON 文件持久化，每次 write_file/edit_file 后自动快照。结果：per-tool-call 粒度的 selective undo。

**V3 (空位：Context Cockpit)**
用户输入 /context，看到实时 panel 显示"窗口中有什么"：哪些文件在 L1 全文、哪些被压缩到 L2 摘要、哪些在 L3 冷存储。第一步：渲染 ContextLedger 的 rounds + anchors + workingSet。结果：用户能"看见"上下文管理。

**V4 (突变：Goal Loop)**
用户输入 rivet --goal "make all tests pass" --budget 50，agent 自主循环直到目标达成。第一步：在 headless 模式中加 --goal flag + 循环检测退出条件。结果：fire-and-forget 场景。

```
创始假设: "用户想要更多功能" — 但半成品功能比缺功能更糟
适应度函数: 硬约束=单人可维护+不破坏712 tests / 加分=解决痛点top-2 / 减分=需要新架构层
```

### 第二轮：选择

```
[SELECTION]
目标偏移: 无（全部回应"补强 TUI 能力"）
因果测试:
  V1: 通过 — 注册工具→agent可调用→任务成功率上升
  V2: 通过 — 持久化FileHistory→per-call undo→用户不丢工作
  V3: 通过 — 可视化ContextLedger→用户理解上下文→信任agent
  V4: 断裂 — 没有per-call undo保底，自主模式可能造成灾难性修改
成本测试:
  V1: 低(半天) / V2: 中(2-3天) / V3: 中(1-2天) / V4: 高(1周+)
共演化:
  V1: 静态 / V2: 动态(是V4的前置) / V3: 动态(驱动ACF迭代) / V4: 依赖V2
局部最优: V1是安全牌但不构成差异化
落地性:
  V1: toolRegistry.register(REPO_MAP_TOOL) → 可执行
  V2: FileHistory加serialize()/deserialize() → 可执行
  V3: /context命令渲染ledger → 可执行
  V4: 需要V2先完成 → 阻塞
灭绝: V4 — 原因：因果链断裂(无undo保底的自主agent是定时炸弹)
存活: V1(弱·基础卫生) / V2(强·信任基础设施) / V3(强·ACF投资变现)
最强竞争者: V2+V3组合 — V1作为前置快速完成
新发现: V2和V3是信任的两条腿——可见性+可回滚性
```

**discarded_traits from V4:**
- "budget-capped autonomous loop" — 未来 V2 完成后可复活为 Wave 6
- "exit condition DSL" — 通用的目标达成检测逻辑，可用于 FileHistory GC 策略

### 第三轮：适应

```
[ADAPTATION]
套路清除: "激活所有休眠功能"是套路——聚焦到真正传参即用的3个
扩展适应:
  - ACF ContextLedger 已有 rounds/anchors/workingSet → 直接渲染为 /context 输出
  - output-store.ts 已有 SHA-256 索引 → 扩展为 FileHistory 持久化后端
  - session-memory.ts 已有序列化逻辑 → FileHistory 复用相同模式
具体化:
  人: 使用Rivet的开发者，30分钟会话中做了15次文件修改
  场: 第12次修改引入bug，发现时已是第15次修改之后
  动: /undo 看到15个快照列表，选择回滚到第11次
  果: 3个文件恢复到修改11的状态，session继续
收敛验证: V2和V3收敛到"用户信任=可见性+可回滚性"
```

---

## 最终方案

### Wave 5: Trust Infrastructure（信任基础设施）

**核心洞察：** 用户信任 = 可见性 + 可回滚性。没有可见性，用户不知道 agent 忘了什么；没有可回滚性，用户不敢让 agent 自主执行。

**三阶段递进：**

| Phase | 内容 | 时间 | 解决的痛点 |
|-------|------|------|-----------|
| Phase 1 | 激活休眠能力 + 合并 ACF | 半天 | Agent 更聪明 |
| Phase 2 | 持久化 per-call undo | 2 天 | 用户不怕 agent |
| Phase 3 | 上下文可视化 (/context) | 1.5 天 | 用户理解 agent |

### Phase 1：基础激活

- 在 `default-registry.ts` 注册 `inspect_project`, `repo_map`, `related_tests` 工具
- 在 `main.tsx` 传入 `autoReasoning: true`, `lspEnabled: true`
- 合并 ACF 分支到 main（resolve conflicts if any）

### Phase 2：持久化 Undo

- FileHistory 加 `serialize()` / `deserialize()` 方法
- 持久化到 `~/.rivet/sessions/{sessionId}/file-history.json`
- 在 `main.tsx` 创建 FileHistory 实例并传入 AgentLoop
- 注册 undo tool 到 default-registry
- 环形缓冲：最多 50 个快照，超出 GC 最旧的
- 异步写入防止 latency 影响

### Phase 3：Context Cockpit

- 实现 `/context` slash command handler
- 渲染 ContextLedger 状态：rounds count, anchors list, workingSet, 压缩统计
- 实现 `/context pin <text>` 手动添加锚点
- 显示窗口利用率百分比 + 各层数据量

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| FileHistory I/O 影响 latency | 异步写入 + 环形缓冲(50 cap) |
| ACF 合并冲突 | 如果超过 1 小时无法解决，先跳过 ACF，Phase 3 用 mock 数据 |
| /context 信息过载 | 优先级分组响应式隐藏（lazygit 模式）|
| undo 快照过大 | 只存 diff 不存全文（增量快照） |

---

## 下一步

Phase 1 的第一个具体动作：在 `src/tools/default-registry.ts` 中 import 并 register `INSPECT_PROJECT_TOOL`, `REPO_MAP_TOOL`, `RELATED_TESTS_TOOL`。
