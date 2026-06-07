# V3 Team Mode 返工任务包（审查驱动）

> 来源：2026-06-07 V3 四组件审查（P0 StarDomainRegistry / A authority / B knowledge store / 闭环）。
> 全部任务有代码证据，非凭空需求。审查门神 = 领航星会话指导，每任务完成后对码验收。
> **验收铁律**：取信 exit code 不取信提交信息；声称"已修"前先能复现原缺陷（RED→GREEN）。

---

## 🔴 P0-A · 堵 fail-open 缺陷族（两处同族 · 最高优先级）

**缺陷族**：检测条件 ≠ 实际生效条件，坏数据/拼错时静默退化为放行。近期第三次复发（前有 codebase-index `wired DEFAULT 1`）。

### A1 · work-order authority 无 else 分支
- **证据**：`src/agent/work-order.ts:222-228` 和 `272-278`，`if(input.authority){ if(domainDef){...} }` 无 else。authority 非空但 `starDomainRegistry.get()` 返回 undefined（拼错/未注册）时，filter 整个跳过 → 退回 profile 全集。
- **改**：`if(domainDef)` 加 else → fail-closed。未知 authority 应 throw（构造期拒绝），或交空集 deny-all。不可静默退回 profile 全集。
- **中性归因**：profile floor（`filterToolRegistry` deny-all）仍兜底，真实后果是"authority 这层额外收紧失效"非安全崩盘——但收紧机制拼错零信号消失，仍须 fail-closed。

### A2 · registry 校验在 sanitize 之前（坏数据漏网）
- **证据**：`src/agent/star-domain-registry.ts:192-193` 非空校验读**原始** `fm.toolWhitelist`；`sanitizeStringArray`（221-222）在其后。`[1,2,3]`（过校验→sanitize 成空）、`['']`（过校验→`:151` 只 trim 不剔空→保留空串）漏网 → 下游 `tools.filter` 变 deny-all。keywords 同款（`includes('')` 恒真匹配一切）。
- **改**：校验挪到 sanitize **之后**；或 `sanitizeStringArray:148` 增 `.filter(v => v.length > 0)`，结果为空则在校验处 throw。

### A1+A2 验收（强制 RED→GREEN）
新增测试三个 case，先在原代码上证明会漏（RED），再证明修复拦住（GREEN）：
1. `authority='tianfuu'`（拼错）→ 期望 throw 或 allowedTools 为空集，**非** profile 全集
2. `toolWhitelist:[1,2,3]` 的 card → 期望注册被拒，**非**空白名单注册成功
3. `keywords:['']` 的 card → 期望被拒，**非**匹配一切任务

---

## 🔴 P0-B · 真接线 V3（否则 B + 用户域是死代码）

**false-green（系统级）**：提交宣称"闭环"，但 grep 证明三处断路。51 单测全绿是**孤立测组件**的假象——零件合格 ≠ 装上了。

- **证据1**：`domainKnowledgeStore` 全仓无 `new`，`coordinator.ts:415` 的 `if(this.config.domainKnowledgeStore)` 永远 false → precipitate 永不触发。
- **证据2**：`buildDomainKnowledgeBlock`（`domain-knowledge-block.ts:35` 定义、`worker-session.ts:17` import）**零调用** → 注入块从不构建。
- **证据3**：`starDomainRegistry.loadFromDirectory` 启动期零调用 → `.rivet/domains/*/card.md` 运行时从不加载。

### 改（三处接线）
1. 构造 `new DomainKnowledgeStore(...)`，传入 coordinator config（参 profileRegistry 的构造/传入路径）
2. worker prompt 组装处真正**调用** `buildDomainKnowledgeBlock`，把返回块注入 prompt
3. 启动期（`main.tsx` profileRegistry.loadFromDirectory 旁）调 `starDomainRegistry.loadFromDirectory`

### 验收（强制端到端，堵 false-green）
一个**系统级**测试，真跑 `delegate → precipitate → recall → inject` 全链路，断言"上一个 worker 沉淀的教训，真的出现在下一个同域 worker 的 prompt 里"。这条测试本身就是 false-green 的解药——单测全绿但没接线，它会红。

### ⚠️ prefix-cache 注意（接线 #2 时）
domain-knowledge-block 内容随 store 增长而变。**不可进 frozen prefix**（会击穿缓存，参 cache-killer 教训）。注入到 tool-result 通道或动态后缀，会话内若需稳定则快照一次。接线时一并确认注入位置。

---

## 🔴 P0-C · B 持久化层补防护（接线前必做 · 先复核再修）

> 这些是审查 agent 报的，**门神未逐行自验**，worker 先复核属实再修，别照单全收。重蹈 `canonical-memory-write-invariants` 事故风险。

- **C1 writer-health gate**：`domain-knowledge-store.ts` `flushDirty`（~255-278）后台 timer 回调里 `mkdirSync`/`atomicWrite` 抛错会掀进程。加 try/catch + 写失败保 `dirty` 待重试，绝不让后台 flush 掀翻主流程。
- **C2 锁超时裸写**：`acquireLock`（~94-108）超时后 return no-op 但调用方照写 → 跨进程全量覆盖丢更新。超时应 fail-closed（保 dirty 不裸写）。补 stale-lock TTL / pid 存活检测。
- **C3 compact 失效**：`compact()` 生产零调用，`deposit` 只 push 不裁剪 → JSONL 无限增长。挂进 deposit lifecycle（达阈值自动 compact）。
- **C4 退出未 flush**：`loop.ts:664` 只 flush 了 stigmergyStore，漏 domainKnowledgeStore，200ms debounce 窗口内退出丢沉淀。

**验收**：坏 JSONL 行跳过、并发写不丢、写失败保 dirty —— 各补 fault-injection 测试（当前全是 false-green，零覆盖）。

---

## 🟡 P1 · 收编彻底 + 散文匹配换结构

### P1-1 · 双源 matchDomain 统一
- **证据**：运行时 `dispatcher.ts:61,80` 和 `buildActiveDomain`（`star-domain.ts:136`）走**模块级** `matchDomain`（`star-domain.ts:109`，遍历 STAR_DOMAINS Record），registry 版 `matchDomain` 只测试用。双源 → 自定义域永远进不了活动域匹配。
- **改**：运行时统一走 registry 单源。删模块级重复实现或令其委托 registry。
- **验**：自定义域（card.md 加载后）能被运行时 matchDomain 命中。

### P1-2 · precipitate 散文匹配换结构字段
- **证据**：`domain-lesson-precipitate.ts:98` `errMsg.includes('scope')||includes('outside')||includes('missing')` 子串匹配——"nothing missing" 误命中。同 always-true 族。`:57-66` `[...dirs][0]!` 取 Set 首元素却宣称"代码集中在 X 目录"，语义错。
- **改**：改判结构字段（`result.evidenceStatus==='blocked'` 等）或 failure-classifier 分类结果；目录众数真做频次统计或删该提取规则。
- **验**：散文含 "missing/scope" 但非领域失败的 result 不应误沉淀。

---

## 验收顺序与门禁

1. **P0-A 先行**（安全归族，独立可验）
2. **P0-C 在 P0-B 之前**（接线前持久化必须健壮，否则一接就炸）
3. **P0-B 接线**（带端到端测试）
4. **P1** 收尾

**每个任务交付时门神核验**：tsc 0 错 + 相关测试 RED→GREEN 证据 + 对码确认改在了点上（非仅提交信息）。任一 fail-open / false-green 残留 → 打回。

## 已核实扎实、勿动（避免过度返工）
- P0 内置 6 域 registry + glance-bus/slash-commands 列表收编：fail-closed，可采信
- B 数据模型 decay/grade/dedup 边界：正确（`>=` 阈值、`halfLife<=0→0` 护栏、空 text 拒绝）
- A 核心不变量：交集只收窄不放大，dispatch 真 deny-all，authority 永不能提权超 profile floor

---

# 验收记录（门神 · 滚动更新）

## ✅ P0-A · fail-open 归族 — 通过（commit 861ffbf）
RED→GREEN 铁证：退回修复前源码，5 个攻击面 case 全红（`toolWhitelist:[1,2,3]`/`['']`、`keywords:['']`、authority typo read/write），修复后全绿。代码对码确认 A1 `toolsForAuthority` 未知 authority→`return []` deny-all、A2 sanitize 加 `.filter(v=>v.length>0)`+校验后置。scope 干净，越界发现正确推给 P0-B/P1。**教科书级归族修复。**

## 🟡 P1-1 · 统一 matchDomain — 代码通过，测试 false-green 必须回退（commit 303ef2c）

**代码改对**（对码确认）：matchDomain/buildActiveDomain 全委托 `getRegistry()`，旧遍历删净，STAR_DOMAINS 降级为 seed 源；createRequire 懒加载循环依赖设计正确；`as StarDomainId`+`?? 'tianliang'` fallback 与 P0-A deny-all 兼容。

**🔴 必须回退 — 测试 false-green**：
- `star-domain-registry.test.ts:400` `custom domain keywords are matched by runtime matchDomain` 用 `new StarDomainRegistry()` 建**孤立新实例**调 `reg.matchDomain`——**根本没调 `star-domain.ts` 导出的运行时 matchDomain**（P1-1 真正改的那行）。
- 门神 RED 证明已坐实：退回 `303ef2c~1` 的 star-domain.ts，该测试**照样绿**，绕开被修代码路径，守不住回归。测试名 "runtime matchDomain" 误导——实测的是 registry 实例，该能力 P0 时已有。
- **修法**：测试改为 `import { matchDomain } from '../star-domain.js'`（运行时那个），自定义域 load 进**单例** `starDomainRegistry`（非新建实例），断言 `matchDomain('渗透...')==='machao'`。**验收标准：退回 `303ef2c~1` 的 star-domain.ts 时该测试必须 RED**（现在是绿=证据）。

**⚠️ 未查完疑点（统一复验时核）**：RED 验证时退回 star-domain.ts 导致 "has all 7 built-in domains" 测试红——怀疑 303ef2c 改了 STAR_DOMAINS 域集合（增/减域），而提交摘要只说 "unify matchDomain"，未声明。核查：`git show 303ef2c -- src/agent/star-domain.ts` 看 diff 有无域增减；若有未声明改动，确认是有意还是 scope creep。
> 注：因其他会话正在 star-domain V3 上动工，门神已停止一切对 star-domain/dispatcher/registry 的访问（含只读 checkout），此疑点留待全部完工后统一复验。

## 待复验清单（全部任务完工后，门神统一重查）
1. P1-1 测试回退后是否真 RED→GREEN（退 303ef2c~1 必红）
2. P1-1 是否偷改 STAR_DOMAINS 域集合（未声明 scope creep）
3. P0-B 接线三处 + 端到端测试（store 构造 / block 调用 / loadFromDirectory）
4. P0-C 持久化防护（先复核 agent 报告属实再认修复）
5. 全量回归：跨模块测试一次跑全（避免孤立测试漏掉接线后的交互回归）
