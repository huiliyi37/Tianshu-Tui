# 天枢 Skill 能力 — 技术架构与实现

> 维护者视角的技术参考(非用户使用指南——用法见 `docs/skills-guide.md`)。
> 记录**当前真实实现**,供后续迭代对照,避免"盲盒"。
> 最近一次对齐:2026-06-28(Phase 2 技能生命周期——调用即执行 + 完整轮次保护 + 主动释放)。

---

## 0. 第一原则(拍板优先级)

1. **保真 > 上下文洁净。** 主控模型必须能严格按 SKILL 内容执行;丢精度 / 残缺内容会导致整会话返工,不可接受。冲突时一律选保真。
2. **运行时单一来源 = `.rivet/skills/`(+ 内置)。** 默认不扫描任何外部目录。外部技能(如 `~/.claude/skills`)由用户/agent **复制**进 `.rivet/skills/` 才装载,不与外部目录混用。
3. **渐进装载,召回优先。** 短技能可整体进上下文,长/多文件技能按级按需;scope/过滤永远 additive,绝不静默删 registry。

---

## 1. 三级渐进披露(Progressive Disclosure)

| 级 | 内容 | 进上下文时机 | 入口 | 保真策略 |
|----|------|--------------|------|----------|
| **L1 发现** | 每个技能的 `name + description` | **每轮常驻**(volatile dynamic appendix,cache-safe) | `renderDiscoveryBlock` | 只放描述,绝不放正文;溢出丢尾但给 `<more count>` |
| **L2 激活** | 某技能完整 `SKILL.md` body | 模型/用户**显式加载**时 | `skill` 工具 / `/skill <name>` | **全文 inline,零截断零摘要**(fidelity-exempt) |
| **L3 子文件** | 目录技能的 `references/`、`scripts/`、`assets/` | 模型**按需 read** 时 | `read_file`/`grep`/`glob`(`<skill-files>` 清单引导) | 在 workspace 内天然可读;大文件用 offset/limit 分页读完整 |

设计取向对齐 Claude Code / agentskills.io 的三级披露;**两处是天枢自有增强**(非竞品对齐):L2 加载时附带 `<skill-files>` 文件树清单;L1 溢出给计数安全网。

---

## 2. 数据模型

`src/skills/skill-loader.ts`:

```ts
type SkillSource = 'rivet' | 'project-claude' | 'global-claude'

interface SkillDefinition {
  name: string
  description: string
  triggers: RegExp[]          // 任意命中即标 relevant(排序提前)
  body: string                // SKILL.md 正文(frontmatter 之后)
  tierLock?: 'cheap' | 'balanced' | 'strong'  // 预留字段
  builtIn?: boolean
  source?: SkillSource        // loader 设置,parser 不设
  bodyPath?: string           // backing 文件绝对路径
  skillDir?: string           // 仅目录技能有;扁平 .md 为 undefined ← 三级装载关键
}

interface SkillFileEntry { path: string; kind: 'file' | 'dir' }  // listSkillFiles 返回
```

`SkillRegistry`(`src/skills/skill-loader.ts`)是进程内单例 `skillRegistry`,持有 `Map<name, SkillDefinition>`。注册同名覆盖(后注册胜)。

---

## 3. 装载流水线

入口:`loadProjectSkills(cwd, { importFromClaude })`,在 `src/bootstrap.ts`(`[skills] Loaded N skill(s)` 日志)调用一次。

```
loadProjectSkills(cwd, opts)
  1. registerBuiltinSkills()                       // 内置技能(leave-ritual 等)
  2. if opts.importFromClaude.length:
       importSkillsIntoRivet(cwd, names)           // 复制式导入(见下),仅复制不扫描
  3. skillRegistry.loadFromDirectory(cwd/.rivet/skills, 'rivet')
```

### 3.1 `loadFromDirectory(dir, source)` — 双形态

遍历 `dir` 的每个条目:
- **扁平**:`*.md` 文件 → `parseSkillMarkdown` → `bodyPath` 设;`skillDir` 留空。
- **目录**:`<name>/SKILL.md` 存在 → 解析,`bodyPath` = SKILL.md,**`skillDir` = `<dir>/<name>`**(不 flatten,保留子文件夹)。无 SKILL.md 的目录跳过。

frontmatter 缺 `name` 时回退为文件名/目录名。

### 3.2 `importSkillsIntoRivet(cwd, names)` — 复制式导入(幂等)

把指定技能从 `.claude/skills/` **复制**进 `.rivet/skills/`,运行时永不 in-place 读外部:

- 来源优先级:项目 `cwd/.claude/skills/<name>` > 全局 `~/.claude/skills/<name>`。
- 目标已存在(`.rivet/skills/<name>/` 或 `<name>.md`)→ **跳过,不覆盖**(保护本地修改)。
- 目录技能用 `cpSync(src, dest, {recursive:true})` 连子文件夹整体拷。
- 返回 `{ copied, skipped, errors }`;缺失记 error,不抛。

> `importFromClaude` 配置(`src/config/schema.ts` `skillsSchema`)语义 = **复制白名单**,不是扫描白名单。空数组(默认)= 不导入。
> `loadFromClaudeDirectory(dir, source, filter)` 方法仍在(被 `discovery.test.ts` 直接测),但**已不在运行时路径**,仅历史保留。

### 3.3 内置技能

`BUILTIN_SKILLS`(`src/skills/skill-loader.ts`),`builtIn: true`,无 backing 文件,始终可用。当前:
- `leave-ritual` —— 离开仪式 → `leave_mark` 工具。
- `skill-management` —— **让 agent 自己知道技能怎么装载**:复制进 `.rivet/skills/` + 三级装载机制。走我们自己的三级披露(发现层常驻描述、按需载正文),dogfood 本系统;用户说"装/导入某技能"时 agent 据此执行。

---

## 4. L1 发现层

### 4.1 渲染:`renderDiscoveryBlock(hint?, opts?)`

```
opts: { maxChars=1500, maxDescChars=200, exclude?: Set<string> }
```

1. `exclude` 过滤掉 per-session 禁用技能(PlusMenu)。空→null。
2. 命中 `hint` 的 trigger → `relevant=true`,排序提前(同组内按 name 字典序)。
3. 逐条 `<skill name="X" relevant?>desc</skill>`,desc 截到 `maxDescChars`,累加到 `maxChars` 预算;**单条超预算 `continue`**(尝试更小条目,不 break),`dropped++` 计数。
4. 全被丢→null;否则包进 `<available-skills note=...>`,**溢出时追加 `<more count="N" .../>`**(召回安全网,防静默漏激活)。

只渲染描述,正文绝不进此块 → 预算几乎不会因技能体量爆炸。

### 4.2 注入接线(每轮)

```
turn-step-producer.ts
  promptEngine.setSkillAdvisoryBlock(
    skillRegistry.renderDiscoveryBlock(userInput, { exclude: agent.getDisabledSkills() })
  )
        ↓
prompt/engine.ts  setSkillAdvisoryBlock → 存入 VolatileContext.skillAdvisoryBlock
        ↓
prompt/volatile.ts  buildDynamicAppendix:  if (ctx.skillAdvisoryBlock) parts.push(...)
        ↓
  写入 dynamic appendix(volatile 区,prefix-cache 安全)
```

- `hint` = 本轮 userInput。
- **cache 安全**:发现块只进 volatile appendix,从不进静态 system prompt。`src/prompt/__tests__/skill-cache-safety.test.ts` 守这条。

---

## 5. L2 激活层 + 保真硬保证(核心)

### 5.1 两个入口

- **模型自助**:`skill` 工具(`src/tools/skill.ts`)。`definition` **不嵌任何具体技能名**(字节稳定 → prefix-cache 安全;可加载集合只活在 volatile 发现块)。`execute(name)` 取 `skillRegistry.get(name).body`,包成 `<skill name>...</skill>`;加载成功后会回调 `onSkillInvoked`,通知 PromptEngine 该技能进入活跃状态。
- **用户手动**:`/skill <name>`(`src/tui/slash-commands.ts`)。handler 返回 `false` 让输入透传给 agent pipeline,`resolveAppPromptInput` 把 `/skill <name> [任务...]` 展开成完整技能体作为当前 user prompt,模型**本轮立即响应**;同时调用 `agent.markSkillInvoked(name)` 进入活跃状态。`/skill list` 读 registry 列表。

两者对**目录技能**都追加 `<skill-files dir="..." note="...">` 文件树清单(`listSkillFiles`,排除 SKILL.md,maxDepth=3 / maxEntries=50 有界),note 含"按需读、大文件 offset/limit 分页读完整"。

### 5.2 保真豁免(MUST 1,已堵的 live bug)

工具结果在 `src/agent/tool-pipeline.ts` `executeToolUse` 成功分支会经过两道有损环节:

- `artifactIntercept`:超阈值(`ARTIFACT_INTERCEPT_THRESHOLD=2500`,按预算 ×1.5~3 + `getToolArtifactThreshold` floor)→ 换成 `[artifact:ID] 摘要 + read_section 指针`(首触有损)。`READ_TOOLS` 集合豁免此环。
- `truncateSuccessfulToolResult` + turnBudget `<stored>` 预览:头尾硬截断 / 截成 500 字预览。

**`skill` 既不能走 artifact(首触拿摘要),也不能进 `READ_TOOLS`(改走硬截断,而 `skill` 无 offset/section → 中段不可恢复,更糟)。**

修法:独立的

```ts
const FIDELITY_EXEMPT_TOOLS = new Set(['skill'])
```

成功分支对豁免工具**只记 turnBudget,内容原样 inline**——不 artifact、不截断、不 `<stored>` 替换。非豁免工具行为零变化。

> 为何全文 inline 安全:模型是**显式**调 `skill(name)` 要这份指令,理应给全;且 SKILL.md 按约定应是短"路由"(重料在 `references/`,走 L3 分页),body 体量有界。

守护测试:`src/agent/__tests__/tool-pipeline.test.ts`「delivers a large skill body COMPLETE and inline」——过 `executeToolUse` 全链路,20KB body 完整 inline、无 `[artifact:`、无 `[truncated`、无 `<stored>`、零落盘。(注意:`skill-tool.test.ts` 只测 `execute()` 孤立返回,测不到这条链路,故必须有 pipeline 级测试。)

### 5.3 调用后持续生效与主动释放(Phase 2)

**问题**:L2 仅把技能体 inline 到当前 prompt,若后续发生上下文压缩,技能指令会从历史中被裁掉,导致模型中途“忘记”技能协议。

**解法**:PromptEngine 维护一个 `invokedSkillNames` 集合:

1. **调用即注册**:`skill` 工具加载、`/skill <name>` 都会调用 `PromptEngine.markSkillInvoked(name)`。
2. **每轮动态附录注入**:`renderInvokedSkillsBlock(names, cwd)` 生成 `<invoked-skills>` 块,包含完整技能体,写入 `VolatileContext.invokedSkillsBlock`。
3. **受保护、不被预算挤掉**:`buildDynamicAppendixParts` 先把 `<invoked-skills>` 列为 **protected block**,普通附录块只在“`appendixMaxChars - protectedLen`”剩余预算里做 Top-K。技能体在上下文紧张时仍然完整保留,其它低显著性块先被丢。
4. **主动释放**:模型在技能 workflow 走完后调用 `skill(name="<name>", complete=true)`,经 `onSkillCompleted` 回调 `PromptEngine.markSkillCompleted(name)`,该技能即从动态附录消失。用户也可手动 `/skill off <name>` 或 `/skill complete <name>` 释放。

> 这是天枢对 Claude Code `invoked_skills` attachment 的对齐,但预算保护更严格:技能体作为 protected block 优先于普通附录块。

---

## 6. L3 子文件读取(MUST 2)

- **可读边界**:`src/tools/path-validate.ts` `validatePathSafe` **无 denylist**,cwd 子树内任何路径(含 `.rivet/skills/...`)直接放行;workspace 外才需 grant。技能复制进 workspace 内 → 子文件天然可读,**无需任何跨界授权**。守护:`skill-loader.test.ts`「Tier-3 sub-files ... readable (path boundary)」(子文件可读 + 逃逸 `../../etc/passwd` 仍拦)。
- **大文件分页**:`read_file`(`src/tools/read-file.ts`)在 `READ_TOOLS` 内,绕 artifact;自带 `computeModelReadCap` + offset/limit + "File too large, use offset/limit" 指引 + partial-view "Next step" 提示 → 模型可分页读到完整,不会被迫据残段执行。
- **scripts 执行**:复用 `bash` 工具的审批/沙箱(fail-closed),无新执行通道。(细化属 Phase 2。)

---

## 7. Per-session 启用/禁用(PlusMenu Skills 切换)

```
PlusMenu (desktop)  →  session-manager.ts  session.disabledSkills: Set<string>
                          toggle: enabled?delete:add  →  agent.setDisabledSkills(set)
                          新建/恢复会话时回灌
        ↓
loop.ts  _disabledSkills / setDisabledSkills / getDisabledSkills
        ↓
turn-step-producer  renderDiscoveryBlock(..., { exclude: getDisabledSkills() })
```

禁用只从**发现层**剔除(additive 过滤,不删 registry)→ 模型看不到、不会去 load;registry 本身不动,随时可重新启用。

---

## 8. 源码索引

| 文件 | 职责 |
|------|------|
| `src/skills/skill-loader.ts` | 数据模型、`SkillRegistry`、`loadFromDirectory`(双形态)、`importSkillsIntoRivet`(复制导入)、`listSkillFiles`、`renderDiscoveryBlock`、`renderInvokedSkillsBlock`、`BUILTIN_SKILLS`、`loadProjectSkills` |
| `src/tools/skill.ts` | `skill` 工具(L2 模型入口,字节稳定 definition + 文件树 + `complete` 释放) |
| `src/tools/path-validate.ts` | `validatePathSafe`(L3 读边界,无 denylist) |
| `src/tools/read-file.ts` | L3 子文件读取(offset/limit 分页) |
| `src/agent/tool-pipeline.ts` | `FIDELITY_EXEMPT_TOOLS` / `READ_TOOLS` / 工具回调透传(`onSkillInvoked`/`onSkillCompleted`) |
| `src/agent/tool-execution.ts` / `loop-factory.ts` | 工具回调向 AgentLoop/PromptEngine 转发 |
| `src/agent/turn-step-producer.ts` | 每轮注入发现块(hint=userInput,exclude=禁用集) |
| `src/agent/loop.ts` | `_disabledSkills` + `markSkillInvoked` / `markSkillCompleted` |
| `src/server/session-manager.ts` | per-session `disabledSkills`,PlusMenu 接线 |
| `src/prompt/engine.ts` | 维护 `invokedSkillNames`,渲染 `<invoked-skills>` 块 |
| `src/prompt/volatile.ts` | dynamic appendix,`invokedSkillsBlock` 为 protected block |
| `src/config/schema.ts` / `default.ts` | `skills.importFromClaude`(复制白名单) |
| `src/tui/slash-commands.ts` | `/skill list` / `/skill <name>`(L2 用户入口 + 文件树) / `/skill off <name>` |

### 测试覆盖
| 测试 | 守护点 |
|------|--------|
| `src/skills/__tests__/skill-loader.test.ts` | 双形态加载 / skillDir / listSkillFiles / 复制导入幂等 / L3 读边界 |
| `src/skills/__tests__/discovery.test.ts` | 发现层预算/relevant 排序/exclude/`<more>` 溢出 |
| `src/tools/__tests__/skill-tool.test.ts` | 工具 execute:全文不截断 / 文件树 / 缓存安全 definition / `complete=true` 释放回调 |
| `src/agent/__tests__/tool-pipeline.test.ts` | **保真豁免全链路**(大 body inline 不 artifact/不截断) |
| `src/prompt/__tests__/skill-cache-safety.test.ts` | 发现块不进静态 prompt |
| `src/prompt/__tests__/volatile.test.ts` | dynamic appendix budget / protected block 行为 |

---

## 9. 已知边界与路线图

**当前不做(刻意):**
- `loadPolicy`(inline/lazy/fork)、fork 子代理隔离 —— fork 回摘要=有损,违背保真第一,Phase 2 且仅作非关键超重技能的 opt-in。
- scripts 跨语言执行沙箱细化 —— 复用 bash 审批即可,Phase 2 打磨。
- 热加载 —— 当前 registry 在 bootstrap 装一次;会话中途复制的技能,需新会话进发现层(或 agent 直接 `read_file` 立即用)。

**待定 / 数据驱动(MUST 3):**
- **大池下发现层规模**:`<more count="N">` 只报数量不给名字 → 被藏的弱触发器技能模型**无法 load**。池子大时需 `search_skills(query)`(从全量 registry 检索,不受 1500 预算限)或发现层翻页。触发条件:下游典型池规模确认偏大后再做。

**迭代锚点(改动时务必守住):**
1. 动 `skill` 加载链路 → 必须保留 `FIDELITY_EXEMPT_TOOLS` 全文 inline,且 pipeline 级测试不能退化为 `execute()` 孤立测试。
2. 动 `path-validate` → 若引入 denylist,确认不误伤 `.rivet/skills/`(L3 读边界测试会报警)。
3. 动发现层 → 保持只渲染描述(不漏正文)+ cache-safe(不进静态 prompt)。
4. 动装载 → 保持运行时单一来源(不 in-place 扫外部)+ 复制幂等(不覆盖本地)。
