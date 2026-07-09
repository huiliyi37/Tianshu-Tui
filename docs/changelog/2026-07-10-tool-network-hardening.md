# 2026-07-10 — 工具与网络层加固批次

> 背景见 SWE-bench 基线报告（`docs/research/2026-07-09-swebench-baseline-tianquan-v4-pro-validation.md`）
> 与三份只读审计（网络出站 / 外部进程 / 编辑写工具）。目标：消除 corruption /
> turn 挂死 / 未加固出站三类缺口。编辑工具线细节见
> `docs/research/2026-07-09-edit-tool-reliability-improvements.md`。

## 编辑/写工具可靠性（corruption 拦截 + 自动回滚）

- `syntax-check.ts`：新增 `checkSyntax` 返回 `{warning, fatal}` 分级；`.py` 走系统
  `python3 ast.parse`。**python3 子进程加硬超时**（`RIVET_PY_SYNTAX_TIMEOUT`，默认
  5s）+ SIGKILL + spawn 失败/超时降级为 OK——挂起的解释器不再吊死 turn，缺失解释器
  不会误判为语法错触发回滚。
- `apply_patch`：apply 前逐目标文件 `trackFileChange` 备份；apply 后逐文件
  `checkSyntax`，fatal → `rollbackTargets`（恢复备份 / 删除新建文件）；成功接
  `recordSuccessfulEdit` + `resetEditFailCount`；diff 输入 pointer-回灌守卫；
  `RIVET_APPLY_PATCH_VERIFY=0` 可退回旧行为。
- `ast_edit`：写盘前 `trackFileChange`、写盘后 `checkSyntax`、fatal 恢复备份
  （`RIVET_AST_EDIT_VERIFY`）。
- `edit_file` / `hash_edit` / `write_file`：写后 `checkSyntax`，fatal 经
  `restoreLatestBackup` 回滚；`write_file` 成功路径补 `resetEditFailCount` 与
  edit/hash 对齐。`recovery-stack.ts` 新增 `restoreLatestBackup` + `latestBackups`。
- `edit-failure-recovery-hook`（postTool）：同一文件连续失败 ≥2 次经 advisory bus
  投递 repair 建议（undo → read_file → 改用 apply_patch/write_file）。
- prompt `<tool-usage>`：复杂/多处编辑引导改用 `apply_patch`（先 `check_only`）。

## 网络出站（对齐 httpFetchGuarded 四件套 / 补超时）

- `web_search` 三后端：新增 `boundedSearchFetch` 流式响应体大小上限（默认 8MB，
  防敌意/畸形响应撑爆堆）；DuckDuckGo 加 `redirect:'manual'` 不自动跟随到未校验主机。
  注入的测试 fetch 不包裹，工具 definition 保持字节稳定（前缀缓存）。
- `oauth-auth.ts`：token 交换/刷新两处 fetch 加 `AbortSignal.timeout`
  （`RIVET_OAUTH_TIMEOUT`，默认 30s）；错误体读取改 `readErrorBodyCapped`（64KB 上限）。
- `embedding-provider.ts`：`/embeddings` 请求加超时（`RIVET_EMBEDDING_TIMEOUT`，
  默认 30s），超时降级 BM25 而非卡死索引。

## 进程 / 参数健壮性

- `import_resource`：新增 `isSafeGitRef` —— 拒绝 `-` 开头的 ref（git 选项注入，如
  `--upload-pack=…`）及 git 非法字符；`clone`/`checkout` 加 `--` 分隔；git 缺失
  （ENOENT）给"请安装 git"友好提示。
- `office-reader.ts` / `office-writer.ts`：检测到 `libreoffice` 时执行不再硬编码
  `soffice`，用检测到的二进制名——修复只装 libreoffice、无 `soffice` symlink 的
  Linux 上"检测通过但转换 ENOENT"的假阳性。

## 测试

- 加固相关套件全绿：syntax-check / apply-patch / edit / hash-edit / write-file /
  read-file-invalidation / import-resource / web-search / edit-failure-recovery
  共 213+ 用例；write-file 25/25；typecheck、lint 通过。
- 新增：`web-search/__tests__/bounded-fetch.test.ts`、
  `import-resource.test.ts` 的 `isSafeGitRef` 用例、
  `edit-failure-recovery-hook.test.ts`。

## 收尾优化（同批补齐）

- **后台 job 进程级生命周期超时**（`job-store.ts`）：`BackgroundJob` 加绝对
  wall-clock 上限,到时走已有的 SIGTERM→SIGKILL,并在输出 ring 里留
  `[job killed] exceeded max lifetime` 让 `job(logs/await)` 可见。默认**关闭**
  （后台 job 本就是 dev server/watcher 等长命进程,盲目超时会误杀）——由
  `RIVET_JOB_MAX_MS` 开启,供 eval/CI 收割永不退出的 runaway job;`JobSpawnOptions.maxLifetimeMs` 支持 per-spawn 覆盖。
- **清理 `multi_edit`/`notebook_edit` 遗留工具名**：这两个名字从未注册为工具,
  却出现在三处写工具名集合里。移除死名的同时对齐到注册表实际的编辑/写工具
  （`write_file`/`edit_file`/`hash_edit`/`ast_edit`/`apply_patch`）——顺带修复了
  `session-persist.ts` 孤儿恢复集合**漏掉主力编辑器 `hash_edit` 与 `ast_edit`** 的
  潜在缺口（孤儿化的 hash_edit 之前不会触发验证式非破坏恢复）,以及
  `write-evidence-probe.ts` 漏掉 `ast_edit` 的磁盘证据召回;并移除
  `extractTargetPath` 中随 notebook_edit 一起废弃的 `notebook_path` 兜底。
