# pi-tui → 天枢 T9 移植评估与计划

> 2026-06-27 · 调研对象：`@oh-my-pi/pi-tui@16.1.18`（Bun 单包 monorepo）→ 天枢 T9 引擎（Node 22 ANSI 直写）

## 1. 结论

**全量替换不可行**。pi-tui 与天枢存在运行时、原生依赖、渲染范式三重不可调和的冲突。
**选择性移植叶子模块有价值**——一批无范式依赖的纯函数模块能直接补齐 T9 的能力缺口。

## 2. 阻塞项（全量移植的三个硬性壁垒）

### 2.1 运行时不兼容（致命）

| | pi-tui | 天枢 T9 |
|---|---|---|
| 运行时 | Bun ≥1.3.14（硬性 `engines` 要求） | Node.js 22+ |
| 原生依赖 | `@oh-my-pi/pi-natives`（Rust N-API 编译二进制） | 无 |
| 工具链 | Bun workspace + tsgo | tsup + tsc |
| 打包分发 | 编译进 omp 二进制 | npm `dist/` |

pi-tui 核心 `tui.ts:15` 直接 `import { $flag, getDebugLogPath } from "@oh-my-pi/pi-utils"`。
pi-utils 是 Bun 专用工具包。pi-natives 是 Rust crate（grep/clipboard/image/PTY/syntax-highlighting）。
引入 pi-tui 等于把天枢从 Node 迁到 Bun——波及构建、测试、分发全链路。

### 2.2 依赖链不可切断

```
pi-tui (149KB)
  ├── @oh-my-pi/pi-natives  ← Rust 编译产物，无法 shim
  ├── @oh-my-pi/pi-utils     ← Bun 专用 ($flag, getDebugLogPath, isEnoent...)
  ├── lru-cache
  └── marked
```

跑 pi-tui 必须同时带上 pi-natives + pi-utils，等于拖半个 monorepo。

### 2.3 T9 已是成熟引擎（非半成品）

`src/tui/engine/app.ts`（106KB）+ `live-engine.ts` + `commit-engine.ts` + `overlay-engine.ts`
是一套完整的事件驱动 ANSI 渲染引擎，且：
- 与 `AgentLoop` callback 深度耦合
- 与星域系统（`STAR_DOMAINS`）、glance bar、overlay、cockpit 深度集成
- 2700+ 测试覆盖

拆掉重接 = 重写整个 UI 层。

### 2.4 渲染范式冲突

```
pi-tui = retained-mode 差分渲染
  构建组件树 (Box/Text/Editor/ScrollView/Markdown...) → 引擎 diff → 只重绘变化 cell
  类似终端虚拟 DOM，149KB 复杂度

天枢 T9 = immediate-mode ANSI 直写
  format 函数（纯函数）→ 产出 ANSI 字符串 → LiveEngine cursor save/restore 增量重绘
  为流式 agent 场景量身定制
```

两种范式不可互换。组件树模型要求消费方按其生命周期写代码；T9 format→write 无状态。

## 3. 移植候选清单（按可行性分级）

### Tier A — 立即可移植（纯函数，无外部依赖）

| 模块 | 大小 | 价值 | 外部依赖 | 备注 |
|------|------|------|---------|------|
| `latex-to-unicode.ts` | 50KB | LaTeX → Unicode/ANSI 数学渲染 | ❗ 仅 `TERMINAL` from terminal-capabilities | 需解耦 TERMINAL 注入 |
| `latex-block.ts` | 13KB | LaTeX 二维布局（分数堆叠对齐） | 同上链式依赖 | 依赖 latex-to-unicode |
| `fuzzy.ts` | — | 模糊匹配 | 零依赖 | 直接搬 |
| `keys.ts` | — | Kitty keyboard protocol 解析 | 零依赖 | 直接搬 |
| `keybindings.ts` | — | 全局键位注册（declaration merging） | 仅 `keys.ts` | 跟 keys 一起搬 |
| `kitty-graphics.ts` | 8KB | Kitty 图形协议 Unicode placeholder | 零依赖 | 直接搬 |

### Tier B — 可移植（需小量 shim）

| 模块 | 大小 | 价值 | 阻塞点 | 解法 |
|------|------|------|--------|------|
| `terminal-capabilities.ts` | — | 终端能力检测（Kitty/iTerm2/同步输出/Sixel） | `encodeSixel` from pi-natives；`$env/isBunTestRuntime/isTerminalHeadless` from pi-utils | Sixel 编码 stub；env 检测用 Node 原生 |
| `stdin-buffer.ts` | 19KB | 输入批切分（防 partial escape） | 零硬依赖（内部纯逻辑） | 直接搬 |

### Tier C — 技术借鉴（不搬代码，抄协议级技巧）

pi-tui `tui.ts:40-83` 浓缩的高级终端渲染技术，可在 T9 的 `ansi.ts` / `live-engine.ts` 实现：

- **DEC 2026 同步输出**（`SYNC_OUTPUT_BEGIN/END`）— 消除撕裂
- **DECCARA 矩形 SGR 填充**（`deccara.ts`）— 背景色块优化
- **Autowrap 纪律**（`DISABLE_AUTOWRAP`）— 防楼梯效应
- **ED3 (`CSI 3 J`)** — 仅手势驱动时清滚动缓冲
- **OSC 8 hyperlink 终止** — 防样式跨行泄漏

### Tier D — 不移植（范式绑定 / 引擎核心）

`tui.ts`、`terminal.ts`、`components/*`、`deccara.ts`（引擎级）、`utils.ts`（与 T9 width.ts 重叠）。

## 4. 移植原则

1. **源码级拷贝，不改逻辑**——保持与上游可 diff，便于后续 sync。
2. **切断 `@oh-my-pi/pi-utils` import**——用本地等价物或注入替代，不引入 pi-utils。
3. **切断 `@oh-my-pi/pi-natives` import**——Sixel 等原生能力 stub 化，运行时降级。
4. **放 `src/tui/pi/` 子目录**——明确标记移植来源，与 T9 原生代码隔离。
5. **逐个移植，逐个验证**——每搬一个跑 `bun test` + `tsc --noEmit`，不批量。
6. **补契约级测试**——移植的每个模块至少一个行为测试（已有 pi-tui 测试可参照）。

## 5. 执行顺序

1. ✅ 写本文档
2. ✅ **移植 `latex-to-unicode`**（Tier A 首个，移植流程已跑通）— 见 6.1
3. ✅ **移植 `latex-block`**（依赖 latex-to-unicode）— 见 6.2
4. ✅ **移植 `fuzzy`**（零依赖）— 见 6.3。`keys`/`keybindings` 经评估暂缓（依赖 pi-natives 原生键盘绑定，且与 T9 `input-handler.ts` 重叠）。
5. 移植 `terminal-capabilities`（解耦 latex-to-unicode 对 TERMINAL 的硬依赖）
6. 评估 Tier C 协议技巧移植

## 6. 详细移植记录

### 6.1 latex-to-unicode ✅ 完成

**结果**：`src/tui/pi/latex-to-unicode.ts`（2072 行）+ 契约测试 14 例全绿，项目 `tsc --noEmit` 零错误。

**解耦改动**（仅 3 处，逻辑零改动）：
1. **切断 `TERMINAL` 依赖** — 删除 `import { TERMINAL } from "./terminal-capabilities"`。
   `colorFormat()` 原读 `TERMINAL.trueColor`，改为模块内 `mathColorTrueColor` 标志，
   暴露 `setMathColorTrueColor(enabled)` 供宿主注入终端能力。默认 false（ANSI-256 保守）。
2. **替换 `Bun.color()`**（5 处调用） — 上游用 Bun 内建 CSS 颜色解析器，天枢跑 Node 22。
   新增 `bunColorShim(spec, format)`：支持 `#hex` / `rgb()/rgba()` 解析，按 format 返回
   `string`（css/ansi-256/ansi-16m）或 `ParsedRgb`（{rgb}）。用函数重载收窄返回类型。
3. **`noUncheckedIndexedAccess` 适配**（8 处） — pi-tui 的 tsconfig 无此选项，天枢有。
   `LatexParser` 的 `this.#s[this.#i]` 在有边界检查的读取点加 `!` 非空断言（逻辑已保证安全）。

**验证**：`bun test ./src/tui/pi/__tests__/latex-to-unicode.test.ts` → 14 pass / 0 fail。
覆盖：Greek/上下标/大算子/分数/关系箭头/未知命令降级/`$...$`与`$$...$$`扫描/货币反误判/环境检测/颜色注入。

**待办（消费方接线）**：在 `src/tui/format/markdown.ts` 或 `thinking.ts` 调用
`renderMathInText()` / `latexToUnicode()`，让 agent 输出的 LaTeX 在 TUI 里渲染为 Unicode。

### 6.2 latex-block ✅ 完成

**结果**：`src/tui/pi/latex-block.ts`（462 行）+ 契约测试 8 例全绿，项目 `tsc --noEmit` 零错误。

**解耦改动**（仅 2 处，逻辑零改动）：
1. **替换 `visibleWidth` → T9 `displayWidth`** — 上游 `import { visibleWidth } from "./utils"`
   依赖 pi-tui 的 `utils.ts`（用 `Bun.stringWidth`）。改为 `import { displayWidth } from "../width.js"`，
   复用 T9 既有 `width.ts`（基于 `string-width` 包，Node 兼容）。3 处调用点签名兼容（`string → number`）。
2. **`noUncheckedIndexedAccess` 适配**（11 处） — `boxes[0]`、`src[i]`、`lines[...]` 等数组/字符串
   索引访问加 `!` 非空断言（均有边界检查或 length 守卫保证安全）。

**验证**：`bun test ./src/tui/pi/__tests__/` → 22 pass / 0 fail（latex-to-unicode 14 + latex-block 8）。
覆盖：空输入/非分数单行/frac 垂直堆叠/二次公式对齐/多行/嵌套 frac/符号委托/首尾空行裁剪。

**消费方接线**（待办）：与 6.1 一起，在 `markdown.ts` 的 display-math 分支调用 `latexToBlock()`，
inline math 调用 `latexToUnicode()`。

### 6.3 fuzzy ✅ 完成

**结果**：`src/tui/pi/fuzzy.ts`（298 行）+ 契约测试 10 例全绿，项目 `tsc --noEmit` 零错误。

**解耦改动**：无。`fuzzy.ts` 是真正的零依赖纯函数模块（`fuzzyMatch`/`fuzzyRank`/`fuzzyFilter`），
源码级拷贝即可用。匹配是 word-local 的：query 按空格分 token，每个 token 必须在某单词内顺序匹配。

**关于 keys/keybindings（评估后暂缓）**：二者 `import { KeyEventType, matchesKey, parseKey, parseKittySequence } from "@oh-my-pi/pi-natives"`
——依赖 Rust 原生键盘协议解析。虽然原生调用是 JS 路径的加速 fallback（可 stub 成 null 让 JS 接管），
但 T9 已有完整的 `input-handler.ts` + `input-line.ts` 键盘处理，功能重叠。移植收益不抵 stub 维护成本，暂缓。
若未来 T9 需要更精细的 Kitty keyboard protocol 支持，再回来移植并 stub 化原生依赖。

**验证**：`bun test ./src/tui/pi/__tests__/` → 32 pass / 0 fail（latex-to-unicode 14 + latex-block 8 + fuzzy 10）。
