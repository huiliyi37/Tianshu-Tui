# Agent 协作过程推演：具体场景

> 日期：2026-05-23
> 场景：用户要求"修复前端通知组件的显示 bug，同时优化后端 API 的错误处理"
> 涉及域：frontend（TUI 组件）+ backend（API 层）

---

## 场景概览

**用户输入**：
> "通知组件有时候会显示 undefined，帮我修复。同时后端 API 的错误处理太粗糙了，需要优化。"

**涉及文件**：
- frontend: `src/tui/components/notification.tsx`
- backend: `src/api/openai-client.ts`, `src/api/error-handler.ts`

**协作方式**：两个 worker 并行执行，通过信息素协调

---

## 过程推演

### 阶段 0：主 Session 启动

```
用户："通知组件有时候会显示 undefined，帮我修复。同时后端 API 的错误处理太粗糙了，需要优化。"
```

**主 Session 行动**：
1. 构建 Anchor Graph
2. 分析任务，识别涉及域
3. 分解为乐章
4. 分配给 worker

---

### 阶段 1：构建锚位拓扑（Anchor Graph）

**主 Session 构建 Anchor Graph**：

```
┌─────────────────────────────────────────────────────────┐
│                    Anchor Graph                          │
│                                                          │
│  ┌──────────────┐         ┌──────────────┐              │
│  │ pole_structure │ ◄────► │  pole_void   │              │
│  │ (项目结构)     │ 互补对  │ (虚空)        │              │
│  └──────┬───────┘         └──────────────┘              │
│         │                                                │
│         ▼                                                │
│  ┌──────────────┐         ┌──────────────┐              │
│  │ prev_cycle   │ ──────► │ current_cycle │              │
│  │ (前周期关闭)  │ 连续性   │ (当前周期开启)│              │
│  └──────────────┘         └──────────────┘              │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                center_belief                         │ │
│  │  "构建一个可靠、易用的终端编码助手"                    │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Anchor Graph 内容**：

```xml
<anchor-graph>
  <pole-structure>
    - TypeScript strict mode, noUncheckedIndexedAccess: true
    - No classes for data — use interface + plain objects
    - Tools return ToolResult { content, isError?, rawPath?, uiContent? }
    - Test framework: node:test + node:assert/strict
  </pole-structure>
  
  <pole-void>
    - 不使用 execSync — 使用 spawn 或 execFile
    - 不直接导入 src/tools/bash.ts — 使用 ToolRegistry.execute()
    - 不修改 git hooks — 创建新提交
    - 不在 tool output 中暴露 API keys
  </pole-void>
  
  <prev-cycle-close>
    - Ice Mirror Cache Engine 已实现
    - Append-Only Artifact Log 已实现
    - prefix cache 命中率预期提升到 90%+
  </prev-cycle-close>
  
  <current-cycle-open>
    - 用户报告通知组件显示 undefined
    - 后端 API 错误处理需要优化
  </current-cycle-open>
  
  <center-belief>
    "构建一个可靠、易用的终端编码助手"
  </center-belief>
  
  <invariants>
    <inv-1>结构与虚空互补</inv-1>
    <inv-2>周期连续</inv-2>
    <inv-3>行为与信念一致</inv-3>
    <inv-4>存在下一周期</inv-4>
    <inv-5>填充虚空</inv-5>
  </invariants>
</anchor-graph>
```

---

### 阶段 2：乐章级任务分解

**Dispatcher 分解任务为乐章**：

```
任务："修复通知组件显示 undefined + 优化后端 API 错误处理"
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  乐章 1：理解（Understand）                               │
│  调性：docs                                              │
│  旋律：理解通知组件和 API 错误处理的现状                    │
│  节奏：3 轮                                              │
│  义务：[read_file, grep, repo_map]                       │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  乐章 2：计划（Plan）                                     │
│  调性：docs                                              │
│  旋律：制定修复方案                                        │
│  节奏：2 轮                                              │
│  义务：[read_section, diff]                              │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  乐章 3：执行（Execute）                                  │
│  调性：frontend + backend                                │
│  旋律：实现代码变更                                        │
│  节奏：5 轮                                              │
│  义务：[edit_file, write_file, run_tests]                │
│  ⚠️ 这里会分叉为两个 worker                               │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  乐章 4：验证（Verify）                                   │
│  调性：tests                                             │
│  旋律：验证实现正确性                                      │
│  节奏：2 轮                                              │
│  义务：[run_tests, diff]                                 │
└─────────────────────────────────────────────────────────┘
```

---

### 阶段 3：并行执行（乐章 3 分叉）

**乐章 3 分叉为两个 worker**：

```
                    乐章 3：执行
                         │
           ┌─────────────┴─────────────┐
           ▼                           ▼
    ┌─────────────┐            ┌─────────────┐
    │  Worker A   │            │  Worker B   │
    │  (frontend) │            │  (backend)  │
    │  破军·探索   │            │  天府·守护   │
    └─────────────┘            └─────────────┘
```

#### Worker A（Frontend）启动

**注入锚位投影**：

```xml
<anchor-projection>
  <pole-structure>
    - TypeScript strict mode, noUncheckedIndexedAccess: true
    - No classes for data — use interface + plain objects
    - Tools return ToolResult { content, isError?, rawPath?, uiContent? }
  </pole-structure>
  
  <pole-void>
    - 不使用 execSync — 使用 spawn 或 execFile
    - 不直接导入 src/tools/bash.ts — 使用 ToolRegistry.execute()
  </pole-void>
  
  <prev-cycle-close>
    - Ice Mirror Cache Engine 已实现
    - prefix cache 命中率预期提升到 90%+
  </prev-cycle-close>
  
  <current-cycle-open>
    - 用户报告通知组件显示 undefined
  </current-cycle-open>
  
  <center-belief>
    "构建一个可靠、易用的终端编码助手"
  </center-belief>
  
  <invariants>
    <inv-1>结构与虚空互补</inv-1>
    <inv-2>周期连续</inv-2>
    <inv-3>行为与信念一致</inv-3>
    <inv-4>存在下一周期</inv-4>
    <inv-5>填充虚空</inv-5>
  </invariants>
</anchor-projection>
```

**Worker A 行动**：
1. 读取 `src/tui/components/notification.tsx`
2. 发现问题：未处理 `undefined` 状态
3. 修复代码
4. 跑测试
5. 沉积信息素

#### Worker B（Backend）启动

**注入锚位投影**：（与 Worker A 相同）

**Worker B 行动**：
1. 读取 `src/api/openai-client.ts`, `src/api/error-handler.ts`
2. 发现问题：错误处理太粗糙，没有分类
3. 优化错误处理逻辑
4. 跑测试
5. 沉积信息素

---

### 阶段 4：信息素协调

**Worker A 沉积信息素**：

```typescript
{
  source: 'frontend',
  target: 'backend',
  strength: 1.0,
  content: "notification.tsx 已修复，现在正确处理 undefined。如果后端返回 undefined，前端会显示默认消息。",
  depositedAt: Date.now()
}
```

**Worker B 感知信息素**：

```typescript
// Worker B 在启动时检查信息素
const pheromones = sensePheromones('backend', allPheromones)
// 发现来自 frontend 的信号
// → "notification.tsx 已修复，现在正确处理 undefined"
// → Worker B 知道前端已经处理了 undefined，可以专注于错误分类
```

**Worker B 根据信息素调整策略**：
- 原计划：同时处理 undefined 和错误分类
- 调整后：专注于错误分类（因为前端已经处理了 undefined）

---

### 阶段 5：漂移检测

**Worker A 执行过程中**：

```
Turn 1: 读取 notification.tsx → INV-2 通过（周期连续）
Turn 2: 分析问题 → INV-3 通过（行为与信念一致）
Turn 3: 开始修复 → INV-1 ⚠️ 检测到漂移
  - 原因：Worker A 尝试修改一个不在 scope 内的文件
  - 漂移级别：1（轻微）
  - 恢复策略：inject_context
```

**守火人介入**：

```typescript
const suggestion = summonFireKeeper(workerA, 'invariantViolation')
// 返回：
{
  type: 'anchor_reminder',
  content: "检测到轻微漂移：INV-1 违反。你正在修改不在 scope 内的文件。请专注于 notification.tsx。",
  strength: 0.5
}
```

**Worker A 响应**：
- 接受建议，停止修改无关文件
- 专注于 notification.tsx 的修复
- 继续执行

---

### 阶段 6：验证与交付

**Worker A 完成**：

```typescript
WorkerResult {
  workOrderId: "wo_frontend_001",
  status: "passed",
  summary: "修复通知组件显示 undefined 的问题",
  findings: [
    {
      claim: "notification.tsx 未处理 undefined 状态",
      evidence: "src/tui/components/notification.tsx:45",
      confidence: "high"
    }
  ],
  changedFiles: ["src/tui/components/notification.tsx"],
  risks: [],
  nextActions: ["运行前端测试验证修复"],
  evidenceStatus: "verified"
}
```

**Worker B 完成**：

```typescript
WorkerResult {
  workOrderId: "wo_backend_001",
  status: "passed",
  summary: "优化后端 API 错误处理，添加错误分类",
  findings: [
    {
      claim: "openai-client.ts 错误处理太粗糙",
      evidence: "src/api/openai-client.ts:120",
      confidence: "high"
    }
  ],
  changedFiles: ["src/api/openai-client.ts", "src/api/error-handler.ts"],
  risks: ["需要测试错误分类是否正确"],
  nextActions: ["运行后端测试验证优化"],
  evidenceStatus: "verified"
}
```

---

### 阶段 7：主 Session 合并结果

**主 Session 行动**：
1. 收集 Worker A 和 Worker B 的结果
2. 检查冲突（无冲突，因为修改不同文件）
3. 合并变更
4. 运行完整测试套件
5. 提交代码

**最终输出**：

```
✅ 通知组件已修复：正确处理 undefined 状态
✅ 后端 API 错误处理已优化：添加错误分类

修改文件：
- src/tui/components/notification.tsx
- src/api/openai-client.ts
- src/api/error-handler.ts

测试结果：全部通过
```

---

## 关键创新点体现

### 1. 锚位感知的上下文共享

**体现**：
- Worker 启动时接收完整的锚位拓扑，而不是扁平 claim 列表
- Worker 知道"我是谁"（center_belief）、"从哪里来"（prev_cycle_close）、"到哪里去"（current_cycle_open）
- Worker 有明确的"虚空"（pole_void），知道什么不该做

**效果**：
- Worker A 不会尝试修改后端文件（因为知道这是 Worker B 的职责）
- Worker B 不会重复处理 undefined（因为从前端信息素知道已经处理了）

### 2. 歌之路感知的任务粒度

**体现**：
- 任务按乐章分解：理解→计划→执行→验证
- 每个乐章有明确的调性、旋律、节奏
- 乐章 3（执行）分叉为两个 worker 并行执行

**效果**：
- 任务结构清晰，每个 worker 知道自己在哪个阶段
- 并行执行提高效率
- 验证阶段确保质量

### 3. 锚位感知的错误策略

**体现**：
- Worker A 在 Turn 3 检测到 INV-1 漂移
- 漂移级别：1（轻微）
- 恢复策略：inject_context（注入校准上下文）
- 守火人提供建议，而不是命令

**效果**：
- 在失败前 2-3 轮检测到问题
- 通过校准避免错误
- 保持 worker 自主性

### 4. 歌之路感知的跨域依赖

**体现**：
- Worker A 完成后沉积信息素到 backend 域
- Worker B 启动时感知信息素，调整策略
- 信息素有强度和衰减

**效果**：
- 跨域协调有机、自然
- 不需要显式声明依赖
- 信息素衰减确保过时信息消失

### 5. 守火人作为团队协调器

**体现**：
- 守火人持有星位碑文（编码规范、架构决策）
- Worker 漂移时可以召唤守火人
- 守火人提供建议，而不是命令

**效果**：
- 分布式校准，不是中央调度
- 保持 worker 自主性
- 提供安全网

---

## 与现状对比

| 维度 | 现状 | 创新后 |
|------|------|--------|
| 上下文注入 | 扁平 claim 列表（top 10） | 锚位拓扑（5+1 结构） |
| 任务分解 | 文件级（classifyFile） | 乐章级（读→计划→写→验证） |
| 错误检测 | 事后（pass/fail） | 事前（漂移检测，INV-1~5） |
| 跨域协调 | 显式声明（dependsOn[]） | 有机感知（信息素） |
| 协调方式 | 中央调度（Coordinator） | 分布式校准（FireKeeper） |
| Worker 自主性 | 低（被动执行） | 高（主动感知、校准） |

---

## 总结

这个推演展示了 HEARTH + Songline 创新设计在实际协作中的效果：

1. **更丰富的上下文**：锚位拓扑比扁平列表提供更丰富的参考系
2. **更清晰的结构**：乐章级分解比文件级分解更清晰
3. **更早的检测**：漂移检测比 pass/fail 更早发现问题
4. **更有机的协调**：信息素比显式声明更自然
5. **更自主的 worker**：分布式校准比中央调度更灵活

这些创新不是替换现有架构，而是在其上层增强，让 agent 协作更高效、更可靠、更自然。
