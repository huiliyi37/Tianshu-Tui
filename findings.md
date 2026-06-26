# 天枢 / Rivet 官网设计 — 研究发现

## 项目定位
- **英文名**：Rivet
- **中文名**：天枢（Tiānshū，北斗第一星）
- **本质**：开源终端 AI 编程代理 / Terminal coding agent
- **核心差异点**：
  1. **Prefix Cache 优化**：为 DeepSeek V4 设计，实战命中率 95–99%
  2. **多模型自适应路由**：DeepSeek / Claude / GLM / Codex / MiniMax / MiMo
  3. **子智能体编排**：无界面 worker、类型化 work order、批量调度
  4. **安全机制**：路径边界、敏感文件拒绝、审批模式、checkpoint/rollback
  5. **MCP 协议**：可扩展外部工具服务器

## 产品线
1. **终端版（Rivet CLI/TUI）**
   - 基于 Ink 6 + React 的终端 UI
   - Node.js 22+ 运行
   - 命令：`node dist/main.js`
   - 模式：交互式 TUI / headless `-p`
2. **桌面版（天枢桌面版）**
   - Tauri 2.x + React/Vite
   - 复用 Node runtime 作为 localhost sidecar
   - 多会话 dashboard、artifacts、审批介入、定时任务
   - 当前 macOS `.app` 已可构建，DMG/跨平台待 I7

## 品牌资产
- 图标：`desktop/src-tauri/icons/app-icon.png`（以及多种尺寸）
- 颜色：项目 UI 以深色终端风格为主，可延伸为「星域/北斗」深蓝/紫色系
- 文案调性：技术硬核、工程纪律、安全优先、中文文化底蕴

## 竞品参考方向
- cursor.com / windsurf.com：产品官网 + 下载 + 功能展示
- cline.bot / aider.chat：开源项目 landing + GitHub CTA
- continue.dev：开发者工具文档型官网

## 关键信息层级
1. 一句话价值主张：把上下文当作结构化、可缓存的资源
2. 三大卖点：Prefix Cache / 多模型路由 / 子智能体编排
3. 信任状：MIT 开源、2700+ 测试、typecheck clean
4. 行动召唤：下载桌面版 / 终端快速开始 / 查看 GitHub

## 文案灵感
- Slogan 候选：
  - 「终端里的AI合伙人」
  - 「把长上下文变成长记忆」
  - 「为 DeepSeek 而生的终端编程代理」
  - 「北斗所指，代码可栖」
