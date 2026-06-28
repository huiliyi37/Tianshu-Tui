# Changelog — 2026-06-28

> 用户开始体验前的集中质量加固：TUI 渲染稳定性、子代理输出可靠性、桌面端对标 Codex/Antigravity 的功能补齐、意图闸误报修复。本轮 14 个 commit，覆盖渲染 / 意图闸 / 提交卡顿 / 子代理输出链路 / 桌面端功能五条线。

---

## 一、TUI 渲染 — 输入框重影根治

**问题**：用户报告复制粘贴 / 方向键读历史时输入框重复渲染。根因是 East-Asian Ambiguous 字符（`— … · → ↑ ↓`，CJK 终端按 2 列渲染）的宽度口径分裂——`LiveEngine.rowsForLine` 按 wide 口径估行数，但渲染层用 narrow 截断 + padding，导致含 ambiguous 符号的输入行实际折成 2 行而 rowsForLine 算 1 行 → fullRewrite 欠擦 → 旧输入框残留 = 重影。

**改动**：

| commit | 文件 | 变更 |
|--------|------|------|
| `91daf1c5` | `app.ts` | 新增 `renderInputRow` helper，截断与 padding 都按 `ambiguousAsWide` 度量（与 `clampLine` 同口径）；spinner 行纳入 `clampLine` 防护 |
| `1e0a8744` | `task-list.ts` / `tool-card.ts` / `glance-bar.ts` / `welcome.ts` | 渲染层其余「`.length` / narrow 截断 + padding」的 format 模块统一到 wide 口径；新增 CJK/ambiguous 截断回归测试 |

**效果**：渲染层口径与 `rowsForLine` 完全一致，含 ambiguous 符号的行不再折行错位，残余重影源消除。task-list/tool-card（进 live region 高风险）+ glance-bar（统一口径）+ welcome（启动屏视觉）一并修。

---

## 二、意图闸 — 误报根治

**问题**：会话上下文仅 ~5% 占用却频繁强弹意图闸（`high commit threshold` + `历史 dead-end`）。排查判定链路定位两个误报源。

**改动**：

| commit | 文件 | 变更 |
|--------|------|------|
| `5c3b44eb` | `intent-preview.ts` / `turn-intent.ts` / `sensorium.ts` | **dead-end 关联匹配**：veto 沉积改存原始 target（非摘要），匹配层只保留与 `recentTargets` 子串重合的 dead-end（旧实现任意一条即触发）。**momentum 滑动窗口**：`computeMomentum` 从连续正确率（一次报错清零）改为窗口成功率（单次报错平滑下降），零维护对所有工具通用 |
| `52b9398b` | `.rivet/plans/...` | 修正早期误判：pheromones 按「项目+会话」双重隔离（实测同项目 19 会话各有独立文件），不存在跨会话残留，真实路径是会话内早先 turn 沉积 |

**效果**：5% 上下文强弹的误报消除。意图闸的「强提醒」本质保留（命中条件仍阻塞），只是触发条件从「任意 dead-end / 一次报错坠崖」改为「关联目标 / 平滑窗口」。

---

## 三、提交卡顿 — typecheck 异步化

**问题**：agent 执行 `deliver_task`（commit）时 spinner `⠴ analyzing… 8m 22s` 长时间冻结。根因：`runTypeCheck` 用 `spawnSync` 同步阻塞整个 Node 事件循环，tsc 跑几十秒期间 120ms setInterval 无法触发。

**改动**：

| commit | 文件 | 变更 |
|--------|------|------|
| `830484d1` | `lsp/client.ts` / `typecheck-gate.ts` / `deliver-task.ts` / `team-orchestrate.ts` | `runTypeCheck` 从 `spawnSync` 改异步 `spawn` + Promise（`runTscSubprocess`），保留 120s timeout / 10MB maxBuffer / 退出码语义。`TypecheckRunner` 类型 + 两个 run 函数异步化，调用点加 `await`，测试 mock 改 async |

**效果**：tsc 在子进程跑，事件循环继续转，spinner 正常动画、流式不中断。typecheck gate 语义与结果完全不变（纯执行方式改变）。

---

## 四、子代理输出 — 结构化输出 + 独立路由

**问题**：子代理结果"解析失败"。排查发现根因是天枢全靠 prompt 文字要求 + 事后正则提取 JSON（无 API 层结构化输出约束），cheap model 经常违反（混 prose / 截断 / markdown）。对标 Claude Code/Codex 用 API 层 `json_object` 从源头约束。

**改动**：

| commit | 文件 | 变更 |
|--------|------|------|
| `7b89028c` | `provider.ts` / `oai-types.ts` / `openai-client.ts` / `worker-session.ts` / `bootstrap.ts` | **结构化输出**：`ProviderCapabilities` 加 `supportsResponseFormat`；`OaiChatRequest` + client body 支持 `response_format`；`worker-session` 新增 `repairWithJsonMode`——解析失败后的 repair 轮用无 tools 单发请求 + `response_format: json_object` 强制合法 JSON（规避 json_object + tools 的已知冲突） |
| `0943a5b7` | `bootstrap.ts` | **独立路由隔离缓存**：放开 workerRouting 的「同 model 限制」——此前要求 `routeProfile.model === card.model`，任何配了不同 model 的 profile 被静默跳过，worker 回退主控 model，prefix cache 竞争。修复后 worker 真正跑在配的独立 model 上 |
| `c2eefbbf` | `worker-prompts.ts` | repair prompt 参考文本 tail 4000→8000 字符（完整覆盖典型 WorkerResult 的 5–8K 字符；max_tokens 8192 token ≈32K 字符已足够，不动） |

**效果**：worker 输出从「正则提取 → 失败」升级为「正则提取 → json-mode repair 强制 JSON → 仍失败则 blocked 降级」。配独立 model 后 prompt prefix 天然不同，服务端 prefix cache 不竞争主控。

---

## 五、桌面端功能 — 对标 Codex / Antigravity

### 5.1 Diff 行级评论回灌（对标 Codex 头号卖点）

**问题**：天枢此前只有 artifact 级评论，无法对 diff 具体行评论回灌 agent。

| commit | 变更 |
|--------|------|
| `0611b89a` | `DiffView` 解析 `+++/diff --git` 头建立 file 上下文，行 hover 评论按钮 + 行内 textarea；后端 `session-manager.feedback` 加 `lines` 参数，prompt 渲染为 `[LINE-LEVEL REVIEW]` 带 `<file>:<line>` 锚点；路由放宽校验（comment/lines 至少一个非空） |

### 5.2 委派节点独立 diff 审查（对标 Codex 并行 agent 审查）

**问题**：委派树节点只有元数据，看不到 worker 实际改动。

| commit | 变更 |
|--------|------|
| `220fddce` | worker diff 落盘到 `worker-<orderId>` session（复用 coordinator fallback 机制）；`DelegationActivity` 加 `artifactId`/`changedFiles`（TUI 兼容）；`DelegationSurface` DetailPanel 有 artifactId 时显示「查看改动」→ modal 弹 DiffView |
| `e700105b` | 审查修复：coordinator retry/escalation 分支补 artifactStore 注入（原遗漏导致重试场景 diff 不落盘）；NewSessionDialog 补回手输路径能力 |

### 5.3 多 repo Project 工作区（对标 Antigravity 多文件夹）

**问题**：Project 模型是单 cwd，无法一个会话绑定 frontend + backend。

| commit | 变更 |
|--------|------|
| `08124cb6` | `Project` 模型从 `{cwd}` 升级为 `{id, roots[]}`，localStorage 自动迁移旧格式；`NewSessionDialog` 单输入 → 多 root chips；`ProjectSidebar` 多 repo 徽章。后端方案 B（coordinator 多 repo 集成）留后续 |

### 5.4 Updater 自动更新闭环

**问题**：updater「只 check 不装」+ endpoint/pubkey 占位。

| commit | 变更 |
|--------|------|
| `045da9dd` | `createUpdaterArtifacts` + capability 加 `updater:default`；`UpdaterSection` 改 `downloadAndInstall` + 进度 + `relaunch`；`UpdateBanner` 启动静默 check；`sign-and-build.sh` + `gen-latest-json.js` + CI workflow 发布到 GitHub Releases；DISTRIBUTION.md 完整文档 |
| `8d75b640` | relaunch 前增加「重启中」过渡态（Finished 事件设 `installing=false` + 完成提示），避免盲等 |

---

## 复盘要点

**做对的**：
- 渲染重影用「渲染层与 rowsForLine 统一口径」根治，而非治标的 forceRedraw
- 子代理输出从源头（API 层 json_object）解决，而非堆更多正则策略
- 意图闸误报查清真实路径（会话内残留，非跨会话），修复精确

**踩的坑（已记录教训）**：
- 多会话共享工作区，`git reset HEAD` 全局清空会误伤并发会话的暂存——后续严格按文件粒度操作暂存区
- typecheck async 化的签名传播要覆盖**所有**调用分支（coordinator 三分支只改了一个，retry/escalation 遗漏，回头审查才发现）
- workerRouting 的「同 model 限制」是个隐藏的设计倒退，表面有配置入口实际不生效

**遗留（后续）**：
- 桌面端后端方案 B（coordinator 多 repo workspace 初始化）——前端已预留 `roots` 接口
- desktop 分支预存破损（`@base-ui` 等依赖声明、Rail 等）——已补齐依赖声明，但部分类型问题待 Phase 5 那条线收尾
- `response_format` 仅在 repair 轮注入（规避 tools 冲突）；若 provider 支持 json_schema strict，可进一步加到正常轮
