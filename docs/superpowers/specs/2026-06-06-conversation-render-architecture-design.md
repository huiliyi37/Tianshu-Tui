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
2. **边流边把"写定的前缀"提交进历史**(修真凶②):在安全的 markdown 边界切(围栏平衡、段落断),完成的行进 `<Static>` → 终端滚进历史(可滚/可选/可搜,一行不藏);只有还可能变的最后几行留在 live 区。live 区因此天然只有几行高,永远不超视口,失控滚屏从构造上消失。
3. **开 `incrementalRendering`,其余交给 Ink 6.8.0 内置**:逐行 diff、CSI 2026 防撕裂、屏幕阅读器、非-TTY 纯 append 全是自动的,白拿。

**唯一的实际代价(直接接受,不做选项)**:行一旦进历史,resize 拉窄后那些行不重新折行——但这是**所有终端程序**的常态(`cat` 输出拉窄也不重折),用户已习惯,不是缺陷。

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
- **致命 #1:流式 markdown 不能按行 commit,只能按闭合块。** 未闭合代码围栏把后续行当代码渲染,收尾围栏到达才重分类;表格要等 `|---|` 下一行才追认。证据:仓库 `markdown-render.tsx:parseBlocks`,以及已有的 `block-stream-writer.ts`(只在段落断/句末/硬上限 flush)。→ **推翻了"流式逐行 commit 进 scrollback"的方案。最简正解:turn 结束才 commit。**
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
- **改**:维护一个**只追加、永不切片、永不重排**的 committed-items 数组直接喂 `<Static>`。
- **回绕/rewind 怎么办(批评指出 remount 不行,这里定死)**:
  - **不能用 remount key 重置 index** —— remount 会让 `<Static>` 重渲它当前 `items.slice(0)` 全部 → scrollback 重复 = 真凶①。remount 彻底放弃。
  - `<Static>` 的 `index` 是**数组下标**不是 item id。只要**永不从数组头部删元素**,下标就不会错位。所以:喂 Static 的数组**只增不减**。
  - 内存边界**不靠砍这个数组**:已写进终端历史的行,物理上已在 scrollback、Static 的 index 早越过、永不再 slice 到——它们在 JS 数组里只占一个轻量引用(或只留必要元信息),真正占内存的内容可在写入终端后释放。ring buffer 若仍要存全量(给 pager/transcript 用),那是**另一个独立结构**,不喂 Static。
  - rewind(回退到历史某点重开):这是**真正需要 remount 的唯一场景**——但 rewind 本身就是"清屏重来",此时重渲是预期行为,不是 bug。rewind 时显式重置 committed 数组 + 让 Ink 重画一次,可接受。
- **验证**:5000+ 消息回绕、迟到 tool-result、多 turn、rewind 各跑一遍,零重复零丢失。

### 步骤 2 — 修真凶②:边流边把"写定的前缀"commit 进历史,live 区只留可变尾段
- **机制**(aider/gemini-cli 实证):流式每帧,把当前回复切成"写定前缀"+"可变尾段"。写定的前缀通过步骤 1 的数组进 `<Static>` → 终端滚进历史(可滚/可选/可搜,一行不藏);只有尾段留在 live 区(StreamOutput)。
- **在哪切才安全(绕开 markdown 重折行)**:只在**证明不会再变**的边界切——段落空行后、代码围栏平衡后、表格分隔行已消费后。参考 gemini-cli `findLastSafeSplitPoint`;或 aider 的简化版:保留最后 ~N 行(覆盖围栏/表格头这种边界歧义),其余提交。`block-stream-writer.ts` 已有按段落/句末/硬上限切的雏形,复用。
- **效果**:live 区因此**天然只有几行高**,`outputHeight` 永远 ≪ 视口 → 永不进 Ink 溢出全清分支 → `createIncremental` 干净逐行 diff。**不靠 height/overflow 裁剪,不藏任何内容。**
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


---

## 顺序与风险

- **步骤 1 是前置**:边流边写历史,必须先保证那条 commit 路径不重复/丢失。1 绿了再做 2。
- 步骤 2 是核心,直接解决你问的"超 500 行怎么办"——答案是边流边进历史,行数不再是问题。
- 步骤 3 是低风险增益,最后做。

| 风险 | 应对 |
|------|------|
| Static index 与 ring buffer 回绕交互 | 数组只增不减 → index 下标不错位;内存靠"写入终端后释放内容",不靠砍数组 |
| rewind 需要重画 | rewind=清屏重来,重画是预期;显式重置 committed 数组 |
| 安全切点判断错(在围栏/表格中间切) | 只在证明不变的边界切;保留尾部余量盖住边界歧义;复用 `block-stream-writer.ts` |
| **resize 拉窄后已 commit 行不重折** | **直接接受**——所有终端程序(`cat` 等)都这样,用户已习惯,非缺陷 |
| 滚屏/闪屏单测覆盖不了 | 真终端手验(tmux/SSH/VS Code 终端/Windows Terminal/CI 各一遍) |
| **流式块解析死循环 → 100% CPU 全卡死** | 见「审查补遗」:解析器必须 total(永远终止、index 必前进);`parseBlocks`+`block-stream-writer` 两颗雷已拆(`fba39ff`),并加死循环回归用例(畸形输入断言能返回) |
| `incrementalRendering` 选项名/行为需核实 | 实现前读 6.8.0 `options.js` + render 入参 |
| 本会话无法 typecheck/test | 设计交付,实现+验证留后续,每步带回归测试 |

## 下一步(步骤 1 第一步)
读 `app.tsx` 的 `staticItemsForInk` + `historyBufferRef`(RingBuffer)+ rewind 重置路径,设计"只增不减的 committed 数组 + 写入终端后释放内容"如何替代 `slice(start)` —— 然后出步骤 1 的 writing-plans。

