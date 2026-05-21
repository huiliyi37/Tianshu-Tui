# Wave 1 任务文档：Confidence Indicator + Auto-Escalation

> 任务编号：W1-08
> 优先级：中
> 预估：单 session，1 小时
> 前置依赖：无

## 目标

在 TUI 状态栏显示模型当前信心度。当信心持续过低时，建议用户切换到更强的模型。

## 背景

已有基础：
- `src/agent/sensorium.ts` — computeSensorium 计算 confidence 维度
- `src/tui/status-bar.tsx` — 状态栏
- `src/model/capability.ts` — recommendModelForTask()
- StrategyProfile.shouldEscalate — confidence < 0.3 && momentum < 0.2

## 设计

### 状态栏信心指示

```
[task] DeepSeek V4 | cache 98% | ¥0.12 | ●●●○○ confidence
```

5 格信心条：
- ●●●●● (1.0) — 绿色，完全确信
- ●●●○○ (0.6) — 黄色，正常工作
- ●○○○○ (0.2) — 红色，信心很低

### Auto-Escalation 提示

当 `shouldEscalate` 连续 3 轮为 true 时，在 TUI 中显示：

```
⚠️  模型信心持续偏低。建议：
    /model claude-opus    切换到更强模型
    /model deepseek-r1    切换到推理模型
    继续当前模型          按 Enter 忽略
```

不自动切换——只建议。用户决定。

### 信心度计算来源

```
confidence = verifiedCount / max(filesModified, 1)
```

补充信号：
- 连续工具失败 → confidence 下降
- 测试通过 → confidence 上升
- doom loop 检测 → confidence 归零

## 实现计划

### Task 1: 信心条组件

创建 `src/tui/confidence-bar.tsx`：
- 接收 confidence 值 (0-1)
- 渲染 5 格条 + 颜色
- 无 sensorium 时显示 `--`（chat 模式）

### Task 2: 状态栏集成

修改 `src/tui/status-bar.tsx`：
- 新增 confidence-bar 段
- 从 AgentLoop 获取最新 sensorium.confidence

### Task 3: Escalation 检测

创建 `src/agent/escalation-detector.ts`：
- 追踪连续 shouldEscalate 轮数
- 达到阈值（3 轮）时触发建议
- 用户忽略后本 session 不再提示（cooldown）

### Task 4: Escalation UI

修改 `src/tui/app.tsx`：
- 接收 escalation 事件
- 渲染建议面板
- 处理用户选择（切换模型 / 忽略）

### Task 5: /model 命令

修改 `src/tui/slash-commands.ts`：
- `/model` — 显示当前模型
- `/model <name>` — 切换模型（需要 multi-provider adapter）
- `/model list` — 列出可用模型

### Task 6: 测试

- confidence-bar 渲染测试
- escalation-detector 测试（连续触发、cooldown）

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/tui/__tests__/confidence-bar.test.ts
npx tsx --test src/agent/__tests__/escalation-detector.test.ts
```

## 不做的事

- 不自动切换模型（只建议）
- 不做模型性能对比（用户自己判断）
- 不做 cost 预估（切换模型后的费用变化）— 后续迭代
