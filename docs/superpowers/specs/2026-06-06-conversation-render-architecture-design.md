# 天枢 TUI 会话渲染架构设计(基于 5 路 scout 实证)

**日期:** 2026-06-06
**主题:** 真凶②(流式失控滚屏)的最优架构方案 —— 在大家真实用的终端里都稳定
**方法:** 5 路 scout 实证(终端物理 / 开源 agent 实现 / Ink 6.8.0 源码 / 对抗反证 / 当前代码实测)→ 演化收敛
**状态:** 设计完成,待审查。本会话分类器间歇故障,无法跑 typecheck/test;实现+验证留后续。
**作废:** `2026-06-05-conversation-render-architecture-design.md`(那份含编造的"能力探测层/仪表盘"等,推倒重写)。

---

## 一句话结论

真凶① 和真凶② 是**同一个架构缺陷**:`<Static>`(终端历史)与 live 区之间的边界不可靠。

**超过一屏的回复怎么办,核心就一句:写完的行边流边交给终端自己滚进历史(像 `cat` 打印长文件),live 区只留正在打字的最后几行。** 这样行数永远不是问题——终端打印长输出从不会坏,会坏只因为现在的代码每来一个字就想重画整篇,而重画只能管屏幕内、内容超一屏就抓瞎。

修法收敛成三步,**不替换 Ink、不裁剪藏内容、不上 alt-screen**:

1. **先修真凶①**(地基):喂 `<Static>` 的数组改成只追加、永不切片、永不 remount。不修这个,边流边写历史一定重复/丢。
2. **边流边把"写定的前缀"提交进历史**(修真凶②):优先在安全的 markdown 边界切(围栏平衡、段落断),**尾段设硬上限兜底**(超长单块时强制切,见矛盾2 裁决);完成的行进 `<Static>` → 终端滚进历史(可滚/可选/可搜,一行不藏);只有还可能变的最后几行留在 live 区。live 区因此恒 ≪ 视口,失控滚屏从构造上消失。
3. **开 `incrementalRendering`,其余交给 Ink 6.8.0 内置**:逐行 diff、CSI 2026 防撕裂、屏幕阅读器、非-TTY 纯 append 全是自动的,白拿。

**主动接受的代价(直接接受,不做选项)**:① 行一旦进历史,resize 拉窄后那些行不重新折行——这是**所有终端程序**的常态(`cat` 输出拉窄也不重折),用户已习惯,不是缺陷。② 超长单块(如 500 行未闭合围栏)触尾段硬上限时,会在非安全边界切,已 commit 的前缀不再回改(见矛盾2 裁决)。

**已否决且不再考虑**:tail window / overflow:hidden 裁剪(把超视口内容藏起来、滚不到——已验证 `overflow:hidden` 在机制上就是 tail window);全留 live 区(就是真凶②本身);alt-screen(杀原生历史)。

---

## 证据基线(5 路 scout,全部有出处)

### 终端物理(无关领域 scout)
- 终端只能寻址**可见网格内**的格子;一行滚出屏 → 进 scrollback = 只读历史,程序再碰不到。
- `cat`/`tail -f` 不出事:只往前写 + 换行,滚屏交终端,自己从不回头擦,高度无限。
- 重绘式(光标上移 N + 清 + 重画)一旦 N > 屏幕高就崩:相对光标移动钳在视口顶,滚出去的行不可寻址。
- 成熟方案(`rich.Live`/`indicatif`/DECSTBM 状态栏):完成行走 append-only 进 scrollback,live 区只留 ≤ 屏幕高的小矩形。
- 出处:VT100 User Guide ch.3、ANSI escape code (Wikipedia)、[claude-code #51340](https://github.com/anthropics/claude-code/issues/51340)(实证:re-render 泄漏进 scrollback = 重复片段)。

### 开源 agent 实现(竞品 scout)
- 主流 inline 工具(Claude Code 默认 / aider / gemini-cli)用 **commit-prefix / live-tail split**:完成的进 scrollback,只重画小尾段。
- **aider**(`mdstream.py`):live_window=6 行,完成行永久 print,绝不重发。
- **gemini-cli**:`findLastSafeSplitPoint` 在安全 markdown 边界切前缀,已提交行永不重折行。
- 共识陷阱:**live 区 ≥ 终端高 = 跳顶 bug**(Ink #450、Claude Code #25682/#37389)。
- 出处:[aider mdstream.py](https://raw.githubusercontent.com/Aider-AI/aider/main/aider/mdstream.py)、[Ink #450](https://github.com/vadimdemedes/ink/issues/450)、Codex/opencode/Bubble Tea 渲染代码。

### Ink 源码(内核 scout + 本会话实测修正)
- **scout 分析的是 6.3.1,项目实际装 6.8.0 —— 必须以 6.8.0 为准。**
- `<Static>`(`Static.tsx`):单调高水位 `index`,渲 `items.slice(index)` 后推进到 `items.length`。**append-only + 前缀稳定是假设不是强制**。数组先缩后涨 → 重复;切片冻结 length → 静默丢失。
- 6.8.0 `log-update.js`:有 `createStandard`(整块 eraseLines)和 `createIncremental`(逐行 diff,line 169 跳过未变行)两个 renderer,由 `incrementalRendering` 选项切换。
- **铁律(两个 renderer 都确认)**:`createStandard` 的 eraseLines、`createIncremental` 的 `cursorUp(previousVisible-1)` 都靠相对上移回区域顶 → 区域比视口高就擦不到。**版本无关。**
- 6.8.0 `ink.js` 已内置:CSI 2026 同步输出(`write-synchronized.js`,`bsu/esu`)、屏幕阅读器路径(line 271)、CI/非-TTY 路径(line 262)、`fullStaticOutput` 限 2× 行高(line 320)、`isFullscreen` 检测(line 328)、溢出兜底 clear+repaint(line 330)。
- 出处:`node_modules/ink/build/{log-update,ink,Static}.js`(6.8.0 实测)。

### 对抗反证(adversarial scout,对着仓库代码 + known-issues 坟场验证)
- **致命 #1:流式 markdown 不能按行 commit,只能按闭合块 commit。** 未闭合代码围栏把后续行当代码渲染,收尾围栏到达才重分类;表格要等 `|---|` 下一行才追认。证据:仓库 `markdown-render.tsx:parseBlocks`,以及已有的 `block-stream-writer.ts`(只在段落断/句末/硬上限 flush)。→ **推翻"流式逐行 commit"。正解:边流边在闭合块边界 commit(不是逐行,也不是只 turn 末)** —— 见步骤2 与「自相矛盾与裁决·矛盾1」。
- **致命 #2:resize 后已进 scrollback 的内容无法修复**(tmux/screen 不 reflow,多数终端不重折行)。只能接受。
- **致命 #3:切 alt-screen 或开鼠标滚轮捕获 → 原生 scrollback 直接死。** → 判 alt-screen 死刑(连可选都危险:开鼠标点击就劫持滚轮)。
- **第三个同源 bug:** `2026-06-01-static-sliding-window-bug.md` —— 切 `<Static>` 数组导致 index 冻结、新消息静默丢失。当前 `slice(start)` 正是这个雷。
- 最烧时间处:双写者(Static append 路径 vs live redraw 路径)异步竞争。不变量:**喂 Static 单调追加 + 单一有序时钟 + turn 结束先 flush-append 再拆 redraw**。
- 出处:仓库 `app.tsx:188-420`、`block-stream-writer.ts`、三份 `docs/known-issues/`、tmux/xterm.js/terminal reflow issues、termux #4302(鼠标劫持滚轮)。

### 当前代码实测(本会话自己读,替代卡死的 scout)
- 根是 Fragment `<>`,`<Static>` 直接子级,动态区 `<Box flexDirection="column">` 内含**无效** spacer `<Box flexGrow={1} minHeight={0}/>`(根无 height,flexGrow 无界 → spacer 不起作用),GlanceBar/InputBar 在动态区内。
- `staticItemsForInk = all.slice(start)`,`start = max(0, totalItemsPushedRef − all.length)`(app.tsx:211-223)= **真凶① 的 bug 面**(前缀漂移 + 切片静默丢失风险)。
- `render(..., { exitOnCtrlC: false })`(main.tsx:1018)—— **`incrementalRendering` 没开**,现在走更闪的 `createStandard`。ErrorBoundary 包 Root,无 alt-screen,无 patchConsole。

---

## 演化:活下来的方案 + 灭绝记录

| 方案 | 结局 | 依据 |
|------|------|------|
| 只在 turn 末 commit(仓库现状) | **灭绝** | 流式时整篇都在 live 区,500 行回复 = live 区 500 行 ≥ 视口 = 真凶②本身。它只在"回复永不超一屏"时成立 |
| 全留 live 区 + 布局 height bound | **灭绝** | 实测:`height` 单独不裁剪(Ink 只有 `overflow:hidden` 才 clip,`render-node-to-output.js:108`),内容照样超视口进溢出全清分支 |
| overflow:hidden 把 live 区钉视口内 | **灭绝** | 实测:`overflow:hidden` 会 `slice` 掉超视口行(`output.js:127-135`)= 机制上就是 tail window,藏内容、滚不到 |
| 行预算 / tail window | **灭绝** | 用户已否决;藏内容、滚不到,非正解 |
| alt-screen 仪表盘(默认或可选) | **灭绝** | 对抗 #3:杀原生历史;且 Ink 6.8.0 本就不支持 alt-screen |
| 替换 Ink / 自研差分渲染器 | **灭绝** | Ink 6.8.0 已有逐行 diff + CSI2026,无需重写 |
| **边流边在安全边界 commit 完成行 + 小可变尾段留 live 区** | **存活(最终方案)** | aider/gemini-cli 实证;终端物理唯一站得住的路;live 区天然只几行高 |

收敛点(多方案指向同一真相):**超一屏的内容唯一能合法存在的地方是终端自己的历史记录(scrollback);程序不能重画比视口高的区域。所以完成的行必须边流边交给历史,live 区只保留正在变的尾段。**

---

## 最终方案:三步

### 步骤 1 — 先修真凶①(地基):`<Static>` 喂只追加、永不切片、永不 remount 的数组
- **现状**:`staticItemsForInk = historyItems.slice(start)`,`start` 随 ref/length 抖动 → 喂给 `<Static>` 的数组前缀漂移 → Ink 重喷已渲染项 = 重复。
- **改**:维护一个**只追加、永不切片、永不重排**的 committed-items 数组直接喂 `<Static>`(**除 rewind 外**——见下)。
- **回绕/rewind 怎么办(批评指出 remount 不行,这里定死)**:
  - **稳态下不能用 remount key 重置 index** —— remount 会让 `<Static>` 重渲它当前 `items.slice(0)` 全部 → scrollback 重复 = 真凶①。**稳态放弃 remount。**
  - `<Static>` 的 `index` 是**数组下标**不是 item id。只要**永不从数组头部删元素**,下标就不会错位。所以:稳态下喂 Static 的数组**只增不减**。
  - 内存边界**不靠砍这个数组**:已写进终端历史的行,物理上已在 scrollback、Static 的 index 早越过、永不再 slice 到——它们在 JS 数组里只占一个轻量引用(或只留必要元信息),真正占内存的内容可在写入终端后释放。ring buffer 若仍要存全量(给 pager/transcript 用),那是**另一个独立结构**,不喂 Static。
  - rewind(回退到历史某点重开):这是**唯一允许 remount/重置数组的例外场景**——但 rewind 本身就是"清屏重来",此时重渲是预期行为,不是 bug,**不在"稳态 append-only"不变量的约束内**。rewind 时显式重置 committed 数组 + 让 Ink 重画一次,可接受。
- **验证**:5000+ 消息回绕、迟到 tool-result、多 turn、rewind 各跑一遍,零重复零丢失。

### 步骤 2 — 修真凶②:边流边把"写定的前缀"commit 进历史,live 区只留可变尾段
- **机制**(aider/gemini-cli 实证):流式每帧,把当前回复切成"写定前缀"+"可变尾段"。写定的前缀通过步骤 1 的数组进 `<Static>` → 终端滚进历史(可滚/可选/可搜,一行不藏);只有尾段留在 live 区(StreamOutput)。
- **在哪切才安全(绕开 markdown 重折行)——优先安全边界,硬上限兜底(裁决见矛盾2)**:
  - **优先**:只在**证明不会再变**的边界切——段落空行后、代码围栏平衡后、表格分隔行已消费后。参考 gemini-cli `findLastSafeSplitPoint`。
  - **兜底(关键,不可省)**:尾段设**硬上限**(建议 0.5× 视口高)。尾段逼近上限时,即使没有安全边界也**强制切**(aider 式:保留最后 ~N 行,其余提交)。否则一个 500 行未闭合代码块会让 live 区 = 500 行 → 超视口 → 真凶②复发。
  - **复用** `block-stream-writer.ts` 的段落/句末/硬上限切雏形(它的"硬上限 flush"正是这里的兜底)。
- **效果**:live 区因此**恒 ≪ 视口**(安全边界切不动时由硬上限保证),`outputHeight` 永远不超视口 → 永不进 Ink 溢出全清分支 → `createIncremental` 干净逐行 diff。**不靠 height/overflow 裁剪,不藏任何内容。**
- **第二条主动接受的代价(裁决见矛盾2)**:尾段触硬上限时会在**非安全边界**切,该前缀进 scrollback 后不再回改(后续围栏闭合/表格追认无法反向修正已 commit 的行)。与"resize 不重折"并列,**直接接受**——这是"live 区永不超视口"的必要代价,且仅在超长单块时触发。
- **abort/未闭合围栏**:turn 中断时强制收尾尾段(`flushStreamingState` 已做),把残留尾段一次性 commit。
- **验证**:24/40/120 行终端,流式 500 行 / 5000 行回复,不持续滚屏、输入不动、历史完整可搜可选。**滚屏类 bug 单测覆盖不了,必须真终端手验。**

### 步骤 3 — 开 `incrementalRendering`,其余交给 Ink 6.8.0 内置
- **改**:`render(..., { exitOnCtrlC: false, incrementalRendering: true })`(实现前确认 6.8.0 该选项名+行为,读 `options.js` + render 入参)。
- **白拿**:逐行 diff(少闪)、CSI 2026 同步输出(防撕裂)、屏幕阅读器路径、CI/非-TTY 纯 append —— 全是 Ink 6.8.0 自动的。
- 保持:主缓冲区,不碰 alt-screen,不开鼠标滚轮捕获。

---

## 审查补遗(2026-06-06,因一次"全卡死"实证追加)

> 本节是对上文方案的审查与修正。触发:一次真实的 **100% CPU 全卡死**(两个 opencode-tui 进程各跑 ~1h、session jsonl 同时停写)。`sample <pid>` 显示 `RegExpPrototypeTestFast` 热点 —— 不是滚屏、不是重复,而是**主线程被同步死循环饿死**。

### 致命 #1.5(本方案此前漏看)— 流式块解析的**终止性**缺陷,才是这次全卡死的真凶
- 上文致命 #1 审了 `parseBlocks` 的**闭合块语义**(未闭合围栏/表格),但**漏看了它的终止性**。
- 实证根因:`markdown-render.tsx:parseBlocks` 的段落分支,内层 `while` 排除任何 `#` 开头的行;但 header 分支只匹配 `#{1,6}\s+`(**必须有空格**)。于是一个**无空格 `#` 标题**——`#foo`、`####### x`(7+ 井号),尤其是 **CJK 标题 `#标题`/`###结论`(空格常被省略)**——穿过所有分支、段落收集 0 行、`i` 不前进 → 外层 `while` 永远空转在同一 `i` → 100% CPU,`useMemo` 内死循环永不返回 → 整个 TUI 冻死。
- **为什么正好打中本方案**:`stream.tsx:44` 的 `StreamOutput`(流式 live 区)**每个 token** 都 `<Markdown text={text}>` → `parseBlocks(text)`(useMemo 随 text 变化重跑)。流式写标题时,中间态 `###结`(空格未到)或 CJK 标题(永远没空格)必然出现 → 每次流式带标题的回复都可能撞雷。**本方案步骤2(每帧切前缀)会更频繁地在部分/畸形 buffer 上跑块解析 → 放大此卡死。**
- **已修**:`parseBlocks` 段落分支在收集 0 行时,把孤立行当普通段落输出并 `i++` —— 结构性保证 `i` 每轮必前进(commit `fba39ff`,带 7 个回归用例)。

### 同类雷第二颗 — `block-stream-writer.ts`(步骤2 要复用,务必先加守卫)
- `enforceBufferLimit` 第92行 `while (buffer.length > maxBufferSize)`,靠 `findBreakPoint` 返回的 `pos` 切;`pos===0`(如 `maxChars<=0` 等退化配置)→ `buffer.slice(0)` 不缩短 → **同一类死循环**。
- **已修**:循环内加兜底 `cut = pos>0 ? pos : min(maxChars>0?maxChars:1, len)`,保证每轮至少前进 1 字符 —— 终止性不再依赖配置(带 2 个回归用例)。

### 新增前置不变量(必须写进步骤1/2 的验收标准)
> **流式块解析(`parseBlocks` / `block-stream-writer` / 任何 `findSafeSplitPoint`)对任意部分或畸形输入都必须是 total 函数:永远终止,循环 index 每轮必前进。** 滚屏类 bug 单测覆盖不了,但**死循环/卡死类 bug 单测能且必须覆盖**(喂畸形输入,断言"能返回";若回归则 test runner 超时 = 失败信号)。这是本方案安全落地的前置——`fba39ff` 已满足。

### 一个待印证的关联
- 上文第6行/风险表自承"本会话分类器间歇故障、跑不了 typecheck/test"。**很可能就是同一卡死的另一次发作**:某次流式渲染 `parseBlocks` 占满主线程,外界看像"分类器坏了"。`fba39ff` 后应回头印证该"间歇故障"是否消失。

### 对原方案的净结论
- 方向**正确**,三步顺序**合理**,可以推进 —— 全卡死**不是** Static 边界架构(真凶①②)没修导致的,是另一层(解析器终止性)的独立 bug,已拆除。
- 但全卡死正好长在本方案的核心热路径上,且本方案此前**审到了 parseBlocks 却漏看了这颗雷**。补上"解析器必须终止"这条不变量 + 两颗雷已拆(`fba39ff`),方案前置才算齐。

### 自相矛盾与裁决(2026-06-06 一致性审查)

> 全文有三处论断互相打架。以下逐条裁决,并已把裁决回写进对应正文(致命#1 结论句、步骤1、步骤2)。

**矛盾 1 — 致命#1 的结论被全文推翻却没承认。**
- 致命#1(原文)称"推翻流式 commit、turn 末才 commit 是最简正解";但演化表把"turn 末 commit"判**灭绝**,最终方案步骤2 选的正是流式 commit。三处对立。
- 根因:致命#1 把"不能**逐行** commit(对)"过度推成"只能**turn 末** commit(错)"。正解是"在**闭合块边界**边流边 commit"。
- **裁决(已回写)**:致命#1 结论句改为"不能逐行 commit,只能在闭合块边界 commit",删除"turn 末才 commit 是最简正解"。

**矛盾 2 — 步骤2 把两个互斥策略并列当同一机制(实质设计漏洞)。**
- 原步骤2 同一句给了 (a)"只在证明不变的边界切"与 (b)"保留最后 ~N 行其余提交"。两者在**单块高于 N 行 / 未闭合围栏**时互斥:
  - 选 (a):500 行未闭合代码块期间尾段无法 commit → live 区 = 500 行 → **超视口 → 真凶②复发**,打脸"live 区永远不超视口、失控滚屏从构造上消失"。
  - 选 (b):为压住尾段须 commit 未闭合块内部 → 违反 (a) 与致命#1(已进 scrollback 的行改不回)。
- **裁决(已回写)**:**尾段设硬上限(以 b 为准,a 为优先尝试)**。优先在安全边界切;**尾段一旦逼近硬上限(如 0.5× 视口高),即使在非安全边界也强制切**,保证 live 区恒 ≪ 视口。代价:超上限时已 commit 行不再回改——**列为本方案第二条主动接受的代价**(第一条是 resize 不重折)。

**矛盾 3 — "永不 remount / 数组只增不减"的绝对措辞 vs 自认 rewind 例外。**
- 原文一句话结论与步骤1 曾写"remount 彻底放弃""数组永不切片/只增不减",与步骤1 rewind 条"rewind 真正需要 remount + 显式重置 committed 数组"字面冲突。
- **裁决(已回写)**:措辞改为有界——"稳态 append-only,**除 rewind 外**永不切片/remount;rewind 是一次显式清屏重来,不在该不变量约束内"。

**矛盾 4(非硬矛盾,记录备查)**:标题写"真凶②的方案",但一句话结论已声明①②同源、步骤1 修真凶① —— 自洽,仅标题范围写窄,不改。



---

## 顺序与风险

- **步骤 1 是前置**:边流边写历史,必须先保证那条 commit 路径不重复/丢失。1 绿了再做 2。
- 步骤 2 是核心,直接解决你问的"超 500 行怎么办"——答案是边流边进历史,行数不再是问题。
- 步骤 3 是低风险增益,最后做。

| 风险 | 应对 |
|------|------|
| Static index 与 ring buffer 回绕交互 | 数组只增不减 → index 下标不错位;内存靠"写入终端后释放内容",不靠砍数组 |
| rewind 需要重画 | rewind=清屏重来,重画是预期;显式重置 committed 数组 |
| 安全切点判断错(在围栏/表格中间切) | 优先只在证明不变的边界切;保留尾部余量盖住边界歧义;**尾段硬上限兜底**(超长单块强制切,接受第二条代价,见矛盾2);复用 `block-stream-writer.ts` |
| **resize 拉窄后已 commit 行不重折** | **直接接受**——所有终端程序(`cat` 等)都这样,用户已习惯,非缺陷 |
| 滚屏/闪屏单测覆盖不了 | 真终端手验(tmux/SSH/VS Code 终端/Windows Terminal/CI 各一遍) |
| **流式块解析死循环 → 100% CPU 全卡死** | 见「审查补遗」:解析器必须 total(永远终止、index 必前进);`parseBlocks`+`block-stream-writer` 两颗雷已拆(`fba39ff`),并加死循环回归用例(畸形输入断言能返回) |
| `incrementalRendering` 选项名/行为需核实 | 实现前读 6.8.0 `options.js` + render 入参 |
| 本会话无法 typecheck/test | 设计交付,实现+验证留后续,每步带回归测试 |

## 下一步(步骤 1 第一步)
读 `app.tsx` 的 `staticItemsForInk` + `historyBufferRef`(RingBuffer)+ rewind 重置路径,设计"只增不减的 committed 数组 + 写入终端后释放内容"如何替代 `slice(start)` —— 然后出步骤 1 的 writing-plans。

---

## 修订意见(自审,按严重度排序)

### 🔴 R1（致命·会让"超 500 行"重新翻车）—— 步骤 2"安全边界"自相矛盾,漏了长代码块
步骤 2 写"代码围栏平衡后才算安全边界可提交"。但**一个比屏幕高、还在流式的单个代码块**(agent 倾倒一个大文件,极常见)围栏一直没闭合 → 按这条规则**一行都不能提交** → 整块全留 live 区 → 又超视口 → 真凶②原样回来。
**修订**:把规则改成——**代码围栏内部的行照样提交,只留最后 N 行可变**。理由:围栏内是 code,已按 code 渲染,不会再随 markdown 重分类/重折(line 50 永远是 code 的 line 50);真正有歧义的只有"围栏开/表格头"那 1–2 行边界,N 行尾部余量正好盖住。这正是 aider 的做法(commit 全部除最后 6 行,不管围栏开没开)。**没有这条修订,长代码块场景方案失效。**

### 🔴 R2（致命·真凶①的另一半根因没写进步骤 1)—— 单写者路径漏了
步骤 1 只说"数组不切片"。但真凶① 的**另一半根因**是双写者时序:`pushStatic`(微任务里 ref++)vs `pushStaticBatch`(同步 ref++)步调不一(app.tsx:297-352)。流式边提交时,assistant 正文和 tool-result 都往 Static 写,**两条路径不同时序 → 交错 → 重复/乱序**(对抗 scout #5:"你调试生命都花在这")。
**修订**:步骤 1 必须再加一条——**所有进 Static 的写入走单一有序路径(同一时钟),禁止 sync 与 microtask 混用**。否则边流边提交一定撞这个。

### 🟡 R3（重要·数据模型变更没说清)—— 一条流式消息怎么变成多条 Static 条目
现在 assistant 消息流式时是**一条**不断长大的 `LogEntry`;turn 末才整条进 Static。步骤 2 的"边流边提交前缀"要求把**这一条**拆成"已提交的多个块条目 + live 尾段"。文档没说这个拆分怎么做(按块切成多个 LogEntry?还是 Static 接受可增长的单条目?)。这是核心数据模型改动,目前 under-specified。
**修订**:步骤 1/2 之间补一节"流式消息 → committed 块 + live 尾"的数据模型,明确提交粒度(建议:每个写定的 markdown 块成为一个独立 committed LogEntry)。

### 🟡 R4（重要·rewind 被我过度简化)—— "清屏重来重画是预期"站不住
我写"rewind = 清屏重来,重画是预期,可接受"。但 append-only 历史**无法收回已进 scrollback 的内容**:rewind 后旧内容仍物理躺在 scrollback 上方,重画只会把回退后的内容**叠在旧内容下面 = 重复**。要么 `clearTerminal` 彻底清掉整个 scrollback(用户丢失全部上文历史,代价大),要么打个分隔符往下续(旧内容仍在)。这是**真正需要设计的点,不是"预期行为"**。
**修订**:rewind 单列一节,明确取舍(整屏清 vs 分隔符续),别用"可接受"盖过去。

### 🟢 R5（次要·"释放内容"时机没说)—— 步骤 1 何时能安全 null 掉旧条目内容
"写入终端后释放内容"对——但**外部无法直接知道** Static 的内部 `index` 已越过某条目(那是 Static 私有 state)。释放必须**延迟到该条目确实被某次 render 提交之后**(它在 slice 里出现过的下一轮)。文档说得太轻。
**修订**:补一句释放时机 = "该条目进入过 Static 渲染切片的下一个 render 周期后,才置空其重内容"。

### 🟢 R6（次要·别重犯"逻辑行≠折行"的错)—— "live 区天然只有几行高"措辞
尾段是"最后 N 个**逻辑行**",但每行可能折成多个**显示行**(N=6 逻辑行、宽行折 3 倍 = 18 显示行)。通常仍 < 视口,但前面那位批评者正是抓"逻辑行 vs 折行行"这个雷,别重犯。
**修订**:措辞改成"尾段是少量逻辑行、显示高度远小于视口",N 的选取要把折行算进去;并保留 Ink 6.8.0 溢出全清分支作为**万一尾段仍超高时的兜底**(它现在有 CSI2026 包裹,至少不撕裂)。

---

**结论**:R1、R2 不补,方案在长代码块 + 边流边提交时会原样翻车,**必须先改再进实施**。R3–R6 是把 under-specified 的地方补实。改完这 6 条,步骤 1 才算真正可落地。


---

# 代码审查补遗(2026-06-06,天枢)

> 本节是对方案与当前代码实现之间差距的系统审查。基于 `app.tsx`、`block-stream-writer.ts`、`markdown-render.tsx`、`stream.tsx`、`ring-buffer.ts`、`main.tsx` 的逐行阅读。

## 一、步骤 1 现状审计

### 1.1 `staticItemsForInk` 切片机制已确认有结构性缺陷

`app.tsx:211-223`:

```typescript
const staticItemsForInk = useMemo(() => {
    const all = historyItems  // RingBuffer.items() → 新数组,环满后固定 5000 项
    const start = Math.max(0, totalItemsPushedRef.current - all.length)
    if (start >= all.length) return []
    return all.slice(start)
  }, [historyItems])
```

**缺陷追溯**:RingBuffer 环满(5000)后,`all.length` 封顶 5000,但 `totalItemsPushedRef` 持续递增 → `start` 单调增 → `slice(start)` 返回的数组长度**递减**(4999→4998→...)。Ink 6.8.0 `<Static>` 内部 index 只增不减,当 index > 当前 items.length 时 `items.slice(index)` 返回 `[]` — **静默丢失**。这就是 spec 正文已指出的「第三个同源 bug:`2026-06-01-static-sliding-window-bug.md`」。

该注释称 "Defensive: if the ref fell behind the buffer (shouldn't happen)" — 但这不是 transient race,是环满后**必然发生**的结构性问题。5000 条消息后每次推送都会触发。

### 1.2 现有重复抑制机制

当前有三层去重,均不依赖切片:

| 机制 | 位置 | 作用 |
|------|------|------|
| `staticDedupRef`(Set, 最近 16 指纹) | `pushStatic` L238 | 同一内容不入环缓冲区 |
| `staticBatchRef` + microtask 批处理 | `pushStatic` L247 | 同一 tick 多次 push 合并为单次 `setHistoryVersion` |
| `pushStaticBatch` 同步路径 | L267 | turn-end 时绕过 microtask,保证 commit 在 isStreaming flip 前完成 |

这三层去重是**正确的**,不应在步骤 1 中移除或削弱。新 committed 数组方案需要**保持**这些去重机制。

### 1.3 RingBuffer 与 committed 数组的关系

当前架构:所有 Static 内容走过 `historyBufferRef`(RingBuffer, 5000 上限)。spec 提议的"只增不减 committed 数组"需要明确与 RingBuffer 的关系:

- **选项 A**:用 committed 数组替代 RingBuffer 作为 `<Static>` 的 items 来源,RingBuffer 只保留给 pager/transcript 使用。
- **选项 B**:committed 数组从 RingBuffer 派生,但每次只追加不切片(受 RingBuffer 环满限制)。

**建议选项 A**。但需解决:committed 数组无限增长 → 内存问题。spec 说"写入终端后释放内容",但需要实现知道 Ink 何时完成了某条 item 的渲染。Ink 6.8.0 `<Static>` 的 `index` 推进到 `items.length` 即表示已渲染全部 → 可以在 `items` 更新时,将已经被 Static 渲染过的旧 item 的 content 置空(只保留 type/id 等轻量字段用于 memo key 稳定性)。

### 1.4 rewind 路径

`hooks/use-rewind.ts` 通过 `historyBufferRef`、`totalItemsPushedRef`、`setHistoryVersion` 操作。步骤 1 实现时需确保 rewind 路径与新 committed 数组正确交互。spec 已明确 rewind 是唯一允许重置数组的例外 — 实现时需要 `clear()` 操作。

---

## 二、步骤 2 现状审计

### 2.1 当前流式路径:零前缀 commit

流式数据流(`app.tsx` handleSubmit → `block-stream-writer.ts`):

```
onTextDelta(text) → blockWriter.push(text)
  → BlockStreamWriter 内部缓冲
  → 段落断/句尾/idle timer 触发 flush
  → onBlock(text) 回调
  → textBatcher.push(text)
  → RenderBatcher 微批量合并
  → setStreamingText(streamLiveBuf)  ← 全部进 live 区
```

**关键发现:整个流式期间,没有任何内容进入 Static。** `pushAssistantEntry`(唯一向 Static 写 assistant 内容的函数)只在 `onTurnComplete`(turn 末)和 `flushStreamingState`(abort/error/Ctrl+C)时调用。这就是 spec 说的「只在 turn 末 commit」— live 区承载全部流式内容,500 行回复 = live 区 500 行 = 真凶②。

### 2.2 BlockStreamWriter 的切分能力不足以支撑 markdown 安全边界

`block-stream-writer.ts:checkEmit()` 的切分逻辑:

1. **硬上限**:buffer ≥ maxChars(默认 200) → `findBreakPoint` 在 `\n\n` / `\n` / ` ` 处切
2. **段落边界**:`\n\n` 在 ≥ 0.5×minChars 位置 → 切
3. **句末标点**:中英文标点(。！？.!?；;) 取最后一个位置 → 切

**缺失的能力**:spec 要求的"代码围栏平衡后、表格分隔行已消费后"等 markdown 语义边界。当前 `BlockStreamWriter` 是纯文本级的,不理解 markdown 结构。要支持"围栏平衡",它需要追踪 ` ``` ` 开启/关闭状态。

**但这不等于 BlockStreamWriter 不能用**。spec 的两层策略(优先安全边界 + 硬上限兜底)意味着:先用现有的段落/句末切分,加上硬上限保证 live 区不超视口。更精细的 markdown 感知切分是后续优化,不是步骤 2 的前置条件。

### 2.3 流式切分与 Markdown 渲染的交互

`stream.tsx:44`:流式时 `StreamOutput` 对**每个 token** 调用 `<Markdown text={text}>` → `parseBlocks(text)`。如果步骤 2 实现前缀 commit,需要考虑:

- committed prefix → 进入 Static,由 `renderStaticEntry` → `AssistantMessage` → `<Markdown>` 渲染
- live tail → 留在 `StreamOutput` → `<Markdown>` 渲染

两个 `<Markdown>` 实例独立解析,不会出现跨边界解析不一致(因为它们渲染的是**不同文本**)。但 tail 的 markdown 可能因前缀已被切走而缺少上下文(如未闭合围栏),导致尾部渲染异常(把代码当段落渲染)。这是 spec 已接受的代价。

### 2.4 实现接口建议

步骤 2 需要一个新的切分决策点,位于 `BlockStreamWriter` 的 `checkEmit` 或 flush 路径中:

```
// 伪代码
onSafeBoundary(committedPrefix: string) {
  // 1. 将 committedPrefix 通过 pushStatic 送入 Static
  pushStatic(createLogEntry({ type: 'assistant_message', content: committedPrefix }))
  // 2. 从 streamLiveBuf 中移除已 commit 的部分
  // 3. 更新 streamBuf/streamLiveBuf 只保留 tail
}
```

head 挑战:当前 `BlockStreamWriter` 的输出经过 `RenderBatcher` → `setStreamingText`,已经和 buffer 管理耦合。需要在不破坏现有 tool-result flush / thinking flush 路径的前提下插入 commit 路径。

---

## 三、步骤 3 现状审计

### 3.1 `incrementalRendering` 未开启

`src/main.tsx:1018`:

```typescript
const { waitUntilExit } = render(
    createElement(ErrorBoundary, null, createElement(Root, { ... })),
    { exitOnCtrlC: false },
  )
```

确认无 `incrementalRendering: true`。Ink 6.8.0 当前走 `createStandard` renderer(整块 eraseLines),而非 `createIncremental`(逐行 diff + CSI 2026)。

### 3.2 选项验证需要

实现前应确认:
1. Ink 6.8.0 的 `incrementalRendering` 选项名是否确实为 `incrementalRendering`(读 `node_modules/ink/build/options.js`)
2. 该选项与 `Static` 组件组合是否有已知问题(issue 搜索)
3. CI/非-TTY 环境下的降级行为(6.8.0 应自动降级为 pure-append)

---

## 四、布局问题(方案外但相关)

### 4.1 spacer 无效

`app.tsx` JSX 返回部分(约 L1280):

```tsx
<Box flexGrow={1} minHeight={0} />
```

位于 `<Box flexDirection="column">` 内,但根是 Fragment `<>`。Fragment 无高度约束 → flexGrow 无界 → spacer 不起作用。方案中对此的判断正确。这是独立 bug,但与真凶①②不直接相关。

### 4.2 双写入路径竞态

spec 已识别:Static append 路径(pushStatic/pushStaticBatch) vs live redraw 路径(setStreamingText),两者异步竞争。当前缓解:
- `flushStaticBatch()` 在 isStreaming flip 前调用
- `pushStaticBatch` 同步路径在 turn-end 使用

步骤 2 引入流式 prefix commit 后,Static 追加频率从 "只在 turn 末" 变为 "每秒数次" → 双写者竞态窗口大幅扩大。需要明确的不变量:每次 prefix commit 后立即 flush microtask batch,保证 Static 渲染先于下一次 live 区更新。

---

## 五、结论

**方案方向正确,三步顺序合理。** 与代码对照后,需要补充的关键实现细节:

1. 步骤 1:committed 数组需与现有 RingBuffer 去重机制共存;内存回收需设计(content 置空而非元素删除)
2. 步骤 2:BlockStreamWriter 的文本级切分足以支撑 MVP(段落断+硬上限),markdown 感知切分是后续优化
3. 步骤 2:双写者竞态窗口会因流式 prefix commit 大幅扩大,需要更强的排序保证
4. 步骤 3:确认 `incrementalRendering` 选项名和 Static 兼容性后再改

**未发现根本性阻塞**。方案可以推进实现。

