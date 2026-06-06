# Claude Code 工作流调研:任务拆解 / 审查 / 意图 / 引擎(对照天枢)

> 日期：2026-06-06
> 调研对象：反混淆版 Claude Code 源码 `/Users/banxia/app/opencode/claude-code-haha/src`(2.1.163,git `eb39c0b`)
> 方法：4 个并行 subagent 分维度深读,各 27-36 次工具调用、7-10万 token,逐条标注 `文件:行` 锚点与「确认 vs 推断」
> 用途：本文是 spec `2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease.md` 的背景依据。spec 落地的两条改造(对抗式 verifier、cron 租约锁)即源自此调研的最高价值发现。
> 关联：[[standing-collaborator-ingress-spec]]、[[cache-aware-fusion-spec]]、姊妹 task-lifecycle spec

---

## 0. 总判断

CC 与天枢**底层哲学惊人同构**:prompt 驱动、cache 优先、模型自决拆解。差异在**成熟度与严格度**——CC 在「验证」「生命周期」上有天枢欠缺的实战打磨;天枢在「工单结构化」上反比 CC 更类型化(适合服务弱模型)。

**关键 caveat(贯穿全文)**:CC 最强的验证合同是 **ant-only / A/B feature-gate**,外部构建会被 DCE 编译掉,**3P 默认看不到**。这让它作为「设计参考」更有价值(是 Anthropic 自己认为对的做法),但不代表公开版默认行为。

---

## 1. 任务拆解 / 编排

- **无显式拆解器**,模型自主拆,`AgentTool` 只是普通工具 + prompt 引导(`tools/AgentTool/AgentTool.tsx:226,230`;拆解指导写在 `tools/AgentTool/prompt.ts:86,248,271`)。[确认]
- 子 agent **默认不继承父对话**,只回传**一条最终 assistant 文本**(`tools/AgentTool/agentToolUtils.ts:276-354` finalizeAgentTool 取 getLastAssistantMessage)。fork 路径才继承父上下文,为命中 prefix cache(`forkSubagent.ts:54-58`)。[确认]
- **工具白名单隔离**:子 agent 被剥夺递归 AgentTool/ExitPlanMode/AskUserQuestion(`constants/tools.ts:36-46`);异步 agent 进一步收窄白名单(`:55-71`)。可选 `isolation:'worktree'`。[确认]
- **并发**:只读工具 batch 并发 ≤10(`services/tools/toolOrchestration.ts:8-82`)+ background detach(`AgentTool.tsx:733-752`)。[确认]
- **协调协议**:异步 worker 经 `<task-notification>` 回报,coordinator 用 `SendMessage({to})` 续聊、`TaskStop({task_id})` 中止(`coordinator/coordinatorMode.ts:131-159`)。[确认]
- **任务生命周期**:5 态 `pending|running|completed|failed|killed`(`Task.ts:15-29`);7 种任务类型各有 ID 前缀(`Task.ts:6-13`);`stopTask()` 多态 kill(`tasks/stopTask.ts:38-99`)。[确认]
- **cron**:存 `<project>/.claude/scheduled_tasks.json`,one-shot(触发即删)vs recurring(重排+maxAge 过期);多会话用 **PID 租约锁** `scheduled_tasks.lock`——O_EXCL 原子创建 + PID 存活探测 + 陈旧锁回收 + 退出清理,第一个抢到锁的会话当 scheduler,owner 死了旁路接管(`utils/cronTasks.ts:1-70`、`utils/cronTasksLock.ts:1-9,111-173`)。[确认] ← **改造二的参考实现**

## 2. 审查 / 验证 ← 最值得借鉴

**核心:独立对抗式 verification agent**(`tools/AgentTool/built-in/verificationAgent.ts:10-152`,**ant-only 门控**)[确认]:
- 验证者 ≠ 实现者,**被剥夺写权限**(disallow Agent/ExitPlanMode/Edit/Write/NotebookEdit,`:139-145`),系统 prompt 第一句"你的工作不是确认它可用,而是**试图破坏它**"(`:10-12`)
- 每个 PASS **必须附 "Command run + Output observed"**,否则视为 skip;调用方重跑抽查对不上则驳回(`:81-100`)
- 强制至少一个**对抗探针**(并发/边界/幂等/孤儿操作)才能 PASS(`:63-72`)
- 字面量 `VERDICT: PASS|FAIL|PARTIAL` 收尾(供解析);PARTIAL 仅限环境限制,不能用于"我不确定"(`:117-129`)
- 点名两种 LLM 失败模式:verification avoidance(读读代码就写 PASS)、被前 80% 诱惑(`:12`);告诫"实现者也是 LLM,其测试多是 mock,独立验证"(`:51,56`)
- **结构化 nudge**:主线 agent 关 3+ 任务且无验证步骤时,TaskUpdate/TodoWrite 工具结果注入提醒"spawn verifier,你不能靠 summary 列 caveat 自封 PARTIAL"(`tools/TaskUpdateTool/TaskUpdateTool.ts:361-432`)
- **未找到** self-review 自审回环——CC 有意把验证从执行者手里拿走,交给独立对抗 agent。[否定性确认]

**fail-closed 权限把关**[确认]:auto-mode 危险操作判定交独立 Opus 两阶段分类器(`utils/permissions/yoloClassifier.ts:695-734`);分类器不可用时受 `tengu_iron_gate_closed` 门控**默认拒绝**(`permissions.ts:843-889`)。两阶段方法契约 `validateInput()`→`checkPermissions()`(`Tool.ts:489-503`)。

**plan mode 是人类批准门,非模型自审**[确认]:`ExitPlanModeV2` 不接受 plan 内容参数、从文件读,纯"signal 规划完成请审批";区分 `Approved Plan` vs `(edited by user)`(`tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:477-491`)。

**agentSummary 不是审查**[确认,纠正预设]:是每 ~30s fork 生成 3-5 词进度描述的**可观测性**机制(`services/AgentSummary/agentSummary.ts:26-119`),非质量门。

## 3. 用户意图识别 / 任务分析 ← 两者趋同

- **几乎无 LLM 前置意图分类器**[确认]:输入处理纯路由 + 正则启发式(`utils/handlePromptSubmit.ts:120,194,229`);要不要 plan/拆任务是主模型在循环里用工具自决,**prompt 即分类器**。
- `promptCategory`/`userPromptKeywords` 只喂 analytics 不驱动行为(`utils/promptCategory.ts:16,36`、`utils/userPromptKeywords.ts:4,16`)。[确认]
- 重 LLM 分类只在两侧路:权限自动批准(yoloClassifier)+ 下一步预测。[确认]
- **PromptSuggestion**:fork 主线程预测用户下一句,严守"零 API 参数偏移"保 cache(注释:试 effort:low 致命中率 92.7%→61%、cache 写入 45x)(`services/PromptSuggestion/promptSuggestion.ts:258-330`)。[确认]
- **Speculation**:投机预执行预测,写操作隔离到 overlay 临时目录,接受才落盘(`services/PromptSuggestion/speculation.ts:402-633`)。[确认]
- **planModeV2**:模型自决进入,Explore/Plan 子代理并行(数随订阅档位伸缩),计划写文件,ExitPlanMode 人批准;计划长度走 A/B(越长拒绝率越高,<2K 拒 20%→20K+ 拒 50%)(`utils/planModeV2.ts:5-95`、`utils/messages.ts:3217-3292`)。[确认]
- `agenticSessionSearch`:跨会话语义搜索,唯一对历史上下文做 LLM 分析处(`utils/agenticSessionSearch.ts:15-48`)。[确认]

## 4. 系统提示 / query 引擎 ← 最强同构,印证天枢方向

- **提示三层装配**:优先级选择(`utils/systemPrompt.ts:41-123`)→ 分段缓存 → **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** 切静态/动态(`constants/prompts.ts:114,573`)。[确认]
- **分段缓存**:每段 `{name,compute,cacheBreak}`;`DANGEROUS_uncachedSystemPromptSection` 每轮重算、**击穿缓存须附理由**(`constants/systemPromptSections.ts:20-58`)。**≈ 天枢 PromptEngine 的 P1 冻结前缀。**[确认]
- **query 主循环**:`while(true)` 异步生成器 + 不可变 State(`query.ts:241-1728`);无 tool_use→completed,有→执行→递归;容错是一等公民(token 上限升级重试、413 两级压缩、压缩熔断)。[确认]
- **工具编排**:只读 batch 并发 ≤10、写串行、context 修改排队防竞态(`toolOrchestration.ts:19-152`)。[确认]
- **TodoWrite**:prompt 驱动纯文本协议,**恰好一个 in_progress、测试失败禁标 completed**(`tools/TodoWriteTool/prompt.ts:146-179`)。[确认]
- **compact**:阈值=窗口−13k(`autoCompact.ts:62-90`);**8 段结构化摘要 + 逐字引用防漂移 + 连续 3 次失败熔断**(注释:曾一天烧 250K 次 API)(`services/compact/prompt.ts:61-77`、`autoCompact.ts:70,343`)。[确认]
- **cache 焦虑同构**:CC 在 PromptSuggestion 注释记的 92.7%↔61% == 天枢 P1 打到 84-95% 的同一场战斗。两者独立得出同一架构(边界 marker + 分段 + 击穿需理由)。**对天枢「cache 是命根子」判断最强的外部背书。**

## 5. 对比表

| 维度 | Claude Code | 天枢 | 判定 |
|------|-------------|------|------|
| 任务拆解 | 裸 AgentTool + prompt,模型自决 | 类型化 WorkOrder schema(`work-order.ts`) | 天枢更结构化(适合弱模型);CC 更灵活(随强模型进化) |
| 验证 | **独立对抗 verifier**(剥夺写权限+破坏它+证据+VERDICT) | verifier profile 是 `role:'hands'` **能写源码**(`profile-registry.ts:74`)+ evidenceStatus enum(`work-order.ts:142`) | **CC 强**:天枢有角色和状态字段,缺对抗协议 ← 改造一 |
| 意图识别 | 无前置分类,prompt 即分类器 | 同样 prompt 驱动,有 task-contract | 趋同,无大差异 |
| 预测/投机 | PromptSuggestion + Speculation(沙箱) | 无 | CC 独有,但天枢是编码 agent,优先级低 |
| cache 架构 | DYNAMIC_BOUNDARY + 分段缓存 | PromptEngine P1 冻结前缀 | **高度同构**,互相印证 |
| 任务生命周期 | 5 态 + cron PID 租约锁 | TaskBoard 4 态(`task-board.ts`)+ nightcrawler(进程内、无 cron/锁) | **CC 强**:天枢缺多会话调度 ← 改造二 |
| compact | 8 段模板 + 逐字引用 + 熔断 | compaction-controller / agent-diet | CC 更实战 |

## 6. 天枢该拿走什么(按价值排序)

1. **对抗式独立 verifier**(改造现有 verifier profile)← **最高价值**,补"实现者自评"偏置 → spec 改造一
2. **cron 租约锁**(`cronTasksLock.ts` 现成参考)← 填 task-lifecycle scheduler 空白 → spec 改造二
3. **compact 8 段模板 + 熔断** ← 升级现有压缩(本文登记,不在本轮 spec)
4. **WorkOrder 结构化是天枢已有优势,别丢** ← 服务弱模型的正确选择,CC 没有

## 7. 诚实标注

- CC 最强验证合同 **ant-only A/B 门控**,3P 默认无——作为设计参考价值高,非公开默认。
- 意图识别维度两者**确实趋同**,未夸大差异。
- 天枢 verifier 现状核实到 profile 定义(`profile-registry.ts:74`),**未核实运行时是否真被当独立验证者调用**(还是可选 profile)——落地时确认。
- 原始 4 份 subagent 报告未单独留存(在 workflow transcript 内);本文是其综合提炼。

## 附:四维度调研 subagent

| 维度 | subagent token | 工具调用 |
|------|---------------|---------|
| 任务拆解/编排 | 95k | 33 |
| 审查/验证 | 71k | 29 |
| 意图识别/分析 | 77k | 27 |
| 系统提示/query 引擎 | 101k | 36 |
