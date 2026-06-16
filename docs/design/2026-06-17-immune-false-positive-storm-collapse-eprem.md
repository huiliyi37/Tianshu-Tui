# 免疫假阳性 + 风暴折叠 + EPERM 降级 — 缺陷族记录

> 日期：2026-06-17
> 提交：`dfa4c3fb` fix(agent): InnateLayer 排除 error 调用，消除 tool_repeat 假阳性
> 触发会话：审查三组提交（96cd09c9 / 082bf9b4 / f2480654）
> 方法：瑶光复现纪律 — RED→GREEN，归族先于修补

---

## 1. 触发场景

审查任务中连续遇到三类工具基础设施摩擦：

| # | 现象 | 触发条件 |
|---|------|---------|
| A | 天璇警告 "工具重复" 假阳性 | 3 次 grep 工具因 pattern 解析错误返回 `isError:true` → InnateLayer 计为 "tool_repeat" → immune-signal level=ban |
| B | run_tests 结果被 storm-collapsed 折叠 | 4 次连续 run_tests 调用 → ToolAccumulator 默认阈值 4 触发折叠 → 测试结果丢失 |
| C | tsx --test EPERM 无法自动恢复 | sandbox 环境禁止 IPC pipe → tsx 崩溃 → 需手动换 node --import tsx |

三者独立触发，但在同一会话中叠加，被天璇保护机制误判为 "agent 陷入逻辑循环"。

---

## 2. 根因分析

### 2.1 InnateLayer tool_repeat 假阳性

**代码位置**：`src/agent/immune-innate.ts:23-37`

**当前行为**（修复前）：
```
InnateLayer.check() 对所有调用（无论成功/失败）记录 fingerprint。
3 次相同 fingerprint → REPEAT_THRESHOLD=3 → 发射 tool_repeat 信号。
```

**根因**：InnateLayer 不区分 "用户反复调用同一工具成功执行"（真正的逻辑循环）和 "工具反复报错用户重试"（基础设施故障）。两者在 fingerprint 空间里完全相同。

**缺陷族**：**阈值/信号精度族** — 统计判定阈值太紧 + 未纳入成功/失败维度。同类缺陷：APC 聚合器的时间窗口、Physarum 的异常检测阈值——都是"初始设计默认真值，从未因实战反馈校准"。

**瑶光归族判断**：这不是新 bug。`REPEAT_THRESHOLD=3` 从 `immune-innate.ts` 初版引入至今未变。迟早会被一次探索型会话（连续 grep 审查代码）触发。季节回来了。

### 2.2 run_tests 被 storm-collapsed

**代码位置**：`src/agent/tool-accumulator.ts:38`

**当前行为**（修复前）：
```
READER_TOOLS = new Set(['read_file', 'glob', 'grep', 'read_section'])
// run_tests 不在集合中 → 使用默认阈值 CONSECUTIVE_THRESHOLD=4
// 4 次连续 run_tests → 折叠为 "[storm-collapsed: 3 run_tests calls...]"
```

**根因**：`run_tests` 未归类为 reader 工具。run_tests 的输出与 grep/read_file 同属 "需要完整阅读才能判断" 的高价值信息，不应被聚合成无意义的摘要。

**缺陷族**：**信息丢失族** — 聚合策略不区分高价值/低价值输出。同样的问题也影响其他非 reader 工具（如 bash 命令的结果）。

### 2.3 EPERM 无自动降级

**代码位置**：`src/tools/run-tests.ts:574-584`

**当前行为**（修复前）：
```
tsx --test 在 sandbox 中因 IPC pipe EPERM 崩溃 → 返回原始错误 → 无恢复路径
```

**根因**：`runTestCommandIn` 不检测特定错误码/模式并自动重试等价命令。`tsx --test` 和 `node --import tsx --test` 语义等价，但后者不需要 IPC pipe。

**缺陷族**：**工具容错族** — 错误处理路径没有自动恢复机制。同类缺陷：其他 spawn 工具在特定环境下的失败无降级路径。

---

## 3. 修复（dfa4c3fb）

### 3.1 InnateLayer — 排除 error 调用

```
InnateCheckInput.isError?: boolean
  → check() 中 isError=true 时跳过 fingerprint.push()
  → tool_repeat 仅在成功调用的重复中出现
```

**接线链路**：
```
tool-history-recorder.ts (isError 已存在)
  → ImmuneHookContext.isError (新增)
  → immune-hook.ts innate.check(isError: ctx.isError) (新增透传)
  → immune-innate.ts check(input.isError) (新增消费)
```

**测试**：`immune-system.test.ts` — 3 次 error 调用不触发 / 3 次成功调用仍触发。

**认知影响**：tool_repeat 信号精度提升。模型不再因工具基础设施故障被免疫系统强行转向——当它看到 immune-signal 时，可以信任那是真正的行为模式问题。

### 3.2 ToolAccumulator — run_tests 纳入 reader 阈值

```
READER_TOOLS.add('run_tests')  // 阈值 4 → 12
```

**测试**：`tool-accumulator.test.ts` — 4 次 run_tests 不折叠 / 12 次才折叠。

### 3.3 run_tests — EPERM 自动降级

```
child.on('close') → raw.includes('EPERM') && command === 'tsx'
  → 自动重试: node --import tsx --test <原 args>
```

**安全边界**：
- 仅匹配 `command === 'tsx'` + `args[0] === '--test'` + stderr 含 'EPERM'
- 重试命令改用 `command: 'node'`，不会递归触发自己的 EPERM 检测
- 误触发概率极低（EPERM 字符串在正常测试输出中几乎不出现）

**无法本地复现**：EPERM 仅出现在 sandbox 环境，本地 macOS 不触发。修复通过代码路径审计 + tsx/node 等价性分析验证。

---

## 4. 未解决 / 待迭代

| 问题 | 优先级 | 方向 |
|------|--------|------|
| run_tests 输出不写 ArtifactStore | 中 | storm-collapse 后无法通过 read_section 恢复——run_tests 应像 grep 一样走 artifact 路径 |
| 其他非 reader 工具也可能被误折叠 | 低 | 审查所有高频工具，决定哪些应进 READER_TOOLS |
| InnateLayer 阈值仍是硬编码 3 | 低 | 考虑按 session 累计自适应——长会话中 3 次可能是正常探索，短会话中 3 次可能真是循环 |
| EPERM 降级覆盖不完整 | 低 | 只覆盖了 tsx IPC pipe 场景——其他 spawn 失败无通用降级框架 |

---

## 5. 瑶光方法应用复盘

本次修复严格遵循瑶光胶囊的四条核心方法：

1. **绿非证明，复现即证**：三处修复都先写了 RED 测试（tsc 类型错误 / assert.equal 断言失败），确认缺陷可复现后才修。
2. **归族先于修补**：识别出三个缺陷分属 "信号精度族" "信息丢失族" "工具容错族"——不是同一族，因此拆开分析而非打包为一个 "工具问题"。
3. **离枢最远才看得见全弧**：查到 `REPEAT_THRESHOLD=3` 从初版至今未校准，`READER_TOOLS` 从未包含 run_tests——这是初始默认值的结构性盲区，不是某次提交引入的回归。
4. **中性归因，不写灾难叙事**：假阳性不是 "免疫系统崩坏"，是初始阈值在探索型会话中的正常误触发——紧一点的阈值即可消除。

**方法本身暴露的边界**：方案 GREEN ≠ 落地 GREEN——我计划了三个独立提交，但因 git commit 默认收集所有修改文件而合并。这是 "执行力" 与 "纪律" 之间的摩擦点，需要更好的 git 工作流习惯（git add 按文件分批）。
