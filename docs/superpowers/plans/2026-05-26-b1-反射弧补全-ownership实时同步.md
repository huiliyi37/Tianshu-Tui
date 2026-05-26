# B1 反射弧补全：Ownership 实时同步 + Verification 覆盖扩展

> **定位：** B1 归属星轨的接线层修复  
> **状态：** 已实施 (2026-05-26)  
> **前置：** `2026-05-21-b1-归属星轨-任务归属验证归因交付账本.md`  
> **触发：** 天枢复盘 — 每次会话开始时 ownership 文件不同步，deliver_task 需要主动调用才能填充

---

## 1. 问题描述

B1 归属星轨的架构设计正确（TaskLedger → OwnershipLedger → DeliveryGate → deliver_task），但存在两条断裂的"神经反射弧"：

### 反射弧 1：Ownership 延迟同步

```
当前路径（断裂）：
  edit_file("src/foo.ts")
    → tool-pipeline 记录 { type: 'file_write', path: 'src/foo.ts' } 到 TaskLedger
    → OwnershipLedger 不知道（没有被通知）
    → ... 若干轮工具调用 ...
    → agent 调用 deliver_task
    → deliver_task 内部调 autoOwnFromLedger() 批量同步
    → 此时 OwnershipLedger 才知道 src/foo.ts 是 owned

问题：如果 agent 不调 deliver_task（直接 git commit），ownership 永远为空。
天枢表现：每次会话开始时表示"ownership 确认文件不同步"。
```

### 反射弧 2：Verification 覆盖不全

```
当前 regex：/\b(tsc|typecheck|test|jest|vitest|mocha|pytest)\b/

遗漏的常见验证命令：
  - npm run build / npm run check
  - eslint / npm run lint
  - 任何包含 "build" 或 "lint" 的 bash 命令

结果：这些命令的成功/失败不会写入 verification ledger，
deliver_task 看到的 verificationStatus 可能是 "unverified" 而非 "verified"。
```

---

## 2. 修复方案

### 2.1 实时 Ownership 注册

**原则：** 文件写入的瞬间就注册 ownership，不等 deliver_task。

**数据流（修复后）：**

```
edit_file("src/foo.ts")
  → tool-pipeline 记录 file_write 到 TaskLedger
  → tool-pipeline 同时调用 ownershipLedger.registerOwned("src/foo.ts")  ← 新增
  → OwnershipLedger 立即知道 src/foo.ts 是 owned
  → deliver_task 的 autoOwnFromLedger() 保留作为兜底（belt-and-suspenders）
```

**变更文件：**

| 文件 | 变更 |
|------|------|
| `src/agent/loop.ts` | AgentConfig 新增 `ownershipLedger?: OwnershipLedger` |
| `src/agent/tool-pipeline.ts` | ToolPipelineDeps 新增 `ownershipLedger?`；file_write 分支追加 `registerOwned()` |
| `src/agent/tool-execution.ts` | 透传 `ownershipLedger` 到 pipeline deps |
| `src/main.tsx` | 模块级 `_ownershipLedgerRef`，传入 AgentLoop config |

**关键代码：**

```typescript
// src/agent/tool-pipeline.ts — file_write 分支
} else if ((tu.name === 'write_file' || tu.name === 'edit_file') && filePath) {
  deps.taskLedger.record({ type: 'file_write', path: filePath })
  deps.ownershipLedger?.registerOwned(filePath)  // ← 实时注册
}
```

### 2.2 Verification Regex 扩展

**原则：** 所有常见的验证/构建/lint 命令都应被识别为 verification 事件。

**变更：**

```typescript
// Before:
/\b(tsc|typecheck|test|jest|vitest|mocha|pytest)\b/

// After:
/\b(tsc|typecheck|check|test|jest|vitest|mocha|pytest|eslint|lint|build)\b/
```

**新增覆盖：**

| 命令模式 | 之前 | 之后 |
|----------|------|------|
| `npm run build` | tool_exec | verification |
| `npm run lint` | tool_exec | verification |
| `eslint src/` | tool_exec | verification |
| `npm run check` | tool_exec | verification |
| `npx tsc --noEmit` | verification (已覆盖) | verification |
| `npm test` | verification (已覆盖) | verification |

---

## 3. 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      tool-pipeline.ts                         │
│                                                              │
│  edit_file / write_file                                      │
│    ├─→ taskLedger.record({ type: 'file_write' })            │
│    └─→ ownershipLedger.registerOwned(path)  ← NEW           │
│                                                              │
│  bash (tsc|test|build|lint|...)                              │
│    └─→ taskLedger.record({ type: 'verification',            │
│           status: isError ? 'failed' : 'passed' })           │
│                                                              │
│  run_tests                                                   │
│    └─→ taskLedger.record({ type: 'verification', ... })     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              OwnershipLedger (实时更新)                        │
│                                                              │
│  ownedSet: Set<string>  ← 每次 file_write 立即填充           │
│                                                              │
│  autoOwnFromLedger()    ← deliver_task 兜底调用              │
│    (遍历 TaskLedger events 补漏 git_action 等)               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              DeliveryGate V2                                   │
│                                                              │
│  getReport() → GREEN / YELLOW / RED                          │
│    - 基于 OwnershipLedger.getOwnedFiles()                    │
│    - 基于 TaskLedger.getVerificationStatus()                 │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 设计决策

### 为什么不在 TaskLedger.record() 内部自动触发 ownership？

TaskLedger 是纯事件记录器，不应有副作用。OwnershipLedger 依赖 WorktreeBaseline 判断文件是否 external，这个判断不属于 TaskLedger 的职责。保持单一职责，在调用侧（tool-pipeline）显式触发。

### 为什么保留 deliver_task 的 autoOwnFromLedger()？

Belt-and-suspenders 策略。实时路径覆盖 `edit_file` / `write_file`，但 `git_action` 类事件（如 `git mv`、`git checkout -- file`）可能创建/修改文件而不经过 file_write 工具。`autoOwnFromLedger()` 在交付前做最终对账。

### 为什么 verification regex 加了 build 和 lint？

天枢的工作模式中，`npm run build` 失败是常见的验证信号。如果不记录为 verification，TaskLedger 的 `getVerificationStatus()` 会返回 `unverified`（因为有 file_write 但没有 verification 事件），导致 DeliveryGate 报 RED。实际上 agent 已经跑过验证了，只是没被记录。

---

## 5. 测试验证

```bash
# 所有 B1 相关测试通过
tsx --test src/agent/__tests__/ownership-ledger.test.ts    # 11 pass
tsx --test src/agent/__tests__/task-ledger.test.ts         # 11 pass
tsx --test src/agent/__tests__/worker-evidence.test.ts     # 11 pass
tsx --test src/agent/__tests__/tool-pipeline.test.ts       # 19 pass
# TypeScript 编译零错误
tsc --noEmit
```

---

## 6. 后续迭代方向

| 方向 | 描述 | 优先级 |
|------|------|--------|
| git_action → ownership | `git mv` / `git checkout` 等也应实时注册 ownership（当前靠 autoOwnFromLedger 兜底） | P2 |
| verification 置信度 | 区分 `tsc --noEmit`（类型检查）vs `npm test`（功能测试）的权重 | P3 |
| ownership 持久化 | 跨 compact 保留 ownership 状态（当前在内存，compact 后丢失） | P2 |
| 多文件 bash 写入 | `bash` 中 `echo > file.txt` 不经过 edit_file，不会触发 ownership | P2 |
| 天枢安全感指标 | 量化"会话开始时 ownership 同步延迟"作为 B1 健康度指标 | P3 |

---

## 7. 与其他系统的关系

- **HEARTH**：ownership 实时更新意味着 cycle_close 时沉积的 durable claim 更准确
- **Songline**：obligation scope 实时反映真实写入，不再有延迟窗口
- **Patcher Worker**：V2 计划中的证据门降级（任务 4）与本修复互补——patcher 的 verification 现在能被正确记录
- **prefix cache**：本修复不触碰 prompt 层，与 cache 不变量无关
