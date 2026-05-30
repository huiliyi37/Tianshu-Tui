## 已知不可行的测试路径（经验教训）

写复杂测试前先做 30 秒探针验证。以下是踩过的坑和对应替代方案：

| 死胡同 | 为什么不可行 | 替代方案 |
|--------|-------------|---------|
| `React.createElement(memoComponent)` 拿内部 JSX | createElement 不调用 render 函数，返回的 element tree 没有子节点 | `readFileSync` 做源码级结构断言（见 `stream.test.tsx` S7 contract） |
| 依赖 hooks（useViewportLines 等）的 Ink 组件在框架外渲染 | hooks 需要 React reconciler 上下文，脱离 Ink runtime 必崩 | 提取纯逻辑函数测试（如 `viewportLines()`），或源码级契约测试 |
| 需要第三方库（ink-testing-library）才能 render | 项目未安装该库，不能假设可用 | 先用 `node -e` 验证库是否可用；不可用时退回源码断言或纯函数测试 |

### 源码断言模式示例

```typescript
import { readFileSync } from 'node:fs'
const source = readFileSync(resolve(__dirname, '../stream.tsx'), 'utf-8')

it('cursor is sibling of Markdown, not inlined', () => {
  const lines = source.split('\n')
  const cursorLine = lines.find(l => l.includes('▊'))
  assert.ok(cursorLine?.includes('<Text'), 'cursor must be a <Text> element')
  assert.ok(!cursorLine?.includes('<Markdown'), 'cursor must NOT be inside Markdown')
})
```

---

### 2026-05-21 — session c50ca31c

**Modified** (1): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/aggregation-profile.test.ts
**Read** (2): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/aggregation.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/worker-evidence.ts
**Tests**: ✅ 3 passed, 0 failed (npx tsx --test src/agent/__tests__/aggregation-profile.test.ts)
**Tools used**: read_file×4, bash×2, todo×1, write_file×1, run_tests×1
- Decision: use bash to read it

### 2026-05-20 — session c6794622

**Modified** (5): /Users/banxia/app/deepseek-tui/opencode-tui/src/compact/__tests__/compact-thresholds.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/__tests__/compact-policy.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/compact/__tests__/auto.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/__tests__/create-agent-config.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/compact/constants.ts
**Read** (9): /Users/banxia/app/deepseek-tui/opencode-tui/src/compact/__tests__/compact-thresholds.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/compact/constants.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/context/compact-policy.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/compact/__tests__/auto.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/compaction-controller.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/create-agent-config.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/tool-pipeline.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/compact/auto.ts +1 more
**Tests**: ❌ 0 passed, 0 failed (npx tsx --test src/compact/__tests__/compact-thresholds.test.ts src/context/__tests__/compact-policy.test.ts src/compact/__tests__/auto.test.ts src/agent/__tests__/compaction-controller.test.ts src/__tests__/create-agent-config.test.ts)
**Tools used**: read_file×11, edit_file×10, bash×6, diff×4, todo×3, git×2, grep×2, run_tests×1, inspect_project×1

### 2026-05-18 — session 0bba0331

**Modified** (4): /Users/banxia/app/deepseek-tui/opencode-tui/src/workflows/ecosystem-workflows.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/workflows/__tests__/ecosystem-workflows.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/tui/slash-commands.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/tui/__tests__/slash-commands.test.ts
**Read** (4): /Users/banxia/app/deepseek-tui/opencode-tui/src/tui/slash-commands.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/tui/__tests__/slash-commands.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/__tests__/commands-loader.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/tui/app.tsx
**Tests**: ⚠️ unverified
**Tools used**: read_file×6, edit_file×6, todo×5, git×4, bash×4, diff×4, write_file×2, glob×1, grep×1

### 2026-05-18 — session 87b03c0c

**Modified** (3): /Users/banxia/app/deepseek-tui/opencode-tui/src/__tests__/auto-reasoning.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/__tests__/create-agent-config.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/loop.test.ts
**Read** (1): /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/loop.test.ts
**Tests**: ⚠️ unverified
**Tools used**: bash×7, todo×5, git×4, diff×4, edit_file×4, read_file×2, grep×1

### 2026-05-17 — session 4d28ab4c

**Modified** (14): /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/__tests__/types.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/types.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/__tests__/store.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/store.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/__tests__/report.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/report.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/__tests__/task-suite.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/benchmark/task-suite.ts +6 more
**Read** (6): /Users/banxia/app/deepseek-tui/opencode-tui/docs/superpowers/plans/2026-05-17-rivet-agent-parity-roadmap.md, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/evidence.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/trace-store.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/api/provider.ts, /Users/banxia/app/deepseek-tui/opencode-tui/src/agent/__tests__/evidence.test.ts, /Users/banxia/app/deepseek-tui/opencode-tui/package.json
**Tests**: ⚠️ unverified
**Tools used**: bash×17, write_file×13, read_file×7, todo×3, edit_file×3, glob×1
- Decision: create the test (TDD step 1) and types in parallel

