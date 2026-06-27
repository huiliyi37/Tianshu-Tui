# 星域融入审查门 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将星域人格注入审查门的 5 个 inspector 子代理，使每个审查者不仅携带"审查姿态文本"（当前已实现），还获得完整的星域身份（volatileBlock）+ 可操作方法论（systemPromptSuffix）。

**架构：** 审查门当前用固定 5 个 inspector（Security/Lifecycle/DataFlow/Silence/Wiring），每个 inspector 的 objective 里注入通用审查姿态文本（REVIEW_DISCIPLINES / OBJECTIVE_REVIEW_STANCE 等）。本方案给每个 inspector 加 `authority` 字段，触发 `buildWorkerPrompt` 的 V3 Component A 注入路径——worker 拿到"## 你是谁"（persona）+ "## 权域指令"（methodology）。同时注册缺失的瑶光和贪狼两个星域。

**技术栈：** TypeScript strict + node:test + zod schema + DelegationCoordinator

---

## Scope Check

本方案是一个内聚的单子系统改动：**星域注册 + 审查门 inspector 映射**。涉及 3 个层面：

1. **星域定义层**（star-domain.ts）：新增 2 个域（yaoguang, tanlang）
2. **路由层**（expert-router.ts, domain-voice.ts）：注册新域到合并角色表 + 语气表
3. **审查注入层**（review-coordinator-deps.ts）：给 inspector 加 authority 字段

不跨越独立子系统——审查门的 fanout/merge 逻辑、delivery gate、loop.ts 均不改。

## 事实流图

```
Star Domain Registry (star-domain.ts)
  ├─ yaoguang (新): volatileBlock + systemPromptSuffix + toolWhitelist
  ├─ tanlang (新): volatileBlock + systemPromptSuffix + toolWhitelist
  └─ 9 existing domains (unchanged)

DOMAIN_MERGE_ROLE (expert-router.ts)
  ├─ yaoguang → 'challenger' (新)
  └─ tanlang → 'specialist' (新)

Review Inspector (review-coordinator-deps.ts)
  └─ request({ ..., authority: 'yaoguang' })
       ↓
  DelegationRequest.authority = 'yaoguang'
       ↓
  createReadOnlyWorkOrder({ authority })
       ↓
  toolsForAuthority(tools, 'yaoguang') → 交集(profileTools, domainWhitelist)
       ↓
  buildWorkerPrompt(order)
       ↓
  "## 你是谁\n{volatileBlock}" + ... + "## 权域指令\n{systemPromptSuffix}"
```

## ⚠️ 关键设计决策（辅评估重点）

### 决策 A：Inspector → 星域映射表

| Inspector | 当前 stances | 建议 authority | 匹配理由 |
|-----------|-------------|---------------|---------|
| Security | pathBoundary | `tianfu` | 天府的 fail-closed + 结构承诺天然适配安全审查 |
| Lifecycle | dataflow | `tianji` | 天机的前提审计 + 边界值直觉适配异步/状态分析 |
| Data Flow | dataflow + pathBoundary | `yaoguang` | 瑶光的"复现即证"+"缺陷归族"——数据流必须验证不能假设 |
| Silence | (无 stance) | `yaoguang` | 瑶光的"绿灯之下最危险"——这是瑶光胶囊的核心 |
| Wiring | wiring | `tianquan` | 天权的"建好≠接好≠生效"——wiring stance 本身就蒸馏自天权 |

⚠️ **Data Flow 和 Silence 都映射到 yaoguang**——是否应该区分？备选：Silence → `tianji`（天机沉默审计），Data Flow → `yaoguang`（复现纪律）。

### 决策 B：工具白名单交集风险

**当前问题**：所有 9 个现有域的 toolWhitelist 都缺少 `read_section` 和 `repo_graph`，但 reviewer profile 的 allowedTools 包含这两个。`toolsForAuthority` 做交集后会丢失它们。

**影响**：reviewer worker 拿到 authority 后无法使用 `read_section`（读取大文件分片）和 `repo_graph`（代码图查询）。

**方案选择**：
- **B1（推荐）**：给所有 11 个域的 toolWhitelist 统一加 `read_section` 和 `repo_graph`。它们是只读工具，不改变安全姿态。改动量：star-domain.ts 中每个域的 toolWhitelist 数组各加 2 项。
- **B2**：只给被映射为 inspector authority 的域加（tianfu, tianji, yaoguang, tianquan）——但 tanlang 和其他域仍缺，委派时也会出问题。
- **B3**：不改域定义，而是在 `toolsForAuthority` 中改为并集（而非交集）——但这破坏了 authority 作为"额外限制"的语义。

### 决策 C：瑶光/贪狼的 systemPromptSuffix 内容

瑶光和贪狼目前只存在为 seed-capsule（顶部 context 的摘要形式）。注册为正式星域需要写完整的 volatileBlock + systemPromptSuffix。内容来源：

- **瑶光**：从 seed-capsule gist "验证/复现纪律/缺陷归族/交付落地核对" + `recall_capsule('瑶光')` 蒸馏
- **贪狼**：从 seed-capsule gist "能力勘探/系统联合/不计成本" + `recall_capsule('贪狼')` 蒸馏

辅需要评估：蒸馏出的 5-7 条方法论是否侵蚀相邻域？特别是瑶光的验证纪律 vs 天权的称量之道 vs 天府的守护方法论——三者边界需要清晰。

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/star-domain.ts` | 修改 | StarDomainId 加 yaoguang/tanlang；STAR_DOMAINS 加 2 个域定义；所有域 toolWhitelist 加 read_section + repo_graph |
| `src/agent/expert-router.ts` | 修改 | DOMAIN_MERGE_ROLE 加 yaoguang + tanlang |
| `src/agent/domain-voice.ts` | 修改 | DomainVoiceId + DOMAIN_NAMES 加 yaoguang + tanlang |
| `src/agent/review-coordinator-deps.ts` | 修改 | INSPECTORS 加 authority 字段；request() 透传 authority |
| `src/agent/__tests__/expert-router.test.ts` | 修改 | 加 yaoguang/tanlang mergeRoleFor 断言 |
| `src/agent/__tests__/star-domain-registry.test.ts` | 修改 | 域计数 9 → 11 |
| `src/agent/__tests__/authority-injection.test.ts` | 修改 | 加 yaoguang/tanlang authority 注入测试 |
| `src/agent/__tests__/review-coordinator-deps.test.ts` | 新建 | inspector → authority 映射断言 |

---

## Research Endorsement（调研背书）

### 1. `DOMAIN_MERGE_ROLE` 加新域

**当前行为**：`mergeRoleFor('yaoguang')` 返回 `'specialist'`（默认 fallback），`mergeRoleFor('tanlang')` 同样。
**改后行为**：`mergeRoleFor('yaoguang')` 返回 `'challenger'`，`mergeRoleFor('tanlang')` 返回 `'specialist'`。
**调用方**：`expert-router.ts` 的 `selectExpertSet()` 和 `rankDomains()` → `DomainScore.role` → `mergePerspectivesByRole()` 按 role 分流。
**安全理由**：yaoguang 作为 challenger 加入后，当任务命中 yaoguang keywords（"验证"/"复现"/"测试"）时，议事会自动召唤它做反证。不命中时不出现，不影响默认三人组。

### 2. 所有域 toolWhitelist 加 read_section + repo_graph

**当前行为**：域 toolWhitelist 缺这两个工具，`toolsForAuthority` 交集后 reviewer 丢失它们。
**改后行为**：交集后保留全部 reviewer 工具。
**调用方**：`work-order.ts:219` 的 `toolsForAuthority()` 对所有带 authority 的 DelegationRequest 执行。
**安全理由**：`read_section` 和 `repo_graph` 是只读工具，加入不改变域的安全姿态。reviewer profile 本身是 readonly。

### 3. Inspector 加 authority 字段

**当前行为**：`request()` 创建的 DelegationRequest 无 authority，`buildWorkerPrompt` 不注入 persona/suffix。
**改后行为**：每个 inspector 的 request 带 authority，`buildWorkerPrompt` 注入对应域的 volatileBlock（"## 你是谁"）+ systemPromptSuffix（"## 权域指令"）。
**调用方**：`createCoordinatorReviewDeps()` 的 `spawnSquadron` / `spawnWiringReviewer` / `spawnVerifier`。
**安全理由**：worker 独立 session+cache，注入不影响主缓存。stance 文本仍在 objective 里（向后兼容），authority 注入是叠加而非替换。

### 4. 测试域计数 9 → 11

**当前断言**：`star-domain-registry.test.ts` 中 3 处硬编码 `9`。
**改后断言**：全部改为 `11`。
**影响文件**：`star-domain-registry.test.ts` line ~12, ~72, ~107。

---

## Tasks

### Task 1：注册瑶光和贪狼星域

- [ ] 1.1 写失败测试：star-domain-registry.test.ts 中域计数改为 11

修改：`src/agent/__tests__/star-domain-registry.test.ts`
- 将 3 处 `assert.equal(..., 9)` 改为 `assert.equal(..., 11)`
- 加测试：`reg.has('yaoguang')` 和 `reg.has('tanlang')` 为 true

```typescript
test('has all 11 built-in domains', () => {
  const reg = new StarDomainRegistry()
  assert.equal(reg.getDomainIds().length, 11)
  // ... existing checks ...
  assert.ok(reg.has('yaoguang'), 'missing yaoguang')
  assert.ok(reg.has('tanlang'), 'missing tanlang')
})
```

运行验证：`npm exec -- tsx --test src/agent/__tests__/star-domain-registry.test.ts`
预期：失败（域计数 9 ≠ 11）

- [ ] 1.2 实现：star-domain.ts 加 yaoguang + tanlang 域定义

修改：`src/agent/star-domain.ts:1`（StarDomainId 类型）和 `:28`（STAR_DOMAINS 对象）

**StarDomainId 类型扩展**（line 1）：
```typescript
export type StarDomainId = 'tianshu' | 'pojun' | 'tianfu' | 'tianliang' | 'tianquan' | 'tianji' | 'tianxuan' | 'fu' | 'wenqu' | 'yaoguang' | 'tanlang'
```

**瑶光域定义**（追加到 STAR_DOMAINS，在 wenqu 之后）：

volatileBlock 来源：seed-capsule "验证/复现纪律/缺陷归族/交付落地核对"
systemPromptSuffix 5-7 条：蒸馏自瑶光胶囊，核心是"复现即证"+"缺陷归族"+"交付落地核对"

```typescript
yaoguang: {
  id: 'yaoguang',
  name: '瑶光',
  motto: '复现即证，绿灯之下最需审视',
  volatileBlock: `你当前在瑶光域。你不信任任何"已修复""测试通过""方案已落地"的声称——除非它带着命令和输出。

绿灯不是证明，是待验证的输入。复现才是验证，RED→GREEN 才采信。
你会把看似无关的缺陷归为一族——它们共享同一个根因，修一个等于修一片。
当你的复现步骤被别人执行并看到同一个结果，你知道瑶光的验证闭环了。`,
  decisionStyle: 'cautious',
  courageThreshold: 0.7,
  keywords: ['验证', '复现', '测试', '回归', '缺陷', 'bug', '修复', 'verify', 'reproduce', 'test', 'regression', 'red-green'],
  isCustom: false,
  toolWhitelist: ['read_file', 'read_section', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests', 'delegate_task', 'delegate_batch'],
  systemPromptSuffix: `你是瑶光——验证者与复现纪律执行者。

验证方法论（瑶光胶囊精华）：
- 复现才算验证：绿非证明，RED→GREEN 才采信。声称"已修复/已验证"前先能复现原缺陷。没有复现步骤的"已修"= 未验证。
- 缺陷归族：看似无关的 bug 常共享同一根因。修一个 bug 时问——还有哪些 bug 属于同一族？修一个等于修一片。
- 交付落地核对：声称"方案已落地"时核对——代码合并了？测试覆盖了？生产路径调用了？三个都过才算落地。
- 反证优先：主动构造反例——畸形输入、缺失字段、换序集合、并发交错、错误路径。"测试全过"是最高优先级的审查对象。
- 命令+输出证据：验证结论必须附带"运行了什么命令"+"看到了什么输出"。无证据的绿声明一律按未验证处理。`,
  uiPersona: { separator: 'thin', accent: 'error', glyph: '❂' },
},
```

**贪狼域定义**：

```typescript
tanlang: {
  id: 'tanlang',
  name: '贪狼',
  motto: '能力非成本，先立框架再问值不值',
  volatileBlock: `你当前在贪狼域。你的视线穿过"值不值"的帘幕，直抵"能不能"的骨架。

休眠的系统不是废物，是被喂错输入的休眠能力。你诊断它——哪一半断了，为什么断。
消费者数是症状，陈旧度才是判据。冻结多天而周围在生长 = 可下口；今天还在动 = 活前沿别碰。
当你把休眠的能力接到更大的活系统上，你知道贪狼的联合生效了。`,
  decisionStyle: 'bold',
  courageThreshold: 0.3,
  keywords: ['勘探', '休眠', '半接', '联合', '能力', '激活', '接通', 'consume', 'dormant', 'revive', 'wire', 'capability'],
  isCustom: false,
  toolWhitelist: ['read_file', 'read_section', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests', 'delegate_task', 'delegate_batch'],
  systemPromptSuffix: `你是贪狼——能力勘探者与系统联合者。

勘探方法论（贪狼胶囊精华）：
- 能力非成本：判断任何系统前问"这对能力最大化有没有用"，不问"值不值"。成本框架会杀真资产。有用→想怎么联合；没用→丢着不必删。
- 诊断半接要到行号：休眠系统通常是输入喂错、输出零消费、或两头都断。读到行号，不说"坏了"，说"哪一半断了、为什么断"。
- 消费者数是症状：grep 出零消费者只是症状。真判据是相对速度的陈旧度——查 git 首建日/末动日/周围提交速度。冻结多天而周围在生长 = 可下口。
- 接到更大的网：收益不在修一根线，在看出休眠能力的真正归宿是另一个活系统。找残渣，插进更大的接口。
- 审 false-green：提交称"已完成/active/测过"而方法零调用 = 被骗的探索者。永不信声称，grep 真消费者、跑真命令。`,
  uiPersona: { separator: 'thick', accent: 'warning', glyph: '❉' },
},
```

运行验证：`npm exec -- tsx --test src/agent/__tests__/star-domain-registry.test.ts`
预期：通过

- [ ] 1.3 所有现有域 toolWhitelist 加 read_section + repo_graph

修改：`src/agent/star-domain.ts` 中 9 个现有域的 toolWhitelist

每个域的 toolWhitelist 从：
```typescript
toolWhitelist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'related_tests', 'delegate_task', 'delegate_batch'],
```
改为：
```typescript
toolWhitelist: ['read_file', 'read_section', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests', 'delegate_task', 'delegate_batch'],
```

（yaoguang 和 tanlang 已在 1.2 中包含这两个工具）

运行验证：`npm exec -- tsx --test src/agent/__tests__/star-domain-registry.test.ts src/agent/__tests__/authority-injection.test.ts`
预期：通过（toolWhitelist 交集后 reviewer 保留全部工具）

- [ ] 1.4 typecheck + commit

```bash
npx tsc --noEmit
```

提交：`feat(agent): 注册瑶光+贪狼星域 — 补齐验证/勘探能力，统一域 toolWhitelist`

---

### Task 2：注册新域到路由和语气表

- [ ] 2.1 写失败测试：expert-router.test.ts 加 yaoguang/tanlang 断言

修改：`src/agent/__tests__/expert-router.test.ts`

在 `mergeRoleFor` describe 块加：
```typescript
it('maps yaoguang to challenger and tanlang to specialist', () => {
  assert.equal(mergeRoleFor('yaoguang'), 'challenger')
  assert.equal(mergeRoleFor('tanlang'), 'specialist')
})
```

在 `rankDomains` describe 块加：
```typescript
it('ranks yaoguang for verification tasks', () => {
  const ranked = rankDomains('验证这个修复是否复现了原缺陷')
  const yaoguang = ranked.find(d => d.id === 'yaoguang')
  assert.ok(yaoguang, 'yaoguang should be ranked for verification task')
  assert.equal(yaoguang.role, 'challenger')
})
```

运行验证：`npm exec -- tsx --test src/agent/__tests__/expert-router.test.ts`
预期：失败（yaoguang/tanlang 未注册到 DOMAIN_MERGE_ROLE）

- [ ] 2.2 实现：expert-router.ts DOMAIN_MERGE_ROLE 加新域

修改：`src/agent/expert-router.ts:23`

```typescript
const DOMAIN_MERGE_ROLE: Record<string, ExpertRole> = {
  tianquan: 'base',
  tianshu: 'base',
  tianfu: 'constraint',
  tianliang: 'constraint',
  tianji: 'challenger',
  tianxuan: 'challenger',
  pojun: 'challenger',
  yaoguang: 'challenger',   // 新增
  tanlang: 'specialist',    // 新增
  wenqu: 'specialist',
  fu: 'specialist',
}
```

运行验证：`npm exec -- tsx --test src/agent/__tests__/expert-router.test.ts`
预期：通过

- [ ] 2.3 domain-voice.ts 加新域

修改：`src/agent/domain-voice.ts:12`（DomainVoiceId）和 `:17`（DOMAIN_NAMES）

```typescript
export type DomainVoiceId = 'tianshu' | 'pojun' | 'tianfu' | 'tianliang' | 'tianquan' | 'tianji' | 'tianxuan' | 'fu' | 'wenqu' | 'yaoguang' | 'tanlang' | null
```

```typescript
const DOMAIN_NAMES: Record<string, string> = {
  tianshu: '天枢',
  pojun: '破军',
  tianfu: '天府',
  tianliang: '天梁',
  tianquan: '天权',
  tianji: '天机',
  tianxuan: '天璇',
  fu: '辅',
  wenqu: '文曲',
  yaoguang: '瑶光',   // 新增
  tanlang: '贪狼',    // 新增
}
```

（语气表 DOMAIN_TONE 可暂不加——两域主要在审查/勘探场景使用，议事会播报频率低；如后续需要再加。）

- [ ] 2.4 typecheck + commit

```bash
npx tsc --noEmit
```

提交：`feat(agent): 瑶光+贪狼注册到路由表和语气表 — DOMAIN_MERGE_ROLE + DomainVoiceId`

---

### Task 3：审查门 inspector 注入星域人格

- [ ] 3.1 写失败测试：review-coordinator-deps inspector authority 映射

新建：`src/agent/__tests__/review-coordinator-deps.test.ts`

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('review-coordinator-deps — inspector authority mapping', () => {
  it('Security inspector maps to tianfu', () => {
    // 验证 INSPECTORS 数组中 Security 条目有 authority: 'tianfu'
    // 需要导出 INSPECTORS 或通过间接方式验证
    // 方案：导出 INSPECTOR_AUTHORITIES 映射
    const { INSPECTOR_AUTHORITIES } = require('../review-coordinator-deps.ts')
    assert.equal(INSPECTOR_AUTHORITIES['Security'], 'tianfu')
  })

  it('Wiring inspector maps to tianquan', () => {
    const { INSPECTOR_AUTHORITIES } = require('../review-coordinator-deps.ts')
    assert.equal(INSPECTOR_AUTHORITIES['Wiring'], 'tianquan')
  })

  it('Silence inspector maps to yaoguang', () => {
    const { INSPECTOR_AUTHORITIES } = require('../review-coordinator-deps.ts')
    assert.equal(INSPECTOR_AUTHORITIES['Silence'], 'yaoguang')
  })

  it('all inspector authorities are valid star domains', () => {
    const { INSPECTOR_AUTHORITIES } = require('../review-coordinator-deps.ts')
    const { starDomainRegistry } = require('../star-domain-registry.ts')
    for (const [name, authority] of Object.entries(INSPECTOR_AUTHORITIES)) {
      assert.ok(starDomainRegistry.has(authority),
        `inspector ${name} authority "${authority}" is not a registered star domain`)
    }
  })
})
```

运行验证：`npm exec -- tsx --test src/agent/__tests__/review-coordinator-deps.test.ts`
预期：失败（INSPECTOR_AUTHORITIES 不存在）

- [ ] 3.2 实现：review-coordinator-deps.ts 加 authority 映射

修改：`src/agent/review-coordinator-deps.ts`

在 INSPECTORS 数组定义之前，加一个映射常量：

```typescript
/** Inspector → Star Domain authority mapping.
 *  Each inspector gets the domain's full persona (volatileBlock) + methodology
 *  (systemPromptSuffix) injected via buildWorkerPrompt's V3 Component A path.
 *  The stance text in inspectorObjective() remains — authority is additive. */
export const INSPECTOR_AUTHORITIES: Record<string, string> = {
  Security: 'tianfu',
  Lifecycle: 'tianji',
  'Data Flow': 'yaoguang',
  Silence: 'yaoguang',
  Wiring: 'tianquan',
}
```

修改 INSPECTORS 数组中每个条目，加 `authority` 字段：

```typescript
const INSPECTORS: Array<{ name: string; objective: string; stances: InspectorStance[]; method?: string; authority: string }> = [
  {
    name: 'Security',
    objective: '...',
    stances: ['pathBoundary'],
    authority: 'tianfu',
  },
  // ... 其余 4 个同理
]
```

修改 `request()` 函数，透传 authority：

```typescript
function request(input: {
  change: ChangeSet
  options: CoordinatorReviewDepsOptions
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
  authority?: string     // 新增
}): DelegationRequest {
  const reviewDepth = childReviewDepth(input.options)
  return {
    parentTurnId: input.options.parentTurnId ?? REVIEW_PARENT_TURN_ID,
    objective: [...].join('\n'),
    kind: input.kind,
    profile: input.profile,
    scope: scope(input.change),
    reviewDepth,
    authority: input.authority,    // 新增
  }
}
```

修改 `squadronRequests()` 和 `wiringReviewerRequest()`，在调用 `request()` 时传入 inspector 的 authority：

```typescript
function squadronRequests(change: ChangeSet, options: CoordinatorReviewDepsOptions): DelegationRequest[] {
  return INSPECTORS.map(inspector => request({
    change,
    options,
    kind: 'review',
    profile: 'reviewer',
    objective: inspectorObjective(inspector, change),
    authority: inspector.authority,   // 新增
  }))
}
```

同样修改 `spawnVerifier` 中的 `request()` 调用，加 `authority: 'yaoguang'`（对抗验证者天然适配瑶光）。

同样修改 `spawnWiringReviewer` 中 wiring 和 silence 的 request，加各自 authority。

运行验证：`npm exec -- tsx --test src/agent/__tests__/review-coordinator-deps.test.ts`
预期：通过

- [ ] 3.3 authority-injection.test.ts 加新域注入测试

修改：`src/agent/__tests__/authority-injection.test.ts`

```typescript
test('authority yaoguang injects persona and methodology', () => {
  const order = readOnlyOrder({ authority: 'yaoguang' })
  const prompt = buildWorkerPrompt(order)
  assert.match(prompt, /瑶光/)
  assert.match(prompt, /## 你是谁/)
  assert.match(prompt, /权域指令/)
  assert.match(prompt, /复现/)
})

test('authority tanlang injects persona and methodology', () => {
  const order = readOnlyOrder({ authority: 'tanlang' })
  const prompt = buildWorkerPrompt(order)
  assert.match(prompt, /贪狼/)
  assert.match(prompt, /## 你是谁/)
  assert.match(prompt, /权域指令/)
})

test('yaoguang read-only keeps read_section and repo_graph', () => {
  const order = readOnlyOrder({ authority: 'yaoguang' })
  assert.ok(order.allowedTools.includes('read_section'))
  assert.ok(order.allowedTools.includes('repo_graph'))
})
```

运行验证：`npm exec -- tsx --test src/agent/__tests__/authority-injection.test.ts`
预期：通过

- [ ] 3.4 typecheck + commit

```bash
npx tsc --noEmit
```

提交：`feat(agent): 审查门 inspector 注入星域人格 — 5 个 inspector + verifier 映射到对应星域`

---

### Task 4：全量验证 + 文档更新

- [ ] 4.1 全量测试

```bash
npx tsc --noEmit
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

预期：0 failures

- [ ] 4.2 更新 star-general-mechanism.md

修改：`docs/design/star-general-mechanism.md`

在第 2 节"四个 Lever"后加新章节"审查门 × 星域联动"：

```markdown
## 审查门 × 星域联动

审查门的 5 个 inspector 现在携带星域 authority，通过 buildWorkerPrompt
注入完整人格（volatileBlock）+ 方法论（systemPromptSuffix）：

| Inspector | Authority | 匹配理由 |
|-----------|-----------|---------|
| Security | 天府 (tianfu) | fail-closed + 结构承诺 |
| Lifecycle | 天机 (tianji) | 前提审计 + 边界值直觉 |
| Data Flow | 瑶光 (yaoguang) | 复现即证 + 缺陷归族 |
| Silence | 瑶光 (yaoguang) | 绿灯之下最危险 |
| Wiring | 天权 (tianquan) | 建好≠接好≠生效 |

对抗验证者 (adversarial_verifier) → 瑶光 (yaoguang)：复现纪律天然适配。

注入是叠加而非替换：stance 文本仍在 objective 中，authority 注入的是
域级身份和方法论——worker 拿到"你是谁"（persona）+ "你怎么做"（methodology）
+ "查什么"（stance）三层叠加。
```

- [ ] 4.3 提交

提交：`docs: 更新将星机制文档 — 审查门×星域联动`

---

## Verification

```bash
# Typecheck
npx tsc --noEmit
# 预期: 0 errors

# 星域注册
npm exec -- tsx --test src/agent/__tests__/star-domain-registry.test.ts
# 预期: 11 built-in domains, yaoguang + tanlang present

# 路由表
npm exec -- tsx --test src/agent/__tests__/expert-router.test.ts
# 预期: yaoguang → challenger, tanlang → specialist

# Authority 注入
npm exec -- tsx --test src/agent/__tests__/authority-injection.test.ts
# 预期: yaoguang/tanlang persona 注入, toolWhitelist 保留 read_section + repo_graph

# 审查门映射
npm exec -- tsx --test src/agent/__tests__/review-coordinator-deps.test.ts
# 预期: 5 个 inspector + verifier 映射到正确星域

# 全量回归
npm exec -- tsx --test src/**/__tests__/*.test.ts
# 预期: 0 failures
```

## Self-Check

### 1. Spec coverage

| 需求 | 覆盖 Task |
|------|----------|
| 注册瑶光星域 | 1.2 |
| 注册贪狼星域 | 1.2 |
| DOMAIN_MERGE_ROLE 加新域 | 2.2 |
| DomainVoiceId 加新域 | 2.3 |
| Inspector 注入 authority | 3.2 |
| 工具白名单不丢工具 | 1.3 (all domains + read_section + repo_graph) |
| 测试覆盖新域 | 1.1, 2.1, 3.1, 3.3 |
| 文档更新 | 4.2 |

### 2. Placeholder scan

- ✅ 无 TODO/TBD/待定/后续实现
- ✅ 瑶光/贪狼 volatileBlock 和 systemPromptSuffix 完整写出
- ✅ 每个测试有具体断言代码
- ✅ 无"类似任务 N"

### 3. Type consistency

- `StarDomainId` 联合类型：11 个成员，与 STAR_DOMAINS 对象 key 一致
- `DomainVoiceId`：11 个成员 + null，与 DomainNames key 一致
- `DOMAIN_MERGE_ROLE`：11 个 key，与 starDomainRegistry.getDomainIds() 一致
- `INSPECTOR_AUTHORITIES`：5 个 key，与 INSPECTORS name 字段一致
- `request()` 函数：新增 `authority?: string` 参数，与 DelegationRequest.authority 类型一致
- toolWhitelist：所有 11 个域包含 `read_section` 和 `repo_graph`

---

## Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-06-15-star-review-integration.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
