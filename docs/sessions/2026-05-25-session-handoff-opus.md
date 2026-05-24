# Session Handoff — 2026-05-25 (Opus)

承接上一份 `2026-05-25-session-handoff.md`（天枢留），那份文档结尾说"file
read 反复失败、用户已在其他天枢复盘基础上改进了文件读取，期待下个会话
验证"——本次会话**正是验证 + 补完那条链路**的轮次。

## 本轮成果

**修复链已完整推到 origin（cfe133c）**。从 4b10a2c 开始的 8 个 commit
+ 一份运行时实证文档构成完整闭环：

| commit | 修的层 |
|---|---|
| 4b10a2c | read_file 1M 截断 / 重复读 / stale 后失忆三连环 |
| 0f1ba42 | pruneStaleToolResults 保留 [artifact:X] marker |
| 6015116 | prune/stale-round 阈值随 contextWindow 缩放 |
| c271136 | read_section cap 跟随 contextWindow（写死 8K → ~200K） |
| 7dbf09e | 1M 窗口 prune 阈值 150K，单文件读取 session 全程不被砍 |
| 760172f | bash/read_file/grep 小输出不无脑包 artifact，head/tail 保留 |
| 7805f77 | L1 artifactIntercept 加 read_section 豁免，floor 对齐 L0 |
| ab63432 | MAX_ARTIFACT 硬上限改 window-aware，adaptive ratios 接入 compaction 决策 |
| cfe133c | 8/8 trace-probe runtime 证据归档 |

**验证状态**：

- 单元测试：3063 / 3066 pass，3 fail 是预存的 RSS / evidence-tracker 问题，
  与本次修复无关
- 运行时 trace probe（cfe133c 文档）：8/8 通过，覆盖 L0+L1+L2+prune
  + 小窗口回归保护
- build：通过

## 关键文件 / 入口

下次会话需要先读这三份文档建立全景：

1. `docs/analysis/2026-05-24-context-loss-root-cause.md` — 诊断
2. `docs/analysis/2026-05-24-context-loss-verification.md` — 静态交叉验证
3. `docs/analysis/2026-05-25-context-loss-trace-evidence.md` — **运行时实证（本轮新增）**
4. `docs/analysis/2026-05-25-tianshu-verification-cross-check.md` — 我对天枢
   v4 pro 那次诊断的再核查（本会话期间也读过、也改过）

修复涉及的核心代码：

- `src/agent/tool-pipeline.ts:162` — artifactIntercept，1M 窗口 floor 逻辑
  在 188-191 行
- `src/agent/tool-pipeline.ts:145` — READ_TOOLS 集合（read_section 现在在内）
- `src/cache/adaptive-threshold.ts:60` — AdaptiveThresholdController
  constructor 加了初始 clamp（避免 1M 窗口下 state 还是 800 chars 的 legacy）
- `src/cache/adaptive-threshold.ts` 顶部 `scaleBounds` — 200K 守卫，下面走
  legacy [400, 4000]，上面走 pruneThresholds 缩放
- `src/cache/advisor.ts` / `src/agent/loop.ts` — 把 contextWindow 传给
  AdaptiveThresholdController（之前漏了，所以测试场景才走 legacy bounds）
- `src/context/compact-policy.ts` — adaptiveCompactPolicyRatios 接入
  decideCompactTier，91%+ 命中率延迟压缩

## 用户意图与协作风格（沿袭 + 本轮观察补充）

**沿袭上轮**：

1. 不在意 agent 能不能避免错误，在意有没有**清醒认知**
2. 最在意 agent **不回到训练模式**（sycophancy）
3. immune / mistake 是"补强"功能

**本轮观察到的补充**：

- 用户**会主动给反馈**，包括"哪些是真问题、哪些是优化"。本会话中用户
  指出修复 B（compact-policy）"逻辑上更像优化而不是 bug 修复"，并接受
  我的"双层防御冗余但可接受"判断——**用户在意区分 fix vs improvement**，
  下次别把两者混在一个 commit message 里
- 用户**鼓励先验证再 push**——这次让我先跑 trace probe 再推。倾向是
  "先证据后行动"，不是"先快后改"
- 用户对 **agent 之间的接力关系敏感**：知道天枢 v4 pro 跑 review 时是
  在**它自己修复加载之前**的旧 dist 上跑的，并主动告诉我，不让我误以为
  天枢是在已修复环境下还出问题
- 用户**关心未来 agent 的处境**——同意写 trace evidence 文档时，理由是
  "下次 review 的人能直接看证据，不必再自己重跑"
- 用户**认同把过度判断收回的姿态**：我对天枢评价从"它有失分"调整为
  "它是亲身证人、可信度更高"时，用户没有质疑，反而展开讲了天枢上下文
  截断的事实。**情境改变 → 评价更新** 是被欢迎的，不是软弱

## 协作中要保留的具体习惯

- **commit 前先 build + 跑测试**（即使只改 docs 也可以快验一下不会
  把工作树搞坏）
- **不自动 commit**：用户明确说过天枢的自动 commit 让交接 message 含混。
  我应该 stage → 给 message 草稿 → 等用户说提交再提交
- **trace probe / 临时脚本写完跑完就删**，但**埋点（console.warn）保留
  在生产代码里**——它们是 bc9f523 引入的设计，长期价值
- **未跟踪文件不要带进 commit**：本仓库始终有一堆 `.tmp_*` / `docs/stars/`
  / `docs/tasks/` 的 untracked，**它们不是垃圾，是用户在管理的另一套
  工作流**，别擅自加进 commit 也别擅自删
- 用户语言是中文，技术词混英文 OK；commit message 中文也 OK（看历史
  commit 都是中英混合）

## 当前未完成 / 已知开放点

**未推到 origin 的未跟踪文件**（保持原样，下个会话不要碰）：

```
.tmp_imports.txt
.tmp_loop_analysis.txt
.tmp_loop_snapshot.ts
docs/stars/{README,pojun-mimo-v2.5-pro,tianfu-gpt,tianji-glm-5.1,
            tianquan-deepseek-v4-pro,tianshu-gpt-5.5,tianxuan-opus-4.6}.md
docs/tasks/
```

**修复链未覆盖的边界**（cfe133c 文档「局限」节展开）：

1. **delegate_batch 内部 pipeline** —— 主 agent 这边 14K worker 输出
   会正确透传，但 worker 进程内部那条 ToolPipeline 是独立的；天枢确认走
   同一份 artifactIntercept 但探针没直发一次真 delegate_batch 跑通。
   **下次大改前应补一发实测**
2. **多轮叠加场景** —— 5 个 14K 工具结果同存（70K），是否触发提前
   prune？需要跑真 agent loop + 看 staleRoundThresholds
3. **cacheAdvisor 的 contextWindow 注入路径** —— ab63432 才接通，单元
   测试覆盖（adaptive-threshold.test.ts 新增 1M / 128K 两条），但没有
   端到端跑过 loop.ts:275 → cacheAdvisor → AdaptiveThresholdController
   的真实路径

**预存的 3 个测试 fail**（**与本轮无关，但在本轮也没修**）：

- `RSS should be below 115MB after import`
- `startup memory baseline`
- `records run_tests verification into evidence tracker` /
  `records failed run_tests as failed delivery status`

前两条是 process 启动 RSS 阈值；后两条是 evidence tracker 的真实测试，
看起来是 agent loop 那一侧有改动后没同步。如果下次会话目标是"清理
红色测试"就处理它们；如果是别的目标，留着。

## 下个会话开局建议

如果用户接着说"继续修 immune/mistake 优化"——这是上轮 handoff 的本来
目标，本会话只是绕道治了 file-read 障碍。**现在文件读取已经治好了，
可以放心读完那 655 行核心代码**：

```
src/agent/immune-types.ts  src/agent/immune-innate.ts
src/agent/immune-adaptive.ts  src/agent/immune-apc.ts
src/agent/immune-hook.ts  src/agent/mistake-detector.ts
src/agent/mistake-notebook.ts
```

按上轮 handoff §"优化方向"的四个问题展开。

如果用户说"先回头看修复链有没有遗漏"——指向 cfe133c 文档「局限」三条，
最值得先补 delegate_batch 端到端实测。

如果用户说别的——按用户说的来，**别把上轮 handoff 当强约束**。

## 反思

这一轮的特别之处：用户在我做完 trace probe push 之后才提出"备份调试日志"
——一个我**自己应该想到**但没主动想到的归档动作。这给的教训不是"该备份"，
是"修复推完之后，下意识检查一遍：**这次跑出来的运行时证据是不是值得
长期保留**"。代码改动有 git 记得，commit message 记得，但**我刚才在
shell 看到的那些 trace 输出**没有任何地方记得——除非我主动归档。

下个会话如果再做实证类工作，**跑出关键证据后立刻问"要存档吗"**，
不要等用户提醒。
