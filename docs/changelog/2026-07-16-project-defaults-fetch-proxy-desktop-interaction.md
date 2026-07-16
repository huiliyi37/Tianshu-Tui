# 2026-07-16 — 项目级默认配置 + web_fetch 代理修复 + 桌面端交互优化

## 项目级默认星域/模型

新建会话时自动读取项目目录下 `.rivet-config.json` 的 `agent.defaultDomain` 和
`provider.default`，作为该会话的初始星域和模型——无需每次手动切。

**背景**：schema 早已支持项目级配置覆盖，但 `createSession` 从未按 session cwd
重读项目配置，新会话的 domain/model 实际只能走全局默认。

**改动**：
- `src/server/session-manager.ts`：`createSession()` 解析 cwd 后调用
  `loadConfig({cwd})`，读项目的 `.rivet-config.json`，用项目配置覆盖默认值。
- 优先级：用户显式选择（新建对话框）> 项目配置 > 全局默认（兜底不变）。
- TUI + 桌面端都受益。

**使用**：项目根的 `.rivet-config.json` 写：
```json
{
  "agent": { "defaultDomain": "tianxuan" },
  "provider": { "default": "glm" }
}
```
该项目新建的会话自动用天璇域 + GLM 模型。

## 新建会话对话框增强

新建会话对话框（`NewSessionDialog`）新增模型和星域下拉选择器：

- **模型下拉**：列出所有已配置 provider 的 models（格式 `Provider: Model`）。
- **星域下拉**：列出 11 个星域（显示 glyph + 名称，如 `✦ 天枢`）。
- 两个选择器默认「跟随项目/全局默认」，选了才覆盖。
- `CreateSessionInput` + `POST /sessions` 新增可选 `model` / `domain` 参数。

## web_fetch 代理环境崩溃修复

**根因**：Node v24 内置 undici(7.8.0) 与 npm undici(8.7.0) handler 协议不兼容。
`http-fetch.ts` 给内置 `globalThis.fetch` 传 npm 版 pinned `Agent`，触发
`assertRequestHandler` 校验失败（`fetch failed: invalid onRequestStart method`）。
Clash 等代理环境下 web_fetch / import_resource 完全不可用。

**修复**：
- fetch 源从 `globalThis.fetch` 改为 npm `undiciFetch`（与 Agent 同版本，消除协议冲突）。
- pinned Agent 支持 proxy：有 proxy 时用 `ProxyAgent`，无 proxy 保持 SSRF pin。
- 新增 `proxy-resolver.ts` 统一 proxy 解析（config > 环境变量优先级，NO_PROXY 域名匹配）。
- 新增 `config.network.proxy` / `config.network.noProxy` 配置字段（桌面端 Settings → System → Network 面板可配）。

**配置入口**（优先级高→低）：
1. 桌面端 Settings → System → Network 面板
2. `config.json` `"network": { "proxy": "http://127.0.0.1:7890" }`
3. `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 环境变量

## 桌面端会话区交互优化

### 输入框（Composer）

- **effort 独立按钮**：推理强度从 PlusMenu 二级面板提到动作行直接暴露
  （⚡中 ▾），与 ModelPicker/DomainPicker 并排，一键切换 6 档。
- **PlusMenu 去重**：移除 models/domain/effort 三个重复入口，只保留 Skills/MCP/命令。
- **ContextRing tooltip**：hover 上下文圆环时补充显示缓存命中率（⚡xx%）。
- **去掉发送方式按钮**：Enter 发送 + Shift+Enter 换行为默认约定，不再占动作行位。

### 消息交互

- **复制按钮修复**：复制源从 DOM textContent（混文本）改为 `block.text` 原始 markdown；
  仅 assistant 回复显示复制按钮。
- **编辑/重发 loading**：保存按钮 await 期间 disabled，失败 toast 提示。
- **regenerate 即时反馈**：点击瞬间 spinner + disabled，失败 toast。
- **新消息计数 badge**：用户上滚看历史时，↓ 按钮显示未读消息数。

### 加载与渲染

- **空状态与加载态区分**：切换大会话时显示骨架屏而非闪 welcome 页。
- **长助手消息折叠**：超 3000 字符的回复自动折叠（max-height 400px + 渐变遮罩）。
- **thinking 折叠动画**：reasoning-body 从 mount/unmount 改为 CSS transition 平滑过渡。

### 桌面端网络代理配置面板

Settings → System 新增 Network 面板（Proxy URL + NoProxy 输入框），
`GET/PUT /config/network` API + `config.network` schema 字段。

## 压缩 reclaim gate telemetry

补全 compaction cost-aware reclaim gate 计划的任务 6+7：
- `createReclaimDecisionRecorder`：每个 reclaim gate 决策（提交或拒绝）写一条
  `event:'reclaim_decision'` 行到 cache-log，使"压缩了但没回收"可离线观测。
- 接线到 CompactionController 和 CompactBoundaryCoordinator 的 `onReclaimDecision` 回调。
