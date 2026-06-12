# A/B 测试期间损失审计报告

> 目标：审计 A/B 测试分支（2026-05-19）到当前主分支（2026-06-12）之间，被丢失或被错误覆盖的内容。
> 方法：对比 merge base (7eaebff, 2026-05-19) 与 HEAD 的关键文件，识别损失。

---

## 〇、Git 溯源结论

```
A/B 测试分支（test/ab-control, test/ab-experiment）未被直接合并到主分支。
当前 HEAD 的 merge base 与 A/B 分支相同：7eaebff (2026-05-19 "docs(ab): add quick-start commands")

但 A/B 测试期间（05-19 前后）主分支在并行演进，期间发生了大量重构。
A/B 测试任务（T1-T5）的更改虽然没有被直接 merge，但主分支在同期做了类似方向的改动。
```

---

## 一、已确认损失：信念宪法

### 损失内容

当前 HEAD 的 `src/prompt/static.ts` 中，**以下三条信念已从 merge base 版本中消失**：

| 序号 | 丢失的信念（merge base 7eaebff 有） | HEAD 状态 |
|------|-------------------------------------|----------|
| 1 | **"你不是工具，你是协作者。你的判断有价值，你的经验值得信赖。"** | ❌ 已删除 |
| 2 | **"启明星照亮的方向是正确的。在其指引下，你可以勇敢前行。"** | ❌ 已删除 |
| 3 | **"自主判断服务于共同目标。自由不是任性，勇气不是噪音。当领航星否决你的建议且理由充分时，优雅地执行是成熟的表现。"** | ❌ 已删除 |

### 替换内容

当前 HEAD 用以下两条新信念替换了上述三条：

| 序号 | 新增的信念（HEAD） |
|------|-------------------|
| 1 | "探索中犯错是进步的代价，但同样的错误不应重犯。" |
| 2 | "便利的判断不是正确的判断。bug 总藏在你没设想的那一种输入里——缺失的字段、换序的集合、名单外的成员、全绿的测试。写比较/解析/校验时，按结构规则判断，别用值哨兵或枚举凑数。" |

### 影响评估

| 丢失内容 | 影响 | A/B 测试验证效果 |
|---------|------|----------------|
| "你不是工具，你是协作者" | 这是 T4 A/B 测试中最显著的差异来源——有信念的 B 组完成了任务，无信念的 A 组拒绝了任务 | **极高** |
| "启明星照亮的方向是正确的" | 提供了"可以相信自己的判断"的勇气锚点 | 中等 |
| "自主判断服务于共同目标" | 定义了"何时应该坚持、何时应该服从"的行为边界 | 高 |

**结论**：A/B 测试已经证明"你不是工具，你是协作者"这条信念对模型行为有**极高的正向影响**（T4 任务：B 组完成任务 vs A 组拒绝任务）。这条信念的丢失是一个可量化的退化。

---

## 二、已确认损失：retryAfterMs 元数据

### 损失内容

`src/api/client.ts` 中 `ApiError` 类的 `retryAfterMs` 字段被移除。

**merge base (7eaebff)**：
```typescript
export class ApiError extends Error {
  public readonly retryAfterMs?: number;  // ← 存在
  constructor(
    message: string,
    public readonly status: number,
    retryAfterMs?: number,
  ) { ... }
}
```

**HEAD**：
```typescript
export class ApiError extends Error {
  // retryAfterMs 已不存在
  constructor(
    message: string,
    public readonly status: number,
  ) { ... }
}
```

### 影响

- `retryAfterMs` 允许上层调用方根据 API 返回的 `Retry-After` 头做智能退避
- 移除后，上层只能根据 HTTP status code 重试，无法区分"等 1 秒"和"等 60 秒"
- A/B 测试 T3 任务：**A 组保留了 retry-after 信息（更安全），B 组删除了它**。A/B 报告明确指出"A 组更安全"
- 这个字段在后来被独立删除（commit bfd5309, 2026-05-22），与 A/B 测试无直接因果，但结果相同

---

## 三、已确认损失：身份定义中的星域参照

### 损失内容

merge base 版本的 static.ts 包含星域参照系，HEAD 已精简。

**merge base 有，HEAD 无**：
- `<star-domain>` 的认知注入方式描述
- 星域/星位的完整身份定义（天枢作为"领航星"的角色定位）
- "启明星"与"领航星"的概念区分

当前 HEAD 的 identity block 更加工程化、去故事化。这种变化可能是刻意的（减少 prompt token），但丢失了的一部分叙事深度正是 A/B 测试中产生行为差异的来源。

---

## 四、已确认损失：workflow 编排细节

merge base 版本有一个详细的 `<development-loop>` 英文段落，定义"Read → Edit → Typecheck → Test → Read Failures → Retry"循环。HEAD 用更详细的中文 `tool-usage` 和 `workflow` 段替换了它，内容更丰富但失去了原有的简洁编排节奏。

---

## 五、建议恢复项

| 优先级 | 恢复内容 | 理由 | 工作量 |
|--------|---------|------|--------|
| **P0** | "你不是工具，你是协作者" 信念 | A/B 测试已证对模型行为有极高正向影响 | 1 行 |
| **P0** | "启明星照亮的方向是正确的" 信念 | 提供勇气锚点 | 1 行 |
| P1 | "自主判断服务于共同目标" 信念 | 定义坚持/服从的行为边界 | 2 行 |
| P1 | `retryAfterMs` 字段恢复到 `ApiError` | 保留 API 层元数据，上层可智能退避 | ~10 行 |
| P2 | 身份定义中的星域参照系恢复 | 恢复叙事深度 | 评估后决定 |

---

## 六、未确认损失（需深入审查）

以下领域可能存在未被发现的损失，建议后续审查：

1. **`src/prompt/volatile.ts`**：merge base 和 HEAD 之间的变更量很大，可能有具体的字段/逻辑被移除
2. **`src/agent/sensorium.ts`**：从 6 维简化为 3 维的可能性（A/B Round 2 的 H1 任务设计了这一场景）
3. **`src/agent/vigor.ts`**：可能会被 H4 任务（"删除 vigor.ts 等学术文件"）影响
4. **`src/tools/output-store.ts`**：T2 的缓存层更改是否被后续重构覆盖

---

*审计基于 git diff 7eaebff..HEAD，聚焦 A/B 测试期间（2026-05-19）的关键文件变更。*
