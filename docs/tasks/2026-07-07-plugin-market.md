# 功能星任务书：插件市场 + 办公插件三件套（PDF / Excel / PPT）

> 交给天枢执行的长任务。建议 plan mode 起步、`full` 方法论、按波推进（wave-gate 生效）。
> 目标模型档：规划 balanced+，执行波可 cheap，涉及安全边界的 Wave 1/2 不降档。

## 背景与动机

对标 Codex/Claude Code 的插件生态：办公能力（真格式 PDF/Excel/PPT 读写）需要重依赖
（exceljs、pptxgenjs、pdf 库等，单个就是几 MB 到几十 MB），**不能打进核心包**，也不能做成
skill（skill 是提示词层，扛不动二进制依赖）。正确形态是**插件市场：按需安装、独立依赖、
会话启动时动态加载**。

## 现状锚点（先读这些，不要凭空设计）

| 现状 | 位置 | 与本任务的关系 |
|------|------|----------------|
| 现有办公工具 — PDF/Presentation 纯 HTML 降级；Spreadsheet 支持 CSV/TSV 真格式（仅 .xls 降级）；Document 支持 TXT/MD 真格式（仅 .doc 降级） | `src/tools/create-pdf.ts`、`create-spreadsheet.ts`、`create-presentation.ts`、`create-document.ts` | 插件版接管真格式（.xlsx/.pptx/PDF）读写；CSV/TSV/TXT/MD 保留不动，仅 HTML 降级部分让位 |
| 工具注册中枢 | `src/tools/registry.ts`（`ToolRegistry`）、`src/tools/default-registry.ts` | 插件工具最终 `registry.register()` 进来，`desktopTools` 开关的条件注册模式可参考 |
| 市场目录的先例 | `src/mcp/presets.ts`（`MCP_PRESETS` 静态目录 + 已配置态） | 插件市场目录抄这个形：静态 catalog + installed 状态叠加 |
| 技能加载器 | `src/skills/skill-loader.ts` | 只做提示词注入，证明"skill 太重不合适"的边界在哪 |
| 配置分层 | `src/config/`（默认 → `~/.rivet` → 项目） | 插件启用状态放用户层；`src/config/paths.ts::defaultRivetHome()` 注意 Windows 是 `%LOCALAPPDATA%\.rivet` |
| 斜杠命令 | `src/tui/slash-commands.ts` | `/plugin` 命令挂这里 |
| 桌面端设置 UI | `desktop/`（独立 React 应用）+ `src/server/serve.ts` | Wave 4 可选：市场页复用 MCP presets 的"发现网格"模式 |

## 目标

1. **插件系统内核**：manifest 规范、安装/卸载/启停生命周期、会话启动时动态加载、工具注册合并。
2. **插件市场**：静态目录（first-party 起步）+ `/plugin` 斜杠命令全套（list / search / install / remove / enable / disable / info）。
3. **办公插件三件套**（first-party，仓库内 `plugins/` 目录开发、本地路径安装即可跑通，不依赖 npm 发布）：
   - `office-pdf`：真 PDF 生成（文本/标题/表格排版）+ PDF 文本抽取（读 PDF 进上下文）
   - `office-excel`：真 .xlsx 读写（sheet/单元格/公式值读取，表格数据写出）
   - `office-ppt`：真 .pptx 生成（标题页/内容页/图文布局）
4. **读比写优先**：agent 工作流里"把用户的 PDF/Excel 内容读进上下文"比"生成文件"更高频，三件套的读取路径是验收重点。
5. **让位语义精确化**：插件工具启用时，仅隐藏对应 HTML 降级格式选项——`pdf_create`/`pptx_create` 启用时隐藏 `create_pdf`/`create_presentation`（纯降级）；`xlsx_write` 启用时仅隐藏 `create_spreadsheet` 的 .xls 选项，保留 CSV/TSV；`xlsx_read` 不与现有工具冲突。文档工具同理：.doc 让位，TXT/MD 保留。

## 非目标（明确不做，防止范围爆炸）

- 不做第三方插件的 npm 远程市场检索/评分/签名体系（目录静态、安装源支持 npm 包名 + 本地路径即可）
- 不做进程级沙箱（v1 同进程动态 import，安全靠安装确认 + 权限声明 + 现有 validatePath 工具层防线；known limitation 写进文档）
- 不做插件自动更新
- 不动 MCP 子系统（插件与 MCP 是并行的两种扩展形态，不合并）

## 架构设计要点（执行时须遵守的决策）

1. **Manifest**：插件包 `package.json` 内 `"tianshu"` 字段（或独立 `tianshu-plugin.json`，执行者二选一后全程一致）：
   `name / version / description / entry / tools[]（名称+一句话描述，用于市场展示与冲突检测）/ permissions{fs,net,shell} / minCoreVersion`。
2. **安装位置**：`~/.rivet/plugins/<name>/`，每插件独立 `npm install --ignore-scripts --omit=dev`（**必须 --ignore-scripts**，禁 postinstall 任意代码）。锁版本：记录安装时解析出的确切版本。
3. **加载时机与前缀缓存纪律**：插件工具定义参与系统提示词的工具清单 → **只在会话启动时加载**。会话中途 install/enable 一律"下个会话生效"，提示用户重启或 /resume。绝不在 turn 中途改工具清单（打破 frozenBase = 缓存血崩）。
4. **命名冲突策略**：插件工具与内置工具同名 → 拒绝加载并报错列出冲突项；插件间冲突 → 后加载者拒绝。办公三件套用新名（`pdf_create`/`pdf_read`/`xlsx_read`/`xlsx_write`/`pptx_create`），不与现有 `create_pdf` 等 HTML 版抢名——HTML 版在对应插件启用时从注册表让位（default-registry 条件跳过）。
5. **安装确认**：install 是外部代码进程内执行，必须走一次显式确认（TUI 内确认即可），并展示 manifest 声明的 permissions。
6. **加载失败隔离**：单个插件 import 抛错/manifest 非法 → 跳过该插件 + 一次性警告，绝不阻塞会话启动（对齐 hook 错误隔离哲学）。
7. **依赖选型建议**（执行者可推翻，但要在计划里写理由）：xlsx 用 `exceljs`；pptx 用 `pptxgenjs`；PDF 生成用 `pdf-lib` 或 `pdfkit`（纯 JS，不引 headless 浏览器）；PDF 抽取用 `pdf-parse` 或 `unpdf`。禁止引入 puppeteer/playwright 级别的重依赖。
8. **Entry 加载策略**（Wave 1 设计决策，三选一后全程一致）：
   - **方案 A（推荐）：entry = 编译后的 JS 文件路径**。插件自带构建产物（`dist/index.js`），PluginLoader 直接 `await import(entry)`。仓库内 `plugins/` 开发时需手动 `npm run build`（可用 tsup/dev 脚本自动化）。优点：零运行时编译开销、启动快、不引入 tsx 依赖。缺点：开发需 build 步骤。
   - **方案 B：entry = package.json main/exports**。不重复声明入口，遵循 npm 包标准。manifest 不需要 `entry` 字段。优点：最简洁。缺点：插件包结构必须严格规范，灵活性低。
   - **方案 C：entry = TS 源文件 + 运行时 tsx 编译**。已排除——tsx 是重依赖（~20MB），且 JIT 编译增加启动耗时，违反"插件扫描近零成本"的回归底线。

## 分波实施

### Wave 1 — 插件内核（loader + manifest + 注册合并）
- `src/plugins/`：manifest 解析与校验（zod 或手写守卫，对齐仓库现状）、`PluginLoader`（扫描 `~/.rivet/plugins/`、动态 import、错误隔离）、启用状态存取（用户层配置）
- `default-registry.ts` 接入：插件工具注册 + 冲突检测 + HTML 版让位逻辑
- 单测：manifest 非法/合法用例、冲突拒绝、加载失败隔离、让位逻辑
- 验证：`npm run typecheck` + 新增测试文件全绿

### Wave 2 — 生命周期 + `/plugin` 命令 + 市场目录
- 安装管线：npm 包名 / 本地路径两种源 → `~/.rivet/plugins/<name>/` 独立 install（--ignore-scripts）→ manifest 校验 → 记录版本
- `/plugin list|search|install|remove|enable|disable|info` 全套（slash-commands.ts）
- `src/plugins/plugin-presets.ts` 静态目录（抄 MCP_PRESETS 形状），预置办公三件套条目
- 安装确认交互 + permissions 展示 + "下会话生效"提示
- 单测：安装管线（本地路径源，mock npm 调用）、命令解析、目录状态合并
- 验证：typecheck + 测试 + 手动脚本演练 install→重启→工具可见
- **管线探针**：Wave 2 末尾加一个 `plugins/hello-world` 最小插件（一个工具 `hello`，echo 固定文本），端到端验证 install→enable→重启→工具注册全链路，不等到 Wave 3 才发现管线问题。

### Wave 3 — 办公三件套（仓库内 `plugins/` 目录，本地路径安装）
- `plugins/office-pdf`、`plugins/office-excel`、`plugins/office-ppt` 三个独立 npm 包（各自 package.json + manifest + 工具实现 + 自带测试）
- 读取路径重点：`pdf_read`（文本抽取，超长输出走 artifact 阈值截断）、`xlsx_read`（sheet 列表 + 范围读取，输出 markdown 表格）
- 写入路径：`pdf_create`（标题/段落/表格）、`xlsx_write`（二维数组→sheet）、`pptx_create`（slides 数组→真 .pptx）
- 每个工具产出文件后用对应读取路径回读验证（xlsx 写→读闭环；pdf 写→抽取闭环）
- 验证：三包各自测试全绿 + 本地路径 install 后端到端演练

### Wave 4（可选，时间富余才做）— 桌面市场页 + 文档
- `src/server/serve.ts` 暴露 `GET /plugins/presets` + install/enable API（镜像 MCP presets 端点模式）
- desktop 设置页"插件市场"发现网格
- `docs/plugins.md`：manifest 规范、第三方插件开发指南、安全模型与 known limitations

## 验收标准

1. 全新环境（空 `~/.rivet/plugins/`）启动：零插件、零报错、现有工具行为不变（回归底线）。
2. `/plugin install ./plugins/office-excel` → 确认 → 重启会话 → `xlsx_write` 写出真 .xlsx（能被 `xlsx_read` 回读出一致数据）。
3. `pdf_read` 能把一个真实 PDF 的文本抽进上下文；`pptx_create` 产出能被 Keynote/PowerPoint 打开的 .pptx。
4. 坏 manifest / 加载抛错的插件不阻塞启动，警告一次。
5. 工具名冲突被拒绝且报错信息指明冲突双方。
6. `npm run typecheck` 干净；新增测试全绿；`npm test` 无新增失败（存量 flaky 除外）。

## 回归清单（交付前逐项核验）

- [ ] `create_pdf`/`create_spreadsheet`/`create_presentation`/`create_document` 在无插件时行为与主线一致
- [ ] `default-registry.ts` 现有条件注册（desktopTools/browserTool/computerUse）不受影响
- [ ] 斜杠命令现有条目全部可用（/resume /exit /plugin 共存）
- [ ] 会话启动耗时无明显退化（插件扫描是空目录时应近零成本）
- [ ] Windows 路径：插件目录解析用 `paths.ts` 的 rivetHome，不硬编码 `~/.rivet`

## 执行纪律（仓库惯例，违者返工）

- node:test + node:assert/strict；ESM import 带 `.js` 后缀；不可变模式
- 前缀缓存纪律高于一切：任何"会话中途改工具清单"的捷径都不许走
- 每波结束跑 typecheck + 本波测试（wave-gate 会拦，别硬闯）
- 交付报告三项：做了什么 / 遗留什么 / 设计偏差
