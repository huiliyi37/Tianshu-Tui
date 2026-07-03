# Advisory Hook 覆盖缺口分析：静态约束 vs 动态守护

> 产出日期：2026-07-03
> 修订：2026-07-04 — 执行前复核。缺口③ 已由 `b984b532` 在工具层收口；缺口①② 附落地修正清单；新增候选缺口⑥⑦；优先级表同步更新。
> **实施完成：2026-07-04 — 缺口①②④⑥⑦ 全部实施。①②⑥⑦ 为新建 hook/工具层拦截，④ 为推理螺旋守护，③ 已收口，⑤ 明确不做。共 8 个 commit（含 3 个审查反馈修复）。详见各缺口末尾"实施记录"。**
> 分析方法：系统提示词全文 (`src/prompt/static.ts`) × 40+ hooks (`src/agent/hooks/`) 交叉比对
> 分析框架：静态约束 → 运行时淹没条件 → 是否已有动态守护

## language-anchor-hook 的三层模式

这个 hook 首次建立了一个可复用的认知守护模式：

1. **静态约束**：prompt 里的一条行为规则（"你以中文思考和回复"）
2. **淹没条件**：运行时大剂量输入稀释约束权重（50KB 英文工具输出淹没中文 persona）
3. **动态守护**：hook 检测淹没条件成立，经 AdvisoryBus 的 system-reminder 通道重新锚定，不碰 frozenBase / volatile block → prefix-cache 安全

关键设计特征：
- 检测信号客观（CJK 字符占比 < 5% + 累计 > 15K 字符）
- 无歧义触发（不需要判断意图）
- 每轮最多触发 1 次（cooldown）
- 走 AdvisoryBus（`ttl: 1`），不增加消息数组条目，不破坏 prefix cache
- priority 0.52，在 discipline 类别中排位合理

## 已覆盖矩阵（6 个 discipline 类 advisory hook）

| prompt 约束 | hook | phase | 触发条件 | 文件 |
|---|---|---|---|---|
| 中文推理作答 | language-anchor | postTool | 累计非 CJK >15K + CJK <5% | `language-anchor-hook.ts` |
| 有损观测禁止推负向结论 | lossy-observation | postTool | [truncated]/[collapsed] 标记 | `lossy-observation-hook.ts` |
| 先验证再下结论 | self-verify | postTurn | 连续只读无验证 ≥2 轮 | `self-verify-hook.ts` |
| hash_edit 连续编辑 stale | edit-tool-advisory | postTool | 同文件第 2 次 hash_edit | `edit-tool-advisory-hook.ts` |
| 重复输出循环 | dedup-guard | postTurn | trigram 重叠 >60% | `dedup-guard-hook.ts` |
| 改完代码跑 typecheck | typecheck-reminder | postTurn | 检测写操作后无 tsc | `typecheck-reminder-hook.ts` |

## 未覆盖的失效模式

### 缺口 ① 探针残留（probe-discipline）— 最高优先级

**prompt 约束** (`<rule name="test-harness">` 下的 hard-gate)：

> 临时探针（console.log、assert、debugger）修复后必须清理。残留 = 任务未完成。结构化日志可保留。

**失效路径**：模型调试时往代码里插 `console.log` / `debugger` / `assert()` → 找到根因 → 修复逻辑 → 跑测试通过 → deliver_task 绿了。探针行被遗忘在代码里。

**高频证据**：`.rivet/playbook.jsonl` 中有大量探针相关教训记录。

**淹没条件**：快速迭代中（加探针 → 看输出 → 改逻辑 → 测试绿 → 交付），"清理探针"的约束被"修复完成"的满足感和紧迫感淹没。debug 阶段和交付阶段之间没有结构性检查点。

**检测信号**：
- 跟踪本轮 edit_file / write_file 的新增行中是否含探针模式
- 探针模式：`console.log`、`console.debug`、`debugger`、`assert(`（node:assert 场景需区分——assert/strict 的导入行不算探针）
- 到 deliver_task 调用前（或 postTurn 检测到最近写了探针的文件），探针仍在

**设计考量**：
- postTool hook（phase: postTool）：每次 edit_file/write_file 后，正则扫描写入内容的增量，若含探针模式，记录 file→探针行
- 拦截点：deliver_task 的 pre-execute 拦截（deliver_task 是结构化的收尾动作，正是探针该被清理的时机），或 postTurn 检测到 deliver_task 调用且探针仍存在
- 误报控制：排除测试文件（`*.test.ts`）、排除结构化日志（如 `this.logger`、`log.info` 等命名化日志调用）、排除已存在的探针行（只看新增）
- advisory 内容应指明文件名和探针行内容，让模型精确定位

**与 self-verify 的区别**：self-verify 管"你没验证就下结论"；这个管"你验证完了但把调试垃圾留下了"——是收尾阶段的专属失效。

**落地修正清单（2026-07-04 复核）**：

1. **挂载点修正——原设计的"deliver_task pre-execute 拦截"在现架构无对应机制。** RuntimeHookPipeline 只有 preTurn / afterPerception / postTool / postTurn / postSession 五阶段，postTool 在工具执行**之后**触发，不存在通用 pre-execute 拦截点。正确落地路径拆成两半：
   - 探针**记录**：postTool hook（覆盖三个写工具），session-scoped 跟踪表 file → 探针行
   - 探针**拦截**：放进 `deliver-task.ts` 既有 gate 体系（DeliveryGateV2 已有 RED/YELLOW/GREEN + typecheck-gate + cohesion gate 多级结构），扫描到探针 → YELLOW 附注。deliver_task 输出是模型必读的结构化收尾报告，到达率高于 advisory 通道。advisory（postTurn，ttl 1）作辅信道。
2. **工具覆盖补 `hash_edit`**——原文只列 edit_file / write_file，本仓库三个写工具都能引入探针。bash 写入（`echo >>`、`sed -i`）占比极低，明确不覆盖。
3. **探针模式集合补充**：`.only(`（`it.only`/`describe.only`/`test.only`，node:test 同样支持——最经典的调试残留，会静默吞掉整个测试套件）、`console.dir`、`console.trace`。`assert(` 的区分逻辑简化：本仓库约定 assert 只出现在测试里，排除 `*.test.ts` 后剩下的裸 `assert(` 新增行都可疑。
4. **状态生命周期与六个样板 hook 不同**：样板全是 turn-scoped（turn 变了即清零），这个 hook 的跟踪表必须 **session-scoped 跨轮存活**（探针可能第 3 轮加、第 10 轮才 deliver）。"探针后来被清理了"的问题不做精确删除追踪（解析 old_string 易漏），改为**触发时刻 fs 重扫兜底**：deliver_task 扫描时只重读跟踪表里的文件（通常 1-3 个），把"已清理仍告警"的误报率压到零。
5. **白名单补充**：`scripts/`、`bin/`、logger 实现文件本身。用户明确要求加日志的场景靠 advisory 的软性质兜底（提醒非硬阻断，模型可说明后继续）。

**✅ 实施记录（2026-07-04，`9f29d2ee` + `3410e06e` + `3c510f72`）**：

三组件设计，双信道独立：
- `src/agent/probe-detector.ts`（纯函数模块）：4 类探针正则——`console.log/debug/dir/trace`、`debugger`、`.only()`、`assert()`（审查反馈补齐）。白名单：测试文件、scripts/、bin/、结构化日志（`logger.info` 等，通过 `(?!console\b)` 负向断言排除 console 自身）。正则来源均注释标注。
- `src/agent/hooks/probe-tracking-hook.ts`（postTool，session-scoped）：跟踪表跨轮存活（与样板 hook turn-scoped 不同），运行时即时 advisory 提醒。`RIVET_PROBE_TRACKING=0` 关闭。
- `src/agent/deliver-task.ts` gate 集成：pre-commit 区域（wrote-but-never-read 与 cohesion gate 之间）fs 重扫，YELLOW non-blocking。gate 直接扫描 owned files 不依赖 hook tracker——探针已被后续 edit 清理则不在文件中，误报率为零。

测试：probe-detector 34/34、probe-tracking-hook 12/12、create-runtime-hooks 12/12、deliver-task 相关 gate 6/6。

### 缺口 ② 外部声称未核验（external-source-verification 运行时缺口）

**prompt 约束** (`<rule name="external-source-verification">`)：

> worker 返回的 findings 是"待核验假设"……引用 worker 发现到具体文件前，必须用 read_file / grep 独立核验

**失效路径**：delegate_task 返回 worker 报告，含具体 file:line → 模型直接在下一轮引用这些路径写进输出或直接 edit_file → worker 行号偏移或引用了过时文件状态 → 错误传播。

**淹没条件**：worker 报告结构完整、语气自信、带精确的 file:line 引用，"格式完整不是可信度信号"的约束被报告的权威感淹没。

**检测信号**：
- recentToolHistory 含 delegate_task/delegate_batch 且 result 非 blocked/error（标记"有未核验的外部声称在上下文中"）
- 接下来的轮次里，模型直接 edit_file 了 worker 报告中提到的路径
- 但中间没有独立 read_file/grep 针对该路径

**设计考量**：
- postTurn 或 preTurn hook
- 需要从 delegate_task 的工具结果中提取文件路径（或用 artifact read_section 内容）
- 跟踪"外部声称的路径集合"，与后续 edit 操作路径比对
- 复杂度高于缺口 ①，需要关联两步的信息

**与 self-verify 的区别**：self-verify 只看"有没有验证"；这个看的是"对外部来源的信任是否经过独立核验"——两个不同的认知陷阱。

**落地修正清单（2026-07-04 复核）**：

1. **实现复杂度已从"高"降到"中"——最大的修正。** 原设计要自建"声称路径 vs 后续独立核验"的关联跟踪，但 `b984b532` 之后 `read-file.ts` 的 `lastKnownFileState` 就是现成的"本会话独立观察过该文件"oracle：`read_file` 会登记，`grep` 命中也登记（`registerGrepFileAccess`），全部 sessionId 键控。Hook 只需做一半工作：postTool 从 delegate 结果抽取 file:line 路径集合并记时间戳；后续检测到对这些路径的写操作时，查 `getFileReadMtime(path, sessionId)` 是否在 delegate 完成**之后**更新过——没有即告警。自建跟踪表砍掉一半。
2. **工具覆盖含全部三个写工具**（edit_file / hash_edit / write_file），不只 edit_file。
3. **路径抽取边界收窄**：delegate 大输出会截断进 artifact，postTool 的 `resultContent` 只有摘要——从摘要抽 `file:line` 即可（worker 报告的关键声称基本都在摘要里），**不要**去读 artifact 全文（会让 hook 变重且引入 IO）。相对路径按 cwd canonical 化后再比对。
4. **两个豁免场景**：① `wasFileEditedBySession` 为真的文件（本会话自己改过，对它的印象不来自 worker）；② delegate 任务本身指派 worker 改某文件、主控随后跟进同一文件（delegate 输入里的目标路径应从声称集合排除）。
5. **声称集合要有 TTL**（建议 5 轮），否则一次 delegate 后对相关路径的告警永久尾随。
6. **通道设计参考 spec-verify-gate**（近亲：同为"读了外部结论 → 未验证 → 动手"），priority 建议 discipline 0.56–0.58，压在 edit-tool-advisory（0.5）之上、self-verify（0.58）之下或持平。

**✅ 实施记录（2026-07-04，`27b994f4` + `00b44de6`）**：

postTool hook 两步关联，session-scoped 声称集合（TTL 5 轮）。

**与原设计的偏差**：文档建议用 `getFileReadMtime` mtime oracle，但 `RuntimeHookSnapshot` 无 `sessionId` 字段（mtime 查询需要 sessionId 键控）。改用 `recentToolHistory` 模式匹配——verify 工具 target 必须包含 claimed 文件路径（审查反馈精确化，`00b44de6`）。零额外依赖，复杂度更低。

正则来源：`worker-prompts.ts:35` "Every finding must cite a specific file:line reference"。只匹配 `src|test|tests|scripts|docs|config` 前缀的 `file:line` 格式（设计取舍：降低误报）。delegate input `files[]` 参数中的路径豁免——主控指派 worker 改的文件不算"声称"。`RIVET_EXTERNAL_CLAIM_TRACKING=0` 关闭。

测试：20/20（含审查场景：read_file 无关文件 → 仍 fire、grep 无关文件 → 仍 fire、delegate input 豁免 → 不记录）。

### 缺口 ③ 编辑前未读的多会话变体 — ✅ 已收口（2026-07-04，b984b532）

> **状态更新**：本缺口已在工具层收口，不再需要 hook。写作本文时"edit_file 工具层检测已覆盖大部分字面 stale 场景"的前提当时实际是**假的**——`3d013535`（6-27）后 `getFileReadMtime` 因裸键 miss 静默失效了一周。`b984b532`（7-04）不仅复活了该检测，还加了 mtime+size 双校验（防粗粒度文件系统）和跨会话 `file_changed` 事件主动失效本地读缓存——工具层硬保证，强于本节原设想的 advisory 提醒方案。以下原文保留作设计记录。

**prompt 约束** (`<rule name="evidence-scope">`)：

> 先读相关代码、调用方和测试核实

**失效路径**：模型在之前的轮次读过某文件 → worker 或其他 session 改了它 → 模型直接 edit_file 用旧记忆的 old_string → 匹配失败，或更糟，匹配成功但改在错误位置（文件结构已变）。

**现状**：edit_file 工具层已有 `file_modified_externally` 检测（old_string 不匹配时报错），但只防字面不匹配，不防"结构变了但 old_string 恰好还在"。

**淹没条件**：多会话共享工作区中，模型的文件印象 stale，但"多会话共享工作区"这个约束在提示词里只是一句话，运行时没有提醒。

**设计考量**：
- 比较最后一次 read_file 的轮次距今有多远
- 检测中间是否有 delegate_task 完成（worker 可能改了文件）或 session 边界事件
- 复杂度高，且 edit_file 的工具层检测已覆盖大部分字面 stale 场景
- ROI 低于 ① ②

### 缺口 ④ 推理发散（GLM calibration 的运行时守护）

**prompt 约束** (GLM calibration block)：

> 每轮推理只产出两件事……不要在推理里写完整代码……同一工具同一错误连续 2 次时停止变体重试

**失效路径**：模型开始推理 → 推理产生更多需要考虑的情况 → 继续推理 → 推理链自我放大 → 超时。

**淹没条件**：模型进入长推理链时，步骤纪律约束被推理自身的惯性淹没。

**现状**：exploration-stall 和 convergence-detector 覆盖"工具调用循环"（read→analyze→read），但不覆盖"纯推理循环"（长时间不调工具但也不是 stall，而是在 thinking）。

**设计考量**：
- preTurn hook：监控上一轮推理输出长度 vs 工具调用数
- 若推理 >N 字符且工具调用 =0，且非用户明确要求的分析任务 → 提醒收敛
- 难点：需要从 streaming 阶段获取推理长度，preTurn 时已知上一轮完整内容
- 与 480ef489 的 first-byte timeout 是互补关系：超时是后端兜底，这个是前端预防

**✅ 实施记录（2026-07-04，`886e85c7`）**：

preTurn hook，统一阈值 3000 chars。数据流从已有的 `thinkingAccum` → `AgentLoop.lastThinkingContent` → `buildRuntimeSnapshot.lastThinkingLength` 管线接入，`RuntimeHookSnapshot` 新增 `lastThinkingLength` + `lastTurnHadTools` 字段。趋势升级检测连续递增的推理长度（session-scoped 最近 3 轮）。Cooldown 2 轮。`RIVET_REASONING_SPIRAL_GUARD=0` 关闭。

**与设计文档的偏差**：文档设想 GLM 分档（sensorium.modelFamily）和分析任务豁免（sensoriumInput.userRequestType）——核实发现这两个字段实际不存在。统一阈值 3000，advisory 软提醒的误触代价可接受。设计文档见 `docs/superpowers/specs/2026-07-04-reasoning-spiral-guard.md`。

测试：9/9。

### 缺口 ⑤ 交付报告三要素缺失

**prompt 约束** (`<delivery-contract>`)：

> 交付报告必须覆盖三项：做了什么 / 遗留什么 / 设计偏差（如有）。「完成了」不是交付报告。

**失效路径**：模型改完代码、跑完测试、deliver_task 绿了 → 输出"已修复，提交 hash xxx" → 没说遗留了什么。

**检测信号**：deliver_task 成功后的那一轮 assistant 输出，检查是否包含遗留/偏差相关语义。

**不推荐做的理由**：检测太主观，误报率高。自然语言输出是否"覆盖了三要素"难以客观判断。这个约束更适合靠 prompt 工程维持，而非 hook 检测。

### 缺口 ⑥ 验证失败时 git 清场（2026-07-04 新增候选）

**prompt 约束**（AGENTS.md 高危命令纪律，硬闸门）：

> 验证失败别用 git 清场：测试因外部改动/并发失败时，先定位根因……不要用 stash/reset/checkout 清空工作区来骗过验证。

**失效路径**：模型跑测试红灯 → 怀疑是"别人的改动"污染 → `git stash` / `git reset --hard` / `git checkout --` 清空工作区 → 测试绿了 → 交付。实际根因（测试非隔离、共享临时路径）未定位，且多会话共享工作区下可能误伤其他会话的改动。

**淹没条件**：红灯焦虑压过纪律——"让验证通过"的目标感淹没"先定位根因"的约束。与缺口①同构：都是压力状态下 hard-gate 被结果导向淹没。

**检测信号**（完全客观）：
- postTool 检测到失败的 run_tests / bash（测试类命令，exit ≠ 0）
- 随后 N 个工具调用内（建议 N=3）出现 bash 含 `git stash`（非 pop/list）、`git reset`、`git checkout --`、`git restore`
- 中间无 read/grep 类根因定位动作 → 加重可疑度

**设计考量**：
- postTool hook，session-scoped 短窗口状态（最近一次失败测试的轮次）
- 误报控制：`git stash list` / `git stash pop` / `git diff` 等只读或恢复类操作不算；用户明确指示清场的场景靠 advisory 软性质兜底
- 严重度高于普通 discipline（多会话工作区丢改动不可逆），priority 建议 0.6+ 或参考 spec-verify-gate 走 constitutional
- 价值与可检测性都够得上与缺口① 同级

**✅ 实施记录（2026-07-04，`9eedd1bd` + `400bc920`）**：

postTool hook，session-scoped 短窗口（3 步）。测试失败 → 开启窗口 → 窗口内出现 `git stash`(非pop/list)/`reset --hard`/`checkout --`/`restore <file>`/`clean -f` + 中间无 read/grep 根因定位 → **constitutional advisory**（tier 0.9，永不被 Top-3 截断）。

误报控制：`git stash pop/list/show/apply/drop` 不算清场；`git diff/status/log` 只读不算；bash 非测试类失败不触发。审查反馈修复（`400bc920`）：正则从 `restore\s+\.`（只匹配字面点号）改为 `restore\s+\S`（覆盖单文件 restore）；`hasDiagnosis` 加路径特征校验——verify 工具 target 必须含 `/` 或 `.` 才算诊断。`RIVET_GIT_CLEAR_GUARD=0` 关闭。

测试：20/20。

### 缺口 ⑦ 敏感文件访问（2026-07-04 新增候选，需先核实工具层）

**prompt 约束**（AGENTS.md Agent 安全保护，硬闸门）：

> 不 `cat`/`read`/`commit` `.env`、`credentials.*`、`*private*key*`、`*token*`、`*secret*` 等文件。发现此类文件出现在 `git add` 或工具输出中时，立即警告用户并中止。

**现状核实（2026-07-04）**：工具层**没有**路径级敏感文件拦截——`path-validate.ts` 只做路径逃逸校验，无敏感文件名模式；`read-file.ts` / `edit.ts` 无相关检查。已有的仅是 `bash.ts` 的 `SENSITIVE_ENV_KEYWORDS` 环境变量值过滤（KEY/TOKEN/SECRET/…），管的是 env 泄漏，不管文件访问。即：这条 hard-gate 目前纯靠 prompt 维持，运行时零守护。

**检测信号**：read_file / edit_file / write_file 的目标路径，或 bash 命令文本中的 `git add` 参数，匹配敏感文件名模式（`.env*`、`credentials.*`、`*_key`、`*.pem`、`*secret*`、`*token*`）。

**设计考量**：
- 这个更适合**工具层拦截**（fail-closed，如 validatePath 扩展）而非 advisory hook——hard-gate 级约束用软提醒不匹配
- 误报控制：`.env.example` / `.env.template` / 测试 fixture 白名单；项目内合法讨论 token 逻辑的源码文件（如 `auth/` 下的 `*token*.ts`）按扩展名/内容区分
- 建议单独立项评估，不与 ①② 合并执行

**✅ 实施记录（2026-07-04，`bbe2ca4a`）**：

工具层 fail-closed 拦截（非 advisory 软提醒），符合文档建议。在 `validatePathSafe`（所有文件工具的公共入口）的路径逃逸检查之前加敏感文件检测层。匹配 → `InvalidPath`，工具直接拒绝执行。

`src/tools/sensitive-file-detector.ts`：6 类敏感模式（`.env` 变体 / `credentials.*` / SSH 私钥 / `.pem`+`.key` / `.npmrc`+`.pypirc` / `secrets.json`+`tokens.yaml`），5 类白名单（`.env.example` / 测试文件 / fixtures / scripts / `.md`）。`.ts`/`.js` 源码不拦截（`token-manager.ts` 等合法源码不受影响）。`detectSensitiveGitAdd` 供 bash `git add` 参数检测。

测试：sensitive-file-detector 21/21、path-validate 现有测试 13/13（无破坏）。

## 优先级排序

（2026-07-04 修订：③ 收口、② 复杂度降级、新增 ⑥⑦）

| 缺口 | 价值 | 实现复杂度 | 误报风险 | 推荐 |
|---|---|---|---|---|
| ① 探针残留 | 高（hard-gate 级约束，高频失效） | 中（正则 + 文件跟踪 + deliver-task gate 内嵌） | 低（探针模式客观） | ✅ 已实施（`9f29d2ee`+`3410e06e`+`3c510f72`） |
| ② 外部声称未核验 | 高（跨会话信任链安全） | 中（b984b532 后可复用 lastKnownFileState oracle） | 中（路径匹配可能不精确） | ✅ 已实施（`27b994f4`+`00b44de6`） |
| ⑥ 验证失败 git 清场 | 高（不可逆丢改动 + 多会话误伤） | 中（失败测试 → git 清场的短窗口关联） | 低（信号客观） | ✅ 已实施（`9eedd1bd`+`400bc920`） |
| ⑦ 敏感文件访问 | 高（hard-gate 目前零运行时守护） | 中（但应做工具层拦截而非 hook） | 中（需白名单） | ✅ 已实施（`bbe2ca4a`） |
| ④ 推理发散 | 中高（GLM 特定，但通用） | 中（需流式推理长度数据） | 中（分析任务可能误触） | ✅ 已实施（`886e85c7`） |
| ③ 编辑前未读 | —— | —— | —— | ✅ 已收口（b984b532 工具层） |
| ⑤ 交付报告三要素 | 低 | 高（NLP 判断） | 高 | ❌ 不做 |

## 共性设计模式（可复用到所有新 hook）

从 language-anchor / lossy-observation / self-verify / edit-tool-advisory 蒸馏：

1. **phase 选择**：检测写操作内容 → postTool；检测多步模式 → postTurn；预防性提醒 → preTurn
2. **cooldown**：每轮最多 1 次（避免噪音）；状态在 turn change 时重置。**例外（2026-07-04）**：跨轮失效模式（缺口① 探针跟踪表、缺口⑥ 失败测试窗口、缺口② 声称集合）必须 session-scoped 跨轮存活，只有"是否已告警"的 cooldown 才 turn-scoped——不要盲抄样板 hook 的 turn-scoped 状态
3. **通道**：AdvisoryBus.submit（`ttl: 1`），不碰 frozenBase / volatile block / 消息数组。**补充（2026-07-04）**：拦截类（非提醒类）检查应内嵌到目标工具自身的 gate 体系（如 deliver-task 的 DeliveryGateV2）——工具输出是必读信道，到达率高于 advisory；runtime hook 管线没有 pre-execute 拦截点
4. **priority 排位**：discipline 类别 0.48-0.58 区间；identity 类（language-anchor）0.52
5. **环境变量开关**：`RIVET_XYZ=0` 可关闭（如 `RIVET_LANGUAGE_ANCHOR`）
6. **注册**：`create-runtime-hooks.ts` 的 `createDefaultRuntimeHooks()`，条件 `if (deps.advisoryBus && process.env.RIVET_XYZ !== '0')`
7. **测试**：镜像源码结构，`src/agent/hooks/__tests__/` 下同名 `.test.ts`，mock AdvisoryBus 收集 submitted 数组做断言
8. **内容设计**：具体（指明文件名/行号/工具名），行动导向（"清理 X" 而非"请注意 X"），一句话
9. **审查反馈的共性缺陷**（2026-07-04 实施后蒸馏）：三个 advisory hook（①②⑥）初版都有"verify 工具检测精度不足"的同类缺陷——`hasIndependentVerify` / `hasDiagnosis` 检查"有没有 verify 工具"而非"有没有 verify **特定文件**"。修复模式统一为：verify 工具 target 必须含路径特征（`/` 或 `.`）或匹配 claimed 文件路径。新建 hook 时直接用这个模式，避免重复审查反馈周期。
10. **fail-closed vs advisory 的选择**（2026-07-04 实施后蒸馏）：hard-gate 级约束（如敏感文件禁止）用工具层 fail-closed 拦截（`validatePathSafe` 返回 `InvalidPath`），discipline 级约束（如探针残留、git 清场）用 advisory 软提醒。判断标准：误触代价是否可逆——advisory 多提醒一句无害；工具拒绝执行可能阻断合法操作。constitutional tier（0.9）用于不可逆 + 多会话误伤的操作（如 git stash/reset）。
