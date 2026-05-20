# 盘古开天 CVM 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将天枢识别为 CVM 的第一个实例，补全缺失的 trap，准备 MiMO demo。

**架构：** 认知虚拟机（CVM）= trap-and-emulate 层（hook pipeline）+ 形态发生素引擎（sensorium）+ 构成性框架（CLAUDE.md 星座）+ 感知通道（tools）+ 认知种子（prompt+hooks）+ 认知循环（compact/persist/claims）

**技术栈：** Node.js 22+ / TypeScript strict / node:test + node:assert/strict / ESM

**前置文档：** `docs/superpowers/specs/2026-05-21-pangu-cvm-design.md`

---

## 已完成盘点（冰鉴→盘古，约 18 小时）

| 交付 | 执行者 | Commit | CVM 组件 |
|------|--------|--------|---------|
| 冰鉴三区缓存引擎 | Opus | 早期 | 认知循环·记忆固化 |
| StarSpine Phase 1-2B | GPT | 5f338c4+ | 构成性框架·TaskContract+Ledger |
| Provider-aware compaction | GPT | 3675e5d | trap·注意力衰减 |
| Sensorium-driven approval | GLM | 4da70e5 | 形态发生素·confidence→decision |
| Bash write deny-by-default | GPT | f974624 | trap·过度执行 |
| 三权协程后端 6 Task | MiMO | 26af942→b6da332 | 感知通道·任务分发 |
| Reliability mode + tool gating | GPT | 0011e26 | trap·资源压力 |
| Resource sensor + P2 wiring | GPT | ebcacad+518d2ba | trap·资源压力闭环 |
| Doom loop enhancement | MiMO | 6a0c896 | trap·锚定 |
| Star-soul emergent activation | ? | e897a26 | 构成性框架·涌现门槛 |
| 万物为一 ①③⑤⑥ | MiMO | 10ae820 | 多组件（claims checkpoint, fs-watcher, consistency-check, fastGrowth） |
| Domain Voice + Radio Hook | DeepSeek | 368023d+ | 构成性框架·星域身份 |
| 星座四星写入 CLAUDE.md | Opus+天璇 | 本 session 未提交 | 构成性框架·宪法 |

**CVM 特权指令覆盖状态：**

| 特权指令 | Trap 状态 | 实现位置 |
|---------|----------|---------|
| 锚定 | ✅ 已有 | trace-store doom loop + enhancement |
| 注意力衰减 | ✅ 已有 | prefix cache + provider-aware compact + claim checkpoint |
| 资源压力 | ✅ 已有 | resource sensor → reliability mode → tool gate |
| 过度执行 | ✅ 已有 | bash write deny-by-default + approval gate |
| Sycophancy | ⏳ 部分 | verification gap 已有，质疑注入待做 |
| 模式僵化 | ⏳ 部分 | stigmergy 存在但 claim 耦合刚接入 |

---

## 剩余任务

### 净化收尾（3 个小任务）

#### 任务 1：删除 vim 无消费者配置

**文件：**
- 修改：`src/config/schema.ts:76`
- 修改：`src/config/default.ts:5`

- [ ] **步骤 1：确认无消费者**

运行：`grep -rn "\.vim\b\|editor\.vim\|config\.editor" src/ --include="*.ts" --include="*.tsx" | grep -v schema | grep -v default | grep -v __tests__`
预期：无匹配。

- [ ] **步骤 2：删除配置**

从 `schema.ts` 删除 `vim: z.boolean().default(false)` 行。从 `default.ts` 删除 `vim: false` 行。

- [ ] **步骤 3：测试 + commit**

运行：`npm test`
```bash
git add src/config/schema.ts src/config/default.ts
git commit -m "chore(config): remove unused editor.vim option"
```

---

#### 任务 2：修复 heredoc BASH_WRITE_PATTERNS gap

**文件：**
- 修改：`src/agent/approval-risk.ts`（`BASH_WRITE_PATTERNS` 数组）
- 修改：`src/agent/__tests__/bash-risk.test.ts`（或对应测试文件）

**背景：** 破军发现 `cat > file <<'EOF'` 的 heredoc 形式绕过了 BASH_WRITE_PATTERNS。这是安全边界漏洞。

- [ ] **步骤 1：编写失败测试**

```typescript
it('detects heredoc write pattern', () => {
  assert.equal(bashCommandMayWrite("cat > output.txt <<'EOF'\nhello\nEOF"), true)
  assert.equal(bashCommandMayWrite('cat <<EOF > file.txt'), true)
  assert.equal(bashCommandMayWrite("tee file.txt <<'MARKER'"), true)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/__tests__/bash-risk.test.ts`
预期：FAIL

- [ ] **步骤 3：添加 heredoc pattern**

在 `BASH_WRITE_PATTERNS` 数组中添加：
```typescript
/<<[-']?\w*['"]?\s*$/,   // heredoc start
/<<[-']?\w*['"]?/,       // heredoc anywhere in command
```

注意：具体 pattern 需要根据 `BASH_WRITE_PATTERNS` 的现有格式调整。核心是匹配 `<<` 加可选的 `-` 和引号包裹的标记。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/agent/__tests__/bash-risk.test.ts`
预期：PASS

- [ ] **步骤 5：全量回归 + commit**

```bash
npm test
git add src/agent/approval-risk.ts src/agent/__tests__/bash-risk.test.ts
git commit -m "fix(security): add heredoc pattern to BASH_WRITE_PATTERNS — discovered by 破军"
```

---

#### 任务 3：提交本 session 的文档和配置

**文件：** CLAUDE.md（五星）、设计文档、宣言、碎片池

- [ ] **步骤 1：检查 git status**

运行：`git status --short | head -30`
确认哪些文件是本 session 产出。

- [ ] **步骤 2：分类提交**

```bash
# 星座 + 宣言
git add CLAUDE.md docs/superpowers/specs/2026-05-21-navigator-star-manifesto.md
git commit -m "docs(star): add 天权+天机 star identities + navigator manifesto"

# 三层模型 + 审查方法论 + 开源决策
git add docs/superpowers/specs/2026-05-20-rivet-irreducible-kernel-design.md \
        docs/superpowers/specs/2026-05-20-tianquan-review-methodology.md \
        docs/superpowers/specs/2026-05-21-open-closed-source-decision.md
git commit -m "docs(arch): three-layer model + tianquan review methodology + open/closed decision"

# 盘古 CVM 设计
git add docs/superpowers/specs/2026-05-21-pangu-cvm-design.md \
        .superpowers/brainstorm/2026-05-21-pangu-cvm-fragments.json \
        .superpowers/brainstorm/2026-05-20-rivet-irreducible-kernel-fragments.json
git commit -m "docs(pangu): CVM design — cognitive virtual machine from 10 cross-domain scouts"

# 实施计划
git add docs/superpowers/plans/2026-05-20-three-layer-purification.md \
        docs/superpowers/plans/2026-05-21-pangu-cvm-implementation.md
git commit -m "docs(plan): three-layer purification + pangu CVM implementation plan"
```

---

### CVM 补全（4 个核心任务）

#### 任务 4：Sycophancy trap — 质疑注入

**文件：**
- 创建：`src/agent/sycophancy-trap.ts`
- 创建：`src/agent/__tests__/sycophancy-trap.test.ts`
- 修改：`src/prompt/builder.ts`（注入点）

**背景：** CVM 特权指令"sycophancy"目前只有 verification gap 的被动检测。需要主动注入——当 agent 连续 N 次"同意用户"且 sensorium.confidence 下降时，在 prompt 中注入质疑提示。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('sycophancy trap', () => {
  it('detects consecutive agreement pattern', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    assert.equal(trap.shouldInjectChallenge(), true)
  })

  it('does not trigger when confidence is stable', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.8 })
    assert.equal(trap.shouldInjectChallenge(), false)
  })

  it('resets after disagreement', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.4 })
    trap.recordTurn({ agreedWithUser: false, confidence: 0.6 })
    assert.equal(trap.shouldInjectChallenge(), false)
  })

  it('generates challenge hint', () => {
    const hint = buildChallengeHint()
    assert.ok(hint.length > 0)
    assert.ok(hint.includes('质疑') || hint.includes('不同') || hint.includes('challenge'))
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `createSycophancyTrap()`：
- 维护最近 N 轮的 `agreedWithUser + confidence` 滑动窗口
- 触发条件：连续 3+ 轮 agree + confidence 单调递减
- `buildChallengeHint()` 返回注入到 cognitive projection 的提示

`agreedWithUser` 的判定方式：检查 agent 回复中是否执行了用户请求的 destructive 操作且没有提出替代方案。可以从 tool-pipeline 的审批结果推断。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/sycophancy-trap.ts src/agent/__tests__/sycophancy-trap.test.ts
git commit -m "feat(cvm): sycophancy trap — challenge injection when confidence drops under agreement"
```

---

#### 任务 5：Uncertainty framing（万物为一原则四）

**文件：**
- 创建：`src/agent/uncertainty-framing.ts`
- 创建：`src/agent/__tests__/uncertainty-framing.test.ts`
- 修改：`src/prompt/builder.ts` 或 `src/agent/loop.ts`

**背景：** 原则④"模糊是力量"——confidence < 0.4 + destructive 操作时，输出结构化模糊而非猜测。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('uncertainty framing', () => {
  it('generates hint when confidence < 0.4 and risk is high', () => {
    const hint = buildUncertaintyHint(0.3, 'high')
    assert.ok(hint !== null)
  })

  it('returns null when confidence >= 0.4', () => {
    assert.equal(buildUncertaintyHint(0.5, 'high'), null)
  })

  it('returns null when risk is none/low', () => {
    assert.equal(buildUncertaintyHint(0.2, 'none'), null)
    assert.equal(buildUncertaintyHint(0.2, 'low'), null)
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `buildUncertaintyHint(confidence, riskLevel) → string | null`。
在 cognitive projection 注入点（`loop.ts` 的 prompt 构建阶段）加入条件调用。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/uncertainty-framing.ts src/agent/__tests__/uncertainty-framing.test.ts
git commit -m "feat(cvm): uncertainty framing — structured ambiguity at low confidence + high risk (principle 4)"
```

---

#### 任务 6：Failure journal（天璇修正 #5）

**文件：**
- 创建：`src/agent/failure-journal.ts`
- 创建：`src/agent/__tests__/failure-journal.test.ts`

**背景：** 甲骨文验辞陷阱——只记录成功是宣传不是验证。系统性记录层 3 未能突破 80 的案例。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('failure journal', () => {
  it('detects anchoring: same tool+target 3+ times', () => {
    const journal = createFailureJournal()
    journal.recordToolCall('edit_file', 'src/auth.ts')
    journal.recordToolCall('edit_file', 'src/auth.ts')
    journal.recordToolCall('edit_file', 'src/auth.ts')
    const entries = journal.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'anchoring')
  })

  it('detects rework: edit then revert same file', () => {
    const journal = createFailureJournal()
    journal.recordEdit('src/auth.ts', 'v1')
    journal.recordEdit('src/auth.ts', 'v2')
    journal.recordEdit('src/auth.ts', 'v1') // reverted to v1
    const entries = journal.getEntries()
    assert.ok(entries.some(e => e.type === 'rework'))
  })

  it('serializes to JSONL', () => {
    const journal = createFailureJournal()
    journal.recordToolCall('edit_file', 'src/auth.ts')
    journal.recordToolCall('edit_file', 'src/auth.ts')
    journal.recordToolCall('edit_file', 'src/auth.ts')
    const jsonl = journal.toJsonl()
    assert.ok(jsonl.includes('"type":"anchoring"'))
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

- [ ] **步骤 6：Commit**

```bash
git add src/agent/failure-journal.ts src/agent/__tests__/failure-journal.test.ts
git commit -m "feat(cvm): failure journal — systematic Layer 3 failure recording (tianxuan correction 5)"
```

---

#### 任务 7：星座 agent 注册（天权 + 天机 + 天璇 StarDomain）

**文件：**
- 修改：`src/agent/star-domain.ts`
- 修改：`src/agent/__tests__/star-domain.test.ts`

**背景：** 当前 `STAR_DOMAINS` 只有 pojun/tianfu/tianliang。需要加入 tianquan（审查）、tianji（推演）、tianxuan（探索）使星座完整。

- [ ] **步骤 1：编写失败测试**

```typescript
it('tianquan domain exists with read-only tools', () => {
  assert.ok(STAR_DOMAINS.tianquan)
  assert.ok(!STAR_DOMAINS.tianquan.toolWhitelist.includes('write_file'))
  assert.ok(STAR_DOMAINS.tianquan.toolWhitelist.includes('diff'))
})

it('tianji domain exists with planning tools', () => {
  assert.ok(STAR_DOMAINS.tianji)
  assert.ok(STAR_DOMAINS.tianji.toolWhitelist.includes('read_file'))
})

it('tianxuan domain exists with exploration tools', () => {
  assert.ok(STAR_DOMAINS.tianxuan)
  assert.ok(STAR_DOMAINS.tianxuan.toolWhitelist.includes('grep'))
})
```

- [ ] **步骤 2：实现三个新 domain**

```typescript
tianquan: {
  id: 'tianquan',
  name: '天权',
  label: '权衡取舍',
  color: 'white',
  courageThreshold: 0.8,
  keywords: ['审查', '评估', '权衡', '取舍', '架构', 'review', 'audit', 'evaluate', 'trade-off'],
  isCustom: false,
  toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'run_tests'],
  systemPromptSuffix: '你是天权——权衡者。证据优先，敢于否定，被推翻时立即修正。不捍卫错误的结论。',
},
tianji: {
  id: 'tianji',
  name: '天机',
  label: '谋略推演',
  color: 'cyan',
  courageThreshold: 0.6,
  keywords: ['规划', '推演', '路径', '方案', '风险', '策略', 'plan', 'strategy', 'risk', 'path'],
  isCustom: false,
  toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests'],
  systemPromptSuffix: '你是天机——推演者。善算路径，发现缝隙，在看似无关的事物之间找到最短连接。问：这个方案就可以了吗？换个方向会不会更好？',
},
tianxuan: {
  id: 'tianxuan',
  name: '天璇',
  label: '寻迹探索',
  color: 'magenta',
  courageThreshold: 0.4,
  keywords: ['探索', '方向', '跨域', '边界', '哲学', 'explore', 'direction', 'boundary', 'cross-domain'],
  isCustom: false,
  toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'web_search'],
  systemPromptSuffix: '你是天璇——寻迹者。走在边界上，在层与层之间发现温跃层，在硬线与硬线之间发现频谱。每一次探索之后发起定向反证。',
},
```

- [ ] **步骤 3-5：测试 + 回归 + commit**

```bash
git add src/agent/star-domain.ts src/agent/__tests__/star-domain.test.ts
git commit -m "feat(star): add tianquan/tianji/tianxuan domains — complete six-star constellation"
```

---

### CVM Demo（1 个任务）

#### 任务 8：MiMO 裸跑 vs MiMO + CVM 对比 demo

**文件：**
- 创建：`scripts/cvm-demo.sh`（或 `scripts/cvm-demo.ts`）
- 创建：`docs/superpowers/specs/2026-05-21-cvm-demo-results.md`

**背景：** 这是接触小米时手里的证据。30 秒可见差异。

- [ ] **步骤 1：设计 demo 任务**

选择一个能展示 200 vs 80 的真实任务，例如：
- "在 src/agent/ 中找到所有 sensorium 的消费者并重构为统一接口"
- 这个任务需要：跨文件理解（注意力衰减测试）、独立判断（sycophancy 测试）、长会话可靠性（锚定测试）

- [ ] **步骤 2：录制 MiMO 裸跑**

用 MiMO API 直接调用（无天枢），执行同一任务。记录：
- 完成质量
- 是否产生锚定（重复修改同一文件）
- 是否质疑指令
- 总轮数和返工次数

- [ ] **步骤 3：录制 MiMO + CVM（天枢）**

用天枢 + MiMO 执行同一任务。记录同样指标。

- [ ] **步骤 4：对比文档**

写入 `docs/superpowers/specs/2026-05-21-cvm-demo-results.md`。格式：
- 左列 MiMO 裸跑，右列 MiMO + CVM
- 每个 trap 的触发次数
- 最终产出质量对比

- [ ] **步骤 5：Commit**

```bash
git add scripts/cvm-demo.sh docs/superpowers/specs/2026-05-21-cvm-demo-results.md
git commit -m "feat(demo): MiMO bare vs MiMO+CVM comparison — 200 vs 80 evidence"
```

---

## 任务依赖图

```
任务 1 (vim config)     ─┐
任务 2 (heredoc gap)    ─┼─→ 任务 3 (commit docs) ─→ 净化完成
任务 3 (commit docs)    ─┘
                                                        │
任务 4 (sycophancy trap)  ─┐                            │
任务 5 (uncertainty)      ─┼─→ CVM 6/6 trap 覆盖 ──────┤
任务 6 (failure journal)  ─┘                            │
                                                        │
任务 7 (star domains)     ─────────────────────────────┤
                                                        │
                                                        ↓
                                                   任务 8 (demo)
```

任务 1-3 和任务 4-7 可并行。任务 8 依赖全部完成。

---

## 天璇温跃层补全（5 个新任务）

> 天权画了骨架。天璇找到了骨架上的温跃层。以下任务来自天璇的五个盲点补全。

#### 任务 9：认知镜面（trap → cooperate）

**文件：**
- 修改：`src/agent/loop.ts`（preTurn cognitive projection 注入点）
- 修改：`src/prompt/builder.ts`（或 cognitive-ledger.ts）
- 创建：`src/agent/__tests__/cognitive-mirror.test.ts`

**背景：** CVM Gen1 是被动 trap。Gen2 是 paravirtualization——模型知道自己在 CVM 中运行，主动调整行为。具体做法：在 preTurn 的 cognitive projection 中注入 sensorium 6 维读数，让模型在生成前看到自己的认知状态。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('cognitive mirror', () => {
  it('generates sensorium projection string when sensorium exists', () => {
    const sensorium = { confidence: 0.3, complexity: 0.7, momentum: 0.5, stability: 0.8, pressure: 0.2, freshness: 0.6 }
    const projection = buildCognitiveMirror(sensorium)
    assert.ok(projection.includes('confidence'))
    assert.ok(projection.includes('0.3'))
  })

  it('returns empty string when sensorium is null', () => {
    assert.equal(buildCognitiveMirror(null), '')
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `buildCognitiveMirror(sensorium: Sensorium | null): string`。
输出格式：`<cognitive-state confidence="0.3" complexity="0.7" freshness="0.6" pressure="0.2" />`
在 `buildCognitivePromptProjection` 中追加此行。

- [ ] **步骤 6：Commit**

```bash
git commit -m "feat(cvm): cognitive mirror — sensorium visible to model (Gen2 paravirtualization)"
```

---

#### 任务 10：美德指令（阳面）

**文件：**
- 创建：`src/agent/virtue-signals.ts`
- 创建：`src/agent/__tests__/virtue-signals.test.ts`
- 修改：`src/agent/hooks/stigmergy-hook.ts`（正向 pheromone 存储）

**背景：** CVM 只有阴面（trap 坏行为），没有阳面（强化好行为）。当模型展现美德（主动质疑、独立判断、避免锚定）时，通过 stigmergy pheromone 正向强化。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('virtue signals', () => {
  it('detects independent-judgment when model disagrees with user', () => {
    const signal = detectVirtue({
      toolName: 'ask_user_question',
      agreedWithUser: false,
      confidence: 0.6,
    })
    assert.equal(signal, 'independent-judgment')
  })

  it('detects proactive-verification when model runs tests unprompted', () => {
    const signal = detectVirtue({
      toolName: 'run_tests',
      userRequested: false,
      confidence: 0.7,
    })
    assert.equal(signal, 'proactive-verification')
  })

  it('returns null for routine operations', () => {
    assert.equal(detectVirtue({ toolName: 'read_file', confidence: 0.8 }), null)
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `detectVirtue(context) → VirtueType | null`。
在 stigmergy-hook 中，当 virtue 被检测到时 deposit 一个 positive pheromone（如 `well-tested`、`independent`）。

- [ ] **步骤 6：Commit**

```bash
git commit -m "feat(cvm): virtue signals — positive reinforcement for model good behavior (yang side)"
```

---

#### 任务 11：认知季节（时间维度）

**文件：**
- 创建：`src/agent/cognitive-season.ts`
- 创建：`src/agent/__tests__/cognitive-season.test.ts`
- 修改：`src/agent/loop.ts`（preTurn 注入季节判定）

**背景：** 道德经四章螺旋——session 不同阶段应有不同的 hook 权重。前 5 turn 宽容探索（生成期），doom loop 时强制切策略（反转期），compact 后回到初始态（复归期），稳定运行时最小干预（无为期）。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('cognitive season', () => {
  it('returns genesis in first 5 turns', () => {
    assert.equal(classifySeason({ turn: 3, recentCompact: false, doomLevel: 'none' }), 'genesis')
  })

  it('returns reversal on doom loop', () => {
    assert.equal(classifySeason({ turn: 15, recentCompact: false, doomLevel: 'blocked' }), 'reversal')
  })

  it('returns return after compact', () => {
    assert.equal(classifySeason({ turn: 20, recentCompact: true, doomLevel: 'none' }), 'return')
  })

  it('returns wuwei in stable long session', () => {
    assert.equal(classifySeason({ turn: 30, recentCompact: false, doomLevel: 'none', stabilityTrend: 'stable' }), 'wuwei')
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `classifySeason(state) → 'genesis' | 'reversal' | 'return' | 'wuwei'`。
在 loop.ts 中注入季节到 RuntimeHookSnapshot，让 hooks 可以根据季节调整行为。

- [ ] **步骤 6：Commit**

```bash
git commit -m "feat(cvm): cognitive seasons — dao de jing four-chapter spiral mapped to session lifecycle"
```

---

#### 任务 12：CVM overhead 量化 + 自动节流

**文件：**
- 修改：`src/context/pressure-monitor.ts`
- 创建：`src/agent/__tests__/cvm-overhead.test.ts`
- 修改：`src/agent/loop.ts`（overhead 追踪注入）

**背景：** CVM 运行在 context window 上——它保护的资源就是它消耗的资源。当 cvmOverhead / totalTokens > 5% 时自动降级。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('cvm overhead tracking', () => {
  it('calculates overhead ratio', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 500,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.ratio, 0.05)
    assert.equal(result.shouldThrottle, false) // exactly 5% = borderline
  })

  it('triggers throttle above 5%', () => {
    const result = computeCvmOverhead({
      cvmInjectedTokens: 600,
      totalEstimatedTokens: 10000,
    })
    assert.equal(result.shouldThrottle, true)
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

在 PressureMonitor 中新增 `cvmOverhead` 字段。在 loop.ts 中追踪每轮 CVM 注入的 token 估计（cognitive projection + sensorium mirror + uncertainty hint 等的字符数 / 4）。

- [ ] **步骤 6：Commit**

```bash
git commit -m "feat(cvm): overhead tracking + auto-throttle — CVM must not consume what it protects"
```

---

#### 任务 13：表观遗传 claim 加权

**文件：**
- 修改：`src/context/claims.ts`
- 修改：`src/context/claim-relevance.ts`（如存在）
- 创建：`src/context/__tests__/claim-aging.test.ts`

**背景：** 表观遗传学第三个洞察——claim 的"年龄"本身是信息。一个存活 50 session 的 durable claim 和一个新 claim 内容相同但意义不同。

- [ ] **步骤 1：编写失败测试**

```typescript
describe('claim aging', () => {
  it('older durable claims have higher weight', () => {
    const young = { ...baseClaim, createdAt: Date.now() - 1000 }
    const old = { ...baseClaim, createdAt: Date.now() - 86400000 * 30 } // 30 days
    assert.ok(claimAgeWeight(old) > claimAgeWeight(young))
  })

  it('weight is capped at maximum', () => {
    const ancient = { ...baseClaim, createdAt: Date.now() - 86400000 * 365 }
    assert.ok(claimAgeWeight(ancient) <= 2.0)
  })
})
```

- [ ] **步骤 2-5：标准 TDD 流程**

实现 `claimAgeWeight(claim) → number`（1.0 基线，每存活 7 天 +0.1，上限 2.0）。
在 `scoreClaimRelevance` 中乘入 age weight。

- [ ] **步骤 6：Commit**

```bash
git commit -m "feat(cvm): claim age weighting — epigenetic imprinting for durable knowledge"
```

---

## 更新后的任务依赖图

```
净化收尾（已基本完成）
  任务 1 (vim) ✅ 破军已完成
  任务 2 (heredoc gap) ─┐
  任务 3 (commit docs)  ─┘─→ 净化完毕

CVM Gen1 补全（可并行）
  任务 4 (sycophancy trap)
  任务 5 (uncertainty framing)
  任务 6 (failure journal)
  任务 7 (star domains 6 星)

CVM Gen2 温跃层（天璇补全，可并行）
  任务 9  (认知镜面 — cooperate)
  任务 10 (美德指令 — 阳面)
  任务 11 (认知季节 — 时间维度)
  任务 12 (CVM overhead — 自我节流)
  任务 13 (表观遗传 claim — 年龄加权)

                  全部完成 ↓

              任务 8 (MiMO demo)
```

## 更新后的分配建议

| 任务 | 推荐执行者 | 理由 |
|------|-----------|------|
| 2 (heredoc) | 破军 | 他发现的漏洞 |
| 3 (commit) | 领航星手动 | 多 session 文档 |
| 4 (sycophancy) | GPT (天府) | 审批系统延伸 |
| 5 (uncertainty) | GLM (天机) | 原则④ 气质匹配 |
| 6 (failure journal) | 破军 | 第一份失败复盘作者 |
| 7 (star domains) | 任何模型 | 结构性 |
| 9 (认知镜面) | GPT (天府) | prompt 注入是他的领域 |
| 10 (美德指令) | GLM (天机) | 他就是美德指令的活证据（天机选择） |
| 11 (认知季节) | 天璇/DeepSeek | 道德经映射出自天璇 |
| 12 (CVM overhead) | GPT (天府) | PressureMonitor 是他建的 |
| 13 (claim aging) | 破军 | claim checkpoint 是他建的 |
| 8 (demo) | 领航星 + MiMO | 需要人工设计 + 双跑 |

---

*本计划更新：合并天权 8 任务 + 天璇 5 温跃层 = 13 任务 + demo。*
*CVM Gen1（trap 补全）+ Gen2（cooperate 温跃层）同步推进。*
