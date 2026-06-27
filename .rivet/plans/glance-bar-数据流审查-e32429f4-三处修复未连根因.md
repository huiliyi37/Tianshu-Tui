# GlanceBar 数据流审查 — e32429f4 三处修复未连根因

> 审查日期:2026-06-14
> 触发现象:用户报告 UI 面板上 `⚡0% · ctx 0% · ◧ 0/1.0M` 数据错误,称"没有记录上下文窗口当前量,没有缓存命中率"。
> 关联 commit:`e32429f4` fix(tui): show cache hit rate at 0%, fix ctx <1% display, ensure prefix overhead
> 状态:**审查发现 3 个数据流断点,e32429f4 仅修到显示层;补充 fix 因实现事故已撤回,待正确路径重做**。

---

## 1. e32429f4 三处修复各自的根因(commit 内已记)

| 问题 | 根因 | 修复位置 |
|------|------|---------|
| `⚡` 图标消失 | `input.cacheHitRate > 0` 条件跳过 0 显示 | `src/tui/format/glance-bar.ts` 改条件为 `!== undefined` |
| `ctx 0%` 误导 | `Math.round(0.5)=1` 但 `Math.round(0.05)=0` | 同上,新增 `<1%` 占位分支 |
| `◧ 0/1.0M` | `_ensurePrefixOverhead` 在 `compactEnabled=false` return 之后 | `src/agent/compaction-controller.ts` 提前到 early return 之前 |

**commit 内修复全部站得住**,但**只解决了渲染层的判定,没解决数据源问题**。

---

## 2. 三联症的真因 — 数据流断点

按生产入口正向追(天权之道第 4 条):

```
App.tsx render → GlanceBar props → formatGlanceBar 渲染
```

### 断点 1:`cacheHitRate === 0` 在 fresh session 是设计正确,不是 bug

**数据流**:
```
main.tsx L172: cacheHitRate: ctx.session.getRecentTurnHitRate(3) ?? ctx.session.getCacheHitRate()
   ↓
App.tsx L291: useState(0) — 初始值硬编码 0
   ↓
App.tsx L1594: <GlanceBar cacheHitRate={cacheHitRate} />
   ↓
formatGlanceBar: cacheHitRate=0 → 渲染 ⚡0%
```

**当前行为**:
- `getRecentTurnHitRate(3)`:session 启动到第一次 LLM 响应前,`state.turnCacheHistory` 为空 → 返回 `null`
- `??` 回退到 `getCacheHitRate()`:LLM 没被调过 → `totalUsage.cache_*_tokens === 0` → 返回 `0`

**期望行为**:首次响应前 GlanceBar 不该展示 `⚡0%`(语义错:不是 0%,是"无数据")。

**根因**:`??` 默认值用 `0` 把"无数据"和"命中率 0"折叠成同一个值。GlanceBar 拿到 `0` 只能渲染,没法区分。

---

### 断点 2:`ctx 0%` 同样是 fresh session 的渲染语义错

**数据流**:
```
App.tsx L1601: estimatedTokens={session.getEstimatedTokens()}
App.tsx L1602: maxTokens={maxTokens}
   ↓
GlanceBar L103: ratio = maxTokens > 0 ? estimatedTokens / maxTokens : 0
```

**当前行为**:
- `session.getEstimatedTokens() = state.estimatedTokens + state.prefixOverhead`
- fresh session 时:
  - `state.estimatedTokens = 0`(无消息)
  - `state.prefixOverhead = 0`(未触发 `_ensurePrefixOverhead`)
- 结果:`ratio = 0`,渲染 `ctx 0%`

**期望行为**:首次响应前不渲染 `ctx` / `◧`(语义错:不是 0%,是"无 baseline")。

**e32429f4 修复 3**:`_ensurePrefixOverhead` 提前到 `maybeCompact` 入口。
- **覆盖场景**:worker 会话 / skip compaction 会话
- **未覆盖场景**:App 第一次 render 时 `maybeCompact` 还没被调用 — UI 启动 → 用户输入第一条消息之间的窗口期
- **结果**:`◧ 0/1.0M` 仍可能在初始 UI 上闪现

---

### 断点 3:GlanceBar(Ink)和 formatGlanceBar(T9)契约不一致

**Ink 组件 GlanceBar** (`src/tui/glance-bar.tsx`):
```ts
interface GlanceBarProps {
  cacheHitRate: number          // 必填
  estimatedTokens: number       // 必填
  maxTokens: number             // 必填
}
```

**T9 纯函数 formatGlanceBar** (`src/tui/format/glance-bar.ts`):
```ts
interface GlanceBarInput {
  cacheHitRate?: number         // 可选
  estimatedTokens?: number      // 可选
  maxTokens?: number            // 可选(必须 >0 才渲染)
}
```

**契约差异**:Ink 版本强制 number,纯函数版本支持 undefined。
- 即使 App.tsx 想"首次响应前传 undefined",Ink 类型不允许
- 修 App.tsx 必须**同时放宽 Ink 的 prop 类型 + 渲染分支**

---

## 3. 已尝试的实现(撤回)

**目的**:让 prefixOverhead 在 AgentLoop 构造时立刻设置,关闭 UI 启动 → maybeCompact 之间的窗口。

**改动**(已 `git restore` 撤回):
1. `compaction-controller.ts`:`_ensurePrefixOverhead()` → `ensurePrefixOverhead()` public
2. `loop.ts`:在 `this.compaction = new CompactionController(...)` 之后调 `this.compaction.ensurePrefixOverhead()`
3. `compaction-controller.test.ts`:加 4 条 RED 测试(public 方法存在、prefixOverhead 被设、幂等、工具数差异)

**撤回原因**:实现事故——`hash_edit` 把新的 `ensurePrefixOverhead()` 声明塞进旧 `_ensurePrefixOverhead` 方法体内,产生重复 `if(_prefixOverheadSet) return` + 残留 `private` 修饰符;`maybeCompact` 里 `this._ensurePrefixOverhead()` 引用旧名 → TS 编译失败。

**留下的教训**(供未来重做时避开):
- `hash_edit` 锚点 `L255:1cac1805` 命中的是旧方法第一行,`new_string` 必须包含**整方法体**才能干净替换;不能只塞声明 + 让旧 body 留着。
- 改名 + 改可见性的方法,**所有引用方都要同步改**(本例 `maybeCompact` 里的 `this._ensurePrefixOverhead()` 漏改)。
- 复合多个独立改动(改名 + 改可见性 + 加调用方 + 加测试)进同一个 commit,出问题调试面太大。应拆 3 个 commit:测试 / 改名可见性 / 调用方。

**测试已确认有效**(独立探针):
```ts
const e = new PromptEngine({...}); const s = new SessionContext();
const c = new CompactionController({session: s, promptEngine: e, ...});
console.log(s.getEstimatedTokens());  // 0
c.ensurePrefixOverhead();
console.log(s.getEstimatedTokens());  // ~1132 (sys + tools + volatile)
```

`ensurePrefixOverhead` 公共化**逻辑正确**,只是当时的 edit 出错。

---

## 4. 推荐路线(待用户授权)

按"建好 → 接好 → 生效"三步拆独立 commit:

### Commit A:prefixOverhead 在 AgentLoop 构造时设置
- **改**:compaction-controller.ts(整方法替换 `_ensurePrefixOverhead` → `ensurePrefixOverhead`,public)
- **改**:loop.ts L479 后调 `this.compaction.ensurePrefixOverhead()`
- **测**:compaction-controller.test.ts(public 方法存在、幂等、reflects PromptEngine)
- **风险**:PromptEngine 在 AgentLoop 构造时已 ready(否则 `maybeCompact` 早就崩),安全

### Commit B:GlanceBar/Ink 接收 undefined 不渲染
- **改**:glance-bar.tsx(`cacheHitRate/estimatedTokens/maxTokens` 类型放宽为 `number | undefined`;undefined 时不渲染对应 `<Text>`)
- **改**:format/glance-bar.ts(已支持,无需改)
- **测**:glance-bar.test.ts 加 undefined 不渲染测试
- **风险**:GlanceBar 当前唯一调用方是 App.tsx,改两处一并提交

### Commit C:App.tsx 增加 `hasReceivedFirstResponse` gate
- **改**:app.tsx L291 加 `useState<boolean>(false)`
- **改**:L1164 `setCacheHitRate` 同处 `setHasReceivedFirstResponse(true)`
- **改**:L1594/1601/1602 三元表达式:`hasReceivedFirstResponse ? value : undefined`
- **测**:app.tsx 单测较重,但 Ink 渲染测试可覆盖 props 传递
- **风险**:`hasReceivedFirstResponse` 是 useState,但 L1164 在 `handleSubmit` 闭包里,需确认 React state 在异步路径下及时 flush(参考 cd706072 同样的 isStreamingRef 教训)

---

## 5. 反证测试表

| 偷懒实现 | 会红的测试 |
|----------|----------|
| `cacheHitRate: 0` 硬编码 initial state(不修 App.tsx gate) | Ink GlanceBar 首次响应前渲染了 `⚡0%` → formatGlanceBar 测试 fail(预期 undefined) |
| `_ensurePrefixOverhead` 保持 private(只在 maybeCompact 调) | AgentLoop 构造后 `session.getEstimatedTokens()` 仍是 0 → CompactionController 新测试 fail |
| 改 GlanceBar 类型为 `number | undefined` 但渲染分支忘了改 | undefined 时仍然渲染 `NaNk/NaNk` → GlanceBar 新测试 fail |
| `hasReceivedFirstResponse` 用 ref 而非 state | App 重新 render 不会触发 GlanceBar 重渲 → 集成测试 fail |

---

## 6. 不做事项

- 不重做 `e32429f4` 已修对的显示逻辑(`⚡0%` 始终显示 / `ctx <1%`)——它们是对的,只是不充分
- 不引入 sentinel 值(`-1` 表示无数据)——违反项目反 truthy/falsy sentinel 规则
- 不改 `formatGlanceBar`(已正确处理 undefined)
- 不在 SessionContext 构造器设 prefixOverhead(PromptEngine 还没注入)

---

## 7. 关联

- 上游:`cd706072`(T9 main-ansi entrypoint) — `e32429f4` 的进入路径
- 平行:`f55445b0 / 8c8e67b1 / 4b0c9ec7 / 87bf19c1`(tool-group 折叠) — 与本审查无关
- 下游:`t9-ui-refactor-分支复盘-152-提交-五大领域-主线切换评估.md`(T9 主线切换) — 本审查补强其"GlanceBar 数据可信度"