# Artifact Intercept 设计文档

## 问题背景

Agent 的工具输出（read_file、grep、bash）超过阈值时被 artifact intercept 截断为引用 `[artifact:xxx]`，需要后续 `read_section` 才能看到内容。当阈值过低时形成"俄罗斯套娃"：

```
read_file → [artifact:a] → read_section → [artifact:b] → read_section → ...
```

审查场景中 80% 的轮次浪费在读取自己的工具输出上。

## 架构

```
工具执行 → artifactIntercept() → 决策：inline 还是存 artifact
                                    ↓
                    ┌───────────────────────────────┐
                    │  决策因素（优先级从高到低）      │
                    │  1. 工具白名单（读取类 8000）   │
                    │  2. thresholdOverride（调用方） │
                    │  3. budget-aware 缩放          │
                    │  4. CacheAdvisor 自适应阈值    │
                    │  5. 静态 fallback（2500/1600） │
                    └───────────────────────────────┘
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/agent/tool-pipeline.ts` | artifactIntercept 函数、白名单、generateToolSummary |
| `src/cache/adaptive-threshold.ts` | 自适应阈值控制器（ghost hit 反馈） |
| `src/cache/advisor.ts` | CacheAdvisor.getArtifactThreshold()、阶段乘数 |
| `src/artifact/store.ts` | ArtifactStore 磁盘持久化 |

## 阈值决策流程

```typescript
artifactIntercept(content, toolName, toolInput, store, isError, thresholdOverride?, budgetFraction?)
```

1. **白名单检查**：`read_file`/`grep`/`glob`/`find_files`/`search`/`repo_map`/`inspect_project` 或 bash 只读命令 → 阈值 8000
2. **thresholdOverride**：调用方可传入 CacheAdvisor 计算的值
3. **Budget 缩放**：
   - `budgetFraction > 0.5` → threshold × 3
   - `budgetFraction > 0.3` → threshold × 1.5
   - `budgetFraction ≤ 0.3` → 不缩放（保护 context）
4. **content.length ≤ threshold** → 直接 inline
5. **超过阈值** → 存入 ArtifactStore，返回 `[artifact:id] summary`

## 自适应阈值（AdaptiveThresholdController）

- 默认起始：800 chars（成功）/ 1600 chars（错误）
- 范围：[400, 4000]
- 调整信号：
  - Ghost hit（被截内容被重新请求）→ +200
  - Cache hit rate ≥ 0.8 → +100
  - Cache hit rate < 0.3 → -100
  - Ghost efficiency > 0.9 且 threshold > 600 → -50

## 阶段乘数（CacheAdvisor）

| 阶段 | 乘数 | 说明 |
|------|------|------|
| explore | 1.0 | 审查/探索需要看代码 |
| plan | 1.5 | 规划阶段需要更多上下文 |
| execute | 1.0 | 基准 |
| verify | 2.0 | 验证阶段需要完整输出 |
| deliver | 0.5 | 交付阶段可以压缩 |

## Bash 只读检测

`isBashReadOnly()` 通过正则匹配命令前缀判断：
- 只读：`cat`, `head`, `tail`, `grep`, `rg`, `find`, `ls`, `tree`, `wc`, `git log/diff/status/show/blame`, `echo`, `which`, `file`
- 非只读（走默认阈值）：`npm`, `node`, `rm`, `mv`, `cp`, `git commit/push` 等

## generateToolSummary

当内容被 intercept 时生成摘要，帮助 agent 决定是否需要 read_section：

- `run_tests` → 提取 pass/fail 行
- `diff` → 列出变更文件名
- `glob` → 匹配数量和前几个文件
- `bash` → 区分 typecheck（error TS 计数）、test（pass/fail 行）、通用
- `default` → 首行 + 字符/行数统计

## 迭代方向

1. **read_section 也应该有白名单豁免** — 当前 read_section 的输出也可能被 intercept
2. **按工具类型动态调整** — write_file 的输出（确认信息）可以更激进地截断
3. **Ghost hit 反馈加速** — 当前需要 2 次 ghost hit 才触发 +200，可以改为 1 次
4. **Budget 感知可以更精细** — 考虑当前 turn 已有多少工具调用，预留后续空间
5. **Artifact 分段存储** — 大文件按函数/类分段，read_section 可以按语义段读取而非行号
