# 星域路由接入 AgentLoop 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `matchDomain()` 接入实际运行时，使星域声明在每次任务执行时自动注入 volatile context

**架构：** 在 session/turn 开始时，从用户最近的消息中提取任务描述，调用 `matchDomain()` 路由到星域，将结果设置到 `VolatileContext.activeDomain`。一旦路由确定，同一 session 内不再切换（session 粒度绑定，避免经验碎片化）。

**前置依赖：** `feat/tianshu-star-soul` 分支已提交（star-domain.ts、volatile.ts 的 activeDomain 字段已就绪）

**预计改动：** ~30 行代码，1 个新测试文件

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/star-domain.ts` | 新增 `buildActiveDomain()` 辅助函数 | 修改 |
| `src/agent/__tests__/star-domain.test.ts` | 新增 buildActiveDomain 测试 | 修改 |
| `src/agent/loop.ts` 或 `src/agent/session-context.ts` | 在 turn 构建 volatile context 时注入 activeDomain | 修改 |

---

### 任务 1：新增 buildActiveDomain 辅助函数

**文件：**
- 修改：`src/agent/star-domain.ts`
- 修改：`src/agent/__tests__/star-domain.test.ts`

- [ ] **步骤 1：在测试中新增 buildActiveDomain 用例**

```typescript
// 追加到 src/agent/__tests__/star-domain.test.ts
import { buildActiveDomain } from '../star-domain.js'

describe('buildActiveDomain', () => {
  it('returns domain info for matched task', () => {
    const result = buildActiveDomain('探索新的认证方案')
    assert.ok(result)
    assert.equal(result!.name, '破军')
    assert.ok(result!.volatileBlock.includes('破军'))
    assert.ok(result!.motto)
  })

  it('returns null for ambiguous task', () => {
    assert.equal(buildActiveDomain('帮我看看'), null)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/star-domain.test.ts`
预期：FAIL — buildActiveDomain is not a function

- [ ] **步骤 3：实现 buildActiveDomain**

在 `src/agent/star-domain.ts` 末尾追加：

```typescript
/**
 * Given a task description, return the activeDomain object
 * suitable for injection into VolatileContext, or null if no match.
 */
export function buildActiveDomain(
  taskDescription: string,
): { name: string; volatileBlock: string; motto: string } | null {
  const id = matchDomain(taskDescription)
  if (!id) return null
  const domain = STAR_DOMAINS[id]
  return { name: domain.name, volatileBlock: domain.volatileBlock, motto: domain.motto }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/star-domain.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/star-domain.ts src/agent/__tests__/star-domain.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add buildActiveDomain helper for volatile injection

Converts matchDomain result into the shape expected by
VolatileContext.activeDomain. Returns null for ambiguous tasks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### 任务 2：接入 AgentLoop 的 volatile context 构建

**文件：**
- 修改：构建 VolatileContext 的位置（需要先确认是 `loop.ts` 还是其他文件）

**前置调查：** 执行者需要先 grep 找到 `buildVolatileBlock` 或 `VolatileContext` 被构造的位置：

```bash
grep -rn "VolatileContext\|activeDomain\|buildStableVolatile\|buildLatestTurn" src/agent/ src/prompt/ --include="*.ts" | grep -v test | grep -v ".d.ts"
```

- [ ] **步骤 1：定位 volatile context 构建点**

找到 `VolatileContext` 对象被组装的位置。通常在 loop.ts 或 session 管理代码中，形如：

```typescript
const volatileCtx: VolatileContext = {
  cwd,
  gitStatus,
  workingSet,
  // ... 其他字段
}
```

- [ ] **步骤 2：在构建点注入 activeDomain**

在该位置添加星域路由逻辑。策略：
- 从用户最近一条消息中提取文本作为 taskDescription
- 首次路由后缓存结果，同一 session 内不再重新路由（session 粒度绑定）

```typescript
import { buildActiveDomain } from './star-domain.js'

// 在 session 级别缓存（不是每轮重新路由）
let sessionDomain: { name: string; volatileBlock: string; motto: string } | null | undefined = undefined

// 在构建 VolatileContext 时：
if (sessionDomain === undefined) {
  // 首次路由：从用户最近消息提取任务描述
  const lastUserMsg = messages.findLast(m => m.role === 'user')
  const taskText = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : ''
  sessionDomain = buildActiveDomain(taskText)
}

const volatileCtx: VolatileContext = {
  // ... 现有字段
  activeDomain: sessionDomain,
}
```

注意：
- `sessionDomain` 的生命周期应与 session 一致（session 结束时重置）
- 如果找不到合适的 session 级缓存位置，可以用模块级变量 + session reset hook

- [ ] **步骤 3：typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 4：运行现有测试确认无回归**

运行：`npx tsx --test src/agent/__tests__/*.test.ts src/prompt/__tests__/*.test.ts`
预期：全部 PASS

- [ ] **步骤 5：手动验证**

启动 rivet，输入一个明确的探索类任务（如"探索一个新的缓存方案"），检查 volatile context 输出中是否包含 `<star-domain name="破军" ...>`。

验证方式：在 `buildVolatileBlockInternal` 中临时加 `console.log` 或检查 telemetry 输出。

- [ ] **步骤 6：Commit**

```bash
git add <modified files>
git commit -m "$(cat <<'EOF'
feat(agent): wire star domain routing into volatile context

On first user message in a session, matchDomain determines the active
star domain. Result is cached for the session lifetime (no mid-session
switching to avoid experience fragmentation). Domain declaration is
injected into latest-turn volatile context as <star-domain> XML.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### 任务 3：集成验证

- [ ] **步骤 1：全量 typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 2：全量测试**

运行：`npx tsx --test src/**/__tests__/*.test.ts`
预期：全部 PASS

- [ ] **步骤 3：端到端验证**

启动 rivet，分别输入三类任务，确认星域路由正确：
- "探索一个新的 WebSocket 方案" → 应看到破军域声明
- "修复这个内存泄漏" → 应看到天府域声明
- "按计划实现用户注册功能" → 应看到天梁域声明
- "帮我看看这个" → 应无星域声明（null）

---

## 注意事项

- 任务 2 的具体实现取决于 volatile context 在哪里被构建——执行者需要先 grep 定位
- session 粒度绑定是设计决策：避免一个 session 内频繁切换星域导致经验碎片化
- 如果 loop.ts 中没有合适的 session 级状态，可以在 `RuntimeHookContext` 或 `SessionContext` 中加一个 `activeDomain` 字段
- 不要在 `buildStableVolatileBlock` 中注入星域（GPT 5.5 已正确处理了这一点）
