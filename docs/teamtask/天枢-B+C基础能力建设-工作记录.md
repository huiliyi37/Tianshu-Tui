# 天枢 B+C 基础能力建设 — 工作记录

> 目标：补齐天枢对标 Cursor / Codex 的两类基础能力。
> (B) 让 agent 放权全速无人值守地跑——安全由「沙箱边界 + 全量回滚 + 崩溃自动续」机制保证，而非靠打断用户审批；
> (C) 把代码智能拉到 Cursor 同档——真 embedding 语义检索、多语言索引/LSP、大文件与容错编辑、长任务目标锚。

## 设计哲学：自主优先 (autonomy-first)

agent 应当全速、放权、无人值守地跑出 200 分生产力。安全**做进机制**，不靠把决定推给坐在屏幕前的用户：

- 越界 → 靠内核沙箱边界挡住（不弹审批）
- 跑错 → 靠全量回滚一键全撤（不靠人确认）
- 崩溃 → 靠自动续会话扛住（不靠手动 `/resume`）

审批退化为「沙箱外不可逆升级」的极少数例外。git 提交等常规操作不问用户。

## 必须遵守的不变量

- **Prefix-cache**：C4 目标锚只渲染进 appendix 区，绝不改 frozen 前缀 / 不重排历史。
- **沙箱不误伤工作流**：网络默认放行（npm/pip/git 需要），写放行 `cwd + TMPDIR + 包管理器缓存`，仅拦工作区外写；`RIVET_NO_SANDBOX=1` 逃生阀。
- **跨平台三平台一等公民**：macOS Seatbelt / Linux Landlock 内置首选；bwrap/firejail Linux 可选增强；Windows 走 WSL→Linux 或原生 AppContainer + Job Object。

---

## Part B — 放权全速跑的安全底座

### B1. 默认开启、工作区作用域的真沙箱
- 新建 `src/tools/sandbox-profile.ts`：统一 `SandboxBackend` 抽象（mac/linux/windows/none），按 workspace root 动态生成 profile。
  - macOS Seatbelt：`(allow default)` + `(deny file-write*)` 后放回 `cwd`/TMPDIR/包缓存写权，网络放行。
  - Linux：Landlock 优先（内置），bwrap 兜底 `--bind cwd` rw + `--ro-bind / /`，**保留网络**（去掉 `--unshare-net`，build 需联网）。
  - Windows：先探测 WSL → 复用 Linux 路径；原生走 AppContainer（FS ACL 边界）+ Job Object（进程树围栏），建不起来 **fail-closed**（拒绝工作区外写）。
- `src/tools/bash.ts`：移除 `RIVET_BASH_SANDBOX` 闸门改为**默认开启**，新增 `RIVET_NO_SANDBOX=1` 逃生阀，收口到 `sandboxWrap`。
- 审批级联调整：沙箱内命令默认自主模式不再逐条弹审批（含 git 提交）。
- 测试：`sandbox-profile.test.ts`（后端探测/分派 + profile 纯函数生成，含 mac/linux/wsl/native-windows/none），`bash-sandbox.test.ts`（默认开启 + 逃生阀）。

### B2. 全量回滚 / 时间旅行（含 bash 副作用，并行会话安全）
- **核心风险**：同一分支多会话并行，blanket 还原整树会回滚掉别的会话刚改的文件。故回滚必须**按会话归属作用域，只还原本会话本轮真正动过的路径**。
- `src/agent/checkpoint.ts`：
  - checkpoint 触发从 `write/edit` 扩到 `bash` 及一切 mutating 工具。
  - `recordBashSideEffects` 用 `git status --porcelain` 捕获 bash 新建/删除/改动文件。
  - `getRollbackPreview` / `rollbackToCheckpoint` 接 `OwnershipGuard`：被其他存活会话 exclusive 持有的路径**跳过不还原**，以 blocked 语义上报；`makeOwnershipGuard` 工厂接 `ClaimLookup`（SessionRegistry）。
- `src/agent/tool-pipeline.ts`：`MUTATING_TOOLS` / `isMutatingTool` 扩展 checkpoint 触发；bash 执行后调用 `recordBashSideEffects`；`buildOwnershipGuard` 接归属校验。
- 测试：`checkpoint.test.ts`（bash 副作用捕获+还原；并行会话隔离——A 回滚不碰 B 的 exclusive 文件）。

### B3. 崩溃 / 冷启动自动续会话
- 新建 `src/agent/session-recovery.ts`：`decideStartupSession` 依据内容/状态/新鲜度（`RESUME_FRESHNESS_MS`）/环境变量决定续接还是新建。
- `src/bootstrap.ts` + `src/main-ink.tsx`：`getOrCreateSessionId` 改为先读 `session-id.txt`，崩溃/冷启动自动恢复上下文，去掉手动 `/resume`。
- 测试：`session-recovery.test.ts`（fresh/resume/complete/stale/forced-new 各场景）。

---

## Part C — Cursor 级代码智能

### C1. 真语义检索（embedding 向量层，混合可插拔）
- 新建 `src/search/embedding-provider.ts`：`EmbeddingProvider` 接口 + `RemoteEmbeddingProvider`（OpenAI 兼容）/ `NullEmbeddingProvider`（离线降级）/ `createEmbeddingProvider` 工厂。
- 新建 `src/search/vector-index.ts`：chunk 向量持久化（`cosineSimilarity` + 快照 load/save）。
- 新建 `src/search/hybrid-search.ts`：BM25 + 向量用 **RRF** 融合重排；无 key/离线自动降级回 BM25。
- 改 `src/search/semantic-index.ts` / `src/tools/semantic-search.ts`：接 `searchHybrid`，结果标注 backend（bm25/hybrid）。
- 测试：`hybrid-search.test.ts`、`semantic-hybrid.test.ts`（概念查询命中 BM25 漏掉的语义匹配 + 离线降级）。

### C2. Polyglot 索引 + LSP 自动探测
- 扩展 `SOURCE_EXT` 至 Python/Go/Rust/Java/C/C++ 等；新建 `src/search/chunker-treesitter.ts` 做语言感知函数/类边界切块（`chunkByDefinitions` + `windowChunks` 兜底 + `foldLeadingPreamble`）。
- 新建 `src/lsp/server-registry.ts`：按扩展名探测 spawn pyright/gopls/rust-analyzer/clangd/jdtls；`src/lsp/multi-manager.ts` 多路复用按语言懒启动。
- 测试：`chunker.test.ts`、`server-registry.test.ts`（扩展名映射 + 可用性探测）。

### C3. 大文件编辑 + 容错匹配
- `src/tools/edit.ts`：`MAX_EDIT_FILE_BYTES` 100KB → **8MB**。
- 新建 `src/tools/fuzzy-match.ts`：精确 `old_string` 失败时**空白/缩进容错匹配**兜底（归一化定位、唯一性校验、映射回原文），把「diff 落不下去」失败率压到接近 Cursor apply 模型，不引入独立模型。
  - `hash-edit.ts` 本身无大小上限 + 已有锚点 ±50 行 stale 恢复，不重复加字符串级 fuzzy。
- 测试：`fuzzy-match.test.ts`（缩进/tab/尾空白漂移命中、歧义/缺失返回 null）、`edit.test.ts`（>100KB 文件成功 edit、缩进漂移容错命中、无误匹配）。

### C4. 压缩目标锚（长任务不漂移）
- `src/context/task-contract.ts`：`renderTaskAnchor` 把 active TaskContract（目标/约束=禁止项/成功标准）与 live progress（已完成/剩余）融合成**权威锚块**，显式标注 authoritative。
- `src/agent/compaction-controller.ts`：`buildTaskAnchorAppendix` 在每次压缩输出（tier-2 micro compact + `replaceWithCheckpoint` 的 session split / ceiling）后，把锚块**尾部追加进 appendix 区**——绝不动 frozen 前缀，prefix-cache 安全。
- `src/compact/constants.ts`：`TASK_ANCHOR_MAX_ITEMS` 控制锚块每列条目数，保证重注入不膨胀。
- `src/agent/loop.ts`：`getActiveContract: () => this.taskContract` 把 live 契约接进控制器。
- 测试：`task-contract.test.ts`（锚块渲染 + 非 actionable 返回空）、`compaction-controller.test.ts`（ceiling/tier-2 后锚块落 appendix、frozen 前缀不动、无契约不注入）。

---

## 验证

- `npm run typecheck`：绿。
- B+C 自写测试套件 **119 passing / 0 failing**。
- 全量 `npm test`：6042 passing。15 个 failing 均为**先于本次工作存在**的基线失败（已 stash 本次改动逐一比对确认：undo / startup-memory 在 HEAD 同样失败；其余落在本次未触碰的子系统——themes / phaseIndicator / ProfileRegistry / metrics / stall-sweep）。
- `compaction-controller.test.ts` 中 `P1.2: prune does NOT modify session message storage` 为预存在失败，与 C4 无关。

## 已知边界与后续

- 原生 Windows AppContainer 的内核级 FS 作用域不如 seatbelt/landlock 简洁可靠；建不起来时 fail-closed，由 B2 全量回滚做跨平台兜底安全网。CI 无法覆盖原生平台，已用后端选择 + profile 生成纯函数测试覆盖。
- C1 远端 embedding 默认走当前配置 provider，无 key 时自动降级 BM25；本地模型（transformers.js/fastembed）留作后续 opt-in provider。
- 大仓库向量检索目前暴力 cosine，HNSW 留作后续优化。
