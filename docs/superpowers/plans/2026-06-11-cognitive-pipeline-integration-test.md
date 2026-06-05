# 认知管线集成测试 — 端到端质量验证

> 评估 affordance + free energy engine + sensorimotor 完整数据流
> 预估：~1.5h，2 个文件

## 背景

具身认知闭环 + 自由能引擎的 7 个核心文件已全部就位。但缺少一个端到端集成测试来验证完整数据流是否正确运转。

当前状态：各子系统有独立单元测试（affordance 16个、policy 8个、prediction-error 12个），但没有测试验证它们串联后的行为。

## 目标

创建一个单一集成测试，模拟完整 agent turn，验证：

```
工具执行 → recordPrediction → computeEFE → selectPolicy
         → computeAffordanceScores → renderAffordanceHint
         → renderPolicyGuidance → context 注入
         → 下一轮 LLM 接收正确的 <affordance-hint> + <policy-guidance> XML
```

## 实现

### 文件：`src/agent/__tests__/cognitive-pipeline.test.ts`（新建）

```typescript
describe('Cognitive Pipeline — end-to-end', () => {
  it('generates affordance hint after tool execution', () => {
    // 1. 模拟一次成功的工具执行（read_file）
    // 2. recordPrediction(true)
    // 3. 验证 computeEFE 产生合理的 epistemic > pragmatic
    // 4. 验证 renderAffordanceHint 包含 "Prefer epistemic tools"
  })

  it('shifts to instrumental after consecutive successes', () => {
    // 1. 连续 5 次成功的工具执行
    // 2. 验证 policy guidance 开始偏好 instrumental tools
    // 3. 验证 <policy-guidance> XML 块格式正确
  })

  it('adapts affordance from sensorimotor history', () => {
    // 1. 记录 10 次 bash 失败（模拟糟糕的 bash 使用）
    // 2. 调用 adaptAffordanceFromHistory
    // 3. 验证 bash 的 instrumental 权重下降
    // 4. 验证 renderAffordanceHint 不再推荐 bash 作为 top instrumental
  })

  it('produces valid XML blocks for DeepSeek consumption', () => {
    // 1. 完整生成 <affordance-hint> + <policy-guidance>
    // 2. 验证 XML 格式正确（无未转义字符、闭合标签）
    // 3. 验证两个块的总 token 数 < 500（不占太多 context）
  })
})
```

### 文件：`src/agent/__tests__/cognitive-pipeline.test.ts` — 辅助工具

```typescript
// Mock 辅助函数：快速构建 AffordanceState
function mockState(overrides?: Partial<AffordanceState>): AffordanceState

// Mock 辅助函数：快速构建 PredictionAccumulator
function mockAccumulator(predictions: boolean[]): PredictionAccumulator
```

## 验收标准

- [ ] 4 个集成测试全部通过
- [ ] 验证 affordance hint XML 格式符合 schema
- [ ] 验证 policy guidance XML 格式符合 schema
- [ ] 验证 sensorimotor adaptation 闭环（记录→适应→输出变化）
- [ ] typecheck 通过
