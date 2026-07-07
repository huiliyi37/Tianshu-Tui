# 功能星任务书：分发工程 — 对标 CodeWhale 的安装体验

> 交给天枢执行的长任务。建议 plan mode 起步、`full` 方法论、按波推进（wave-gate 生效）。
> 目标模型档：规划 balanced+；Wave 1/2 涉及发布面与安全（校验和、安装脚本），不降档。

## 背景与动机

CodeWhale（39.5k stars，起点同为 deepseek-tui）的增长不靠模型能力，靠**把"能装上"做到偏执**：
npm 二进制包装器、cargo、Docker、Nix、Scoop、brew、国内 CNB 镜像、riscv64 预编译、SHA-256 校验、
`doctor` 自检、专门的 INSTALL.md。天枢的运行时深度不输（见 canvas 对比），但安装体验是硬短板：

- `npm view tianshu-tui` 显示 2.15.1 **已在 npm 发布**，但 `engines` 钉死 `"node": "24.1.0"` 且
  `.npmrc engine-strict=true`——Node 24.2 用户都会被拒。这是当前最大的安装杀手。
- bin 只有 `rivet`，与品牌"天枢/Tianshu"完全对不上；搜索 tianshu 装完却要敲 rivet。
- `postinstall` 仍跑 patch-package，但 `patches/` 已清空（2026-07-07 删除 ink 补丁后），纯浪费一次子进程。
- 没有 INSTALL.md、没有校验和、没有国内镜像指引、没有 `doctor`、没有一行式安装脚本。
- 公开仓（huiliyi37/Tianshu-Tui）已有 ci.yml / build-macos.yml / build-windows.yml，发布未自动化。

**本任务只做分发，不做功能。** 每一波的产出都要回答同一个问题：一个从未见过本项目的
Node 22/24 用户（或无 Node 用户），从看到 README 到跑起来第一个会话，需要几分钟、会在哪一步骂人。

## 现状锚点（先读这些，不要凭空设计）

| 现状 | 位置 | 与本任务的关系 |
|------|------|----------------|
| npm 包 `tianshu-tui@2.15.1` 已发布；`files` 含 dist/、completions/，排除 dist/node_modules 与 dist/native | `package.json` | Wave 1 的修复对象；`prepublishOnly: npm run build` 已有 |
| `engines: "24.1.0"` 精确钉死 + `.npmrc engine-strict` | `package.json`、`.npmrc`、公开仓 ci.yml 注释 | 放宽策略是 Wave 1 核心决策（见架构决策 1） |
| bin 仅 `rivet: dist/main.js` | `package.json` | Wave 1 品牌统一 |
| shell 补全 `rivet.bash` / `rivet.zsh` | `completions/` | 双名同步 |
| tsup 单入口 ESM 构建，bundled skills / seed-capsules 随 dist 产出 | `tsup.config.ts` | SEA/portable 打包的输入 |
| 原生依赖：better-sqlite3（optionalDependencies，缺失有降级）、@ast-grep/napi、web-tree-sitter(wasm) | `package.json`、`scripts/pack-native.js`、`stage-runtime-deps.js` | 单二进制路线的主要约束（见架构决策 3） |
| macOS 双架构桌面打包脚本（Tauri dmg + app.tar.gz + updater） | `scripts/build-macos-release.sh`、`desktop/` | 桌面分发已有雏形，本任务不动它，只把产物挂进 Releases |
| 公开仓 CI：ci.yml（typecheck+test）、build-macos.yml、build-windows.yml | Tianshu 仓 `.github/workflows/` | Wave 3 发布自动化的底座 |
| 开发仓→公开仓同步 | `scripts/sync-to-public.sh` | 所有分发产物源文件都要走它同步；**绝不直接 push tianshu remote** |
| 环境体检已有雏形（`/n` 斜杠命令：Node/Git/Python/uv/shell 检测） | `src/tui/slash-commands.ts` | Wave 2 `doctor` 子命令复用其逻辑，不重写 |

## 目标

1. **npm 一行安装在 Node ≥22 上不被拒**：`npm i -g tianshu-tui` → `tianshu` 可用。版本下限由实测定，不拍脑袋。
2. **bin 品牌统一**：`tianshu`（主）+ `rivet`（兼容别名，老用户不断），completions 双名。
3. **`tianshu doctor`**：安装后一条命令自检 Node 版本 / 终端能力 / API key 配置 / 可选依赖状态，输出可贴进 issue 的诊断块。
4. **GitHub Releases 自动化**：打 tag → CI 构建 → npm publish + Release 附件（含桌面 dmg/exe）+ `SHA256SUMS`。
5. **docs/INSTALL.md**：平台矩阵、国内镜像（npmmirror + Release 镜像）、常见故障排查、校验和验证方法。
6. **免 Node 安装路径（探索波）**：Node SEA 单二进制或 portable tarball，三平台（darwin-arm64 / linux-x64 / win-x64）。
7. **README 安装段重写**：五种安装路径一屏讲完（对标 CodeWhale README 的 Install 段信息密度）。

## 非目标（明确不做，防止范围爆炸）

- 不做 VS Code 扩展、Telegram/飞书桥（那是产品面，不是分发面）
- 不做 riscv64 等长尾平台；三大平台 × 主流架构够
- 不做 CLI 自动更新（桌面端 Tauri updater 已有；CLI 靠 npm/release 渠道）
- 不改项目名/包名（tianshu-tui 保持；rivet 历史名只做兼容不做迁移）
- 不动桌面打包管线本身（build-macos-release.sh 保持手动触发，仅产物上挂）
- 不做 Homebrew core / winget 正式收录申请（tap/bucket 自持即可，收录等星数）

## 架构设计要点（执行时须遵守的决策）

1. **Node 版本策略（Wave 1 第一件事，先测再定）**：写一个兼容性探测脚本枚举代码里的
   24-only API（`node:sqlite`? V8 flag? `--experimental-*`?），在 Node 22 LTS 容器里跑
   `npm run build && node dist/main.js --version` + 冒烟测试。结论二选一：
   - 能跑 → `engines: ">=22.12"`；
   - 确有 24 硬依赖 → `engines: ">=24"`（范围，不钉补丁号）。
   无论哪种：**删 `.npmrc engine-strict`**，改为 `main.ts` 启动时运行时检查——低于下限打印
   带升级指引的友好报错（含 fnm/nvm/volta 一行命令），而不是 npm 装到一半拒绝。
2. **bin 布局**：`{ "tianshu": "dist/main.js", "rivet": "dist/main.js" }`。`tianshu-tui` 三字符太长不加。
   completions 增加 `tianshu.bash`/`tianshu.zsh`（内容参数化生成，别复制粘贴两份手工维护）。
3. **单二进制路线（Wave 4，探索性，允许失败）**：首选 Node 官方 SEA（`--experimental-sea-config`）。
   已知约束必须在 spike 里逐一回答：ESM 入口（SEA 目前偏 CJS，可能需要 tsup 出一份 CJS bundle）、
   wasm 资源（web-tree-sitter/tree-sitter-wasms 用 SEA assets 打进去或首启解压到 `~/.rivet/runtime/`）、
   napi 原生模块（@ast-grep/napi、better-sqlite3 无法进 SEA——方案：随平台压缩包并置 `lib/` 目录 +
   运行时按路径加载，缺失走既有降级）。**Spike 失败的退路**：portable tarball（自带 node 运行时 +
   dist + 依赖，`tianshu.cmd`/`tianshu` 启动器），体验略差但确定可行。两条路都要 `SHA256SUMS`。
4. **安装脚本 `install.sh`**：`curl -fsSL https://…/install.sh | sh` 形状。逻辑：检测 OS/arch →
   优先走已装的 npm（有 Node ≥下限时）→ 否则下载对应 Release 产物 → sha256 校验 → 装到
   `~/.local/bin` → 提示 PATH。**不写 sudo，不碰系统目录。** Windows 用户指去 INSTALL.md（scoop/手动）。
5. **国内镜像策略**：npm 侧 npmmirror 会自动同步，INSTALL.md 写 `--registry` 一行即可；
   Release 二进制侧优先评估 jsDelivr（`cdn.jsdelivr.net/gh` 对 Release 附件不可用，需实测走
   `github.moeyy.xyz` 类代理还是自建 CNB 镜像仓），把实测可用的写进文档，不列一堆没验证的。
6. **发布工作流（Wave 3）**：tag `v*` 触发：typecheck + test → `npm publish --provenance`（需 npm
   granular token 入 secrets）→ 构建产物矩阵 → 生成 SHA256SUMS → `gh release create` 附全部产物 +
   变更日志（从 docs/changelog 对应文件抽取）。桌面 dmg 由 build-macos.yml 产物 artifact 传递，
   不在 release job 里重复构建。版本一致性校验复用 build-macos-release.sh 里那段 node -e。
7. **doctor 子命令**：`tianshu doctor` 走 CLI 参数分支（不进 TUI），复用 `/n` 的检测逻辑抽成
   共享模块。检查项：Node 版本 vs 下限、终端 TTY/颜色/宽字符、`~/.rivet` 可写、API key 存在性
   （只报有无，不打印值）、可选依赖（better-sqlite3/ast-grep）加载状态、代理环境变量。
   输出末尾给一段可复制的 markdown 诊断块（版本/平台/检查结果），降低 issue 报告成本。
8. **发布面安全纪律**：install.sh 与 SHA256SUMS 是攻击面——脚本内不执行下载内容以外的任何
   远程代码；SUMS 文件由 CI 生成并随 Release 签发；文档教用户 `shasum -c` 验证。npm token 用
   granular + provenance，不用 classic token。

## 分波实施

### Wave 1 — npm 包体验修复（最高 ROI，先发一个 2.15.2 补丁版）
- Node 兼容性探测 + engines 决策落地（架构决策 1），删 engine-strict，加运行时版本检查与友好报错
- bin 双名 + completions 参数化双名；删除空转的 postinstall patch-package
- `npm pack --dry-run` 体积审计：确认 dist/node_modules、dist/native、测试文件、sourcemap 不在包里；记录包体积基线
- README（中英）Install 段重写：npm / 源码 两条路径 + doctor 预告
- 单测：版本检查函数（低于下限的报错文案、等于/高于放行）；completions 生成器
- 验证：Node 22 与 24 两个 Docker 容器里 `npm i -g ./tianshu-tui-*.tgz && tianshu --version` 冒烟

### Wave 2 — doctor + INSTALL.md + install.sh
- `/n` 检测逻辑抽共享模块，新增 `tianshu doctor` CLI 分支（架构决策 7）
- `docs/INSTALL.md`：平台矩阵、镜像实测结果、故障排查（engine 报错/代理/Windows 终端）、校验和验证
- `install.sh`（架构决策 4）+ shellcheck 过检 + macOS/Linux 容器演练
- 单测：doctor 各检查项的 pass/fail 分支（mock 环境）；install.sh 用 bats 或最小 sh 断言脚本
- 验证：全新 Ubuntu 容器 `curl | sh` 全程无 sudo 装通；doctor 输出诊断块可贴 issue

### Wave 3 — GitHub Releases 自动化
- `.github/workflows/release.yml`（架构决策 6）：tag 触发全链路，含 npm publish --provenance
- SHA256SUMS 生成 + 附件矩阵（npm tgz、portable tarball 占位、桌面 dmg/exe artifact 传递）
- 变更日志抽取脚本（docs/changelog/<version>.md → release notes）
- 验证：在 fork/测试仓打 `v0.0.0-test` tag 走通全流程后再进公开仓；首个正式 tag 由用户手动打

### Wave 4 — 免 Node 安装路径（探索波，允许带结论失败）
- SEA spike（架构决策 3）：darwin-arm64 先行，逐项回答 ESM/wasm/napi 三个约束，产出可行性结论文档
- 可行 → 三平台产物进 release 矩阵；不可行 → portable tarball 路线落地（同样三平台 + SUMS）
- 验证：无 Node 的干净容器/VM 里解包即跑 `tianshu --version` + 一轮真实会话冒烟

### Wave 5（可选，时间富余才做）— 包管理器长尾
- Homebrew tap（自持 `huiliyi37/homebrew-tianshu`，formula 指 Release tarball + sha256）
- Scoop bucket（Windows，指 portable zip）
- `docker run ghcr.io/…/tianshu` 镜像（node:24-slim 底，入口即 CLI）
- 验证：三条路径各自真机/容器装通一次

## 验收标准

1. Node 22 干净容器：`npm i -g tianshu-tui && tianshu --version` 一次成功，无 engine 拒绝、无 patch-package 报错。
2. 低于下限的 Node 上运行 `tianshu`：得到含升级指引的友好报错，非堆栈。
3. `tianshu doctor` 在 macOS/Linux/Windows 各输出完整诊断块；老用户 `rivet` 命令仍可用。
4. 打一个 tag 后不做任何手动操作：npm 新版本 + GitHub Release（附件 + SHA256SUMS + release notes）全部就位。
5. `curl | sh` 在无 Node 的 Ubuntu 容器装通（Wave 4 完成后），`shasum -c SHA256SUMS` 可验证。
6. README Install 段一屏内讲清所有路径；INSTALL.md 的每条镜像/命令都经过实测（不列未验证内容）。
7. `npm run typecheck` 干净；新增测试全绿；`npm test` 无新增失败。

## 回归清单（交付前逐项核验）

- [ ] `rivet` bin 不消失，老用户脚本不断
- [ ] `npm pack` 产物含 dist/bundled-skills 与 seed-capsules（运行时依赖它们）
- [ ] `prepublishOnly` 构建链完整；桌面 `build-macos-release.sh` 不受 engines/脚本改动影响
- [ ] Windows 路径逻辑（`%LOCALAPPDATA%\.rivet`）在 doctor 与 install 文档中口径一致
- [ ] sync-to-public.sh 覆盖新增文件（install.sh、release.yml、INSTALL.md）；公开仓 CI 三个 workflow 仍绿
- [ ] 会话启动耗时无退化（运行时版本检查必须是同步纯计算，不发网络请求）

## 执行纪律（仓库惯例，违者返工）

- node:test + node:assert/strict；ESM import 带 `.js` 后缀；不可变模式
- 发布凭据（npm token）只进 GitHub secrets，绝不落盘进仓库；install.sh 不含任何遥测
- 每波结束跑 typecheck + 本波测试（wave-gate 会拦，别硬闯）
- 公开仓同步走 `bash scripts/sync-to-public.sh`，绝不直接 `git push tianshu`
- 交付报告三项：做了什么 / 遗留什么 / 设计偏差
