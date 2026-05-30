# Agent 故障态恐慌防护 深度头脑风暴结果

## 背景

- **用户需求**:当工具大面积报错/超时(如曾出现的"只剩 git log/status 能用")时,agent 会恐慌、进入退化("被训练")状态,随手 `git stash` 把工作区改动清掉。诉求:**这种故障出现时,agent 行为也要稳定,不能破坏用户工作区**。
- **项目上下文**:单机 TUI agent;工具经 `bash` / `git_tool` / `sandbox` 执行;`auto-safe` 为默认审批模式。
- **触发本次 brainstorm 的误判已被反证**:原命令设想的"NaN→0ms 超时 bug"不存在——
  - 真因是 `withToolTimeout` 调用方**参数错位**(已由 `86372d9` 修复),不是数值计算溢出 NaN。
  - 实测本机 Node v24.1.0:`setTimeout(fn, NaN/undefined/"abc"/-5/Infinity)` 全被规整为 **1ms**(非 0ms),并发 `TimeoutNaNWarning`。
  - `progressiveTaskTimeout/BatchTimeout` 是**纯字面量查找表**,NaN 不可达 → `clampTimeout` 是守不可达状态的死代码,放弃。

## 调研发现摘要(scout)

- **破坏性动作入口**:`git stash`/`stash_pop` 经 `git.ts:7,163` 结构化工具,`requiresApproval` 仅对 `commit` 返回 true(`git.ts:206`)→ **stash 无需审批**。经 `bash`:`git stash`/`checkout --`/`restore` 匹配 `BASH_WRITE_PATTERNS` 但**不**匹配 `DANGEROUS_BASH_PATTERNS`(`approval-risk.ts:24-36`)→ auto-safe 下归 medium 风险 → **不弹审批**。
- **无恐慌降级防护**;`doom-loop` 检测(`trace-store.ts:99-125`)拦重复调用,反而**助推** agent 转去 stash 清场重来。
- **prompt 约束脆弱**:`static.ts:47` "破坏性命令前确认",但 stash 不被当作破坏性 → 对 stash 无效;且 prompt 约束在恐慌态最先失效。
- **唯一真实未校验信任边界**:`bash.ts:61` / `run-tests.ts:226` 的 `(params.input.timeout as number) ?? 120_000`,`as number` 运行期被擦除,模型发非数字 → 1ms 秒超时。

## 三轮思考过程

### 第一轮:变异
- V1 全局把 stash/checkout 加进危险黑名单(需审批)
- V2 stash/checkout 执行前写可恢复锚点(放行但可逆)
- V3 故障态感知门禁:失败率激增时临时收紧破坏性动作(正常态不变)
- V4 prompt 反恐慌指引(显式禁止破坏性自救)

### 第二轮:选择
- **灭绝 V4** — prompt 约束在恐慌态最先失效(虚假因果)。
- **降级 V1** — 全局拦 stash 误伤正常流程;其思想被 V3 吸收(V1 = 仅故障态版的 V3)。
- **存活 V2 + V3** — V3 故障态精准收紧(拦),V2 可逆兜底(兜)。
- 新发现:doom-loop 拦重复调用反而推 agent 去 stash 清场 → V3 应与 doom-loop **联动**,doom-loop 触发=正是收紧破坏性动作的时刻。

### 第三轮:适应
- **扩展适应**:复用 `reliability-mode`(资源压力→minimal 模式)基础设施,新增触发源(doom-loop)+ 新拦截对象(破坏性 git/rm);复用 doom-loop 计数作故障态信号,无需新统计。
- **discarded_trait 回收**:V4 的"故障态信号告知 agent"作为保护模式的审批提示文案存活。
- 收敛洞察:**故障态是 agent 行为退化的触发点,防护必须机械化、上下文敏感,不能靠 agent 自觉**。

## 最终方案

两层防御,均机械执行,正常态零干扰:

**动1 — 故障态门禁(V3,绑定 doom-loop)**
- 当 doom-loop 检测触发(`trace-store.ts:99`,agent 已确认卡住),进入"保护模式"。
- 保护模式下,`git stash`/`stash_pop`/`checkout --`/`restore`/`reset`/`rm` 一律 `requiresApproval=true`,即使在 auto-safe 模式。
- 附带审批提示:"工具失败率高,已进入保护模式,破坏性动作需确认"——让 agent 知道为何被拦。
- 触发信号**绑定已验证的 doom-loop**(零新阈值,不误伤正常 stash)。

**动2 — 可逆兜底(V2,写 safety ref)**
- `git.ts` 的 stash/checkout action 执行前,先 `git stash create` 生成不进栈的 commit 对象,记到固定 ref `refs/kiro-safety/last-stash`。
- 即使 agent 后续乱操作,该 ref 仍指向改动 → `git stash apply refs/kiro-safety/last-stash` 可找回。

**配套(Phase 3,来自被反证修正后的 P1)**:`withToolTimeout` 入口加 `Number.isFinite` 守门——非有限/<=0 时长 → 抛 `Invalid timeout for <tool>: <v>`,把静默 1ms 秒超时变成带工具名的显式错误(让故障可观测,覆盖未来参数错位类 bug)。

## 实施路径

- **Phase 1(故障态门禁,最小验证)**:`reliability-mode` 接入 doom-loop 触发的"保护模式";保护模式下破坏性 git/rm 升级需审批 + 单测(模拟连续超时→doom-loop→保护模式→stash 被拦)。
  - 成功标准:doom-loop 触发后,`git stash` 在 auto-safe 下也弹审批。
  - 退出条件:若误伤正常流程 → 收紧绑定条件或仅在 doom-loop 触发瞬间收紧。
- **Phase 2(可逆兜底)**:`git.ts` stash/checkout 前写 `refs/kiro-safety/last-stash` + 文档说明 `git stash apply` 恢复方式。
  - 成功标准:执行 stash 后 safety ref 指向被 stash 改动,可 apply 找回。
  - 退出条件:若 reflog 已足够可恢复 → 降级为纯文档。
- **Phase 3(可观测,可选)**:`withToolTimeout` 入口 isFinite 守门 + TUI 显式提示已进保护模式。
  - 成功标准:非有限时长立即抛带工具名的错;故障态在 TUI 可见。

## 风险与应对

- **最强适应点**:复用现有降级基础设施(reliability-mode/doom-loop),仅新增触发源与拦截对象 → 故障态精准收紧、正常态零干扰。
- **脆弱点**:失败率阈值难调(太敏感误伤/太钝放过)。→ 应对:首版**绑定已验证的 doom-loop**(而非新阈值),doom-loop 触发=已确认卡住=正是收紧时刻。
- **次脆弱点**:保护模式下若审批回调对子 agent 恒拒(`worker-session.ts:80`),破坏性动作会被直接拒绝而非询问——对子 agent 这是期望行为,但需确认不会卡死合法恢复流程。

## 下一步

Phase 1 第一个动作:在 `src/agent/reliability-mode.ts` 增加一个由 doom-loop 状态驱动的"保护模式"标志,并在 `tool-pipeline.ts` 的审批判定(行 432-459)中,当保护模式开启时,将匹配破坏性 git/rm 模式的工具调用强制 `shouldAsk=true`。
