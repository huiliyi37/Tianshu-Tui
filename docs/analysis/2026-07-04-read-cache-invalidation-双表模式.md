# read_file 缓存失效修复:双表拆分与并发会话失效模式

> 2026-07-04 · 对应提交:`fix(tools): read-dedup 缓存编辑后失效 — 双表拆分 + 会话键统一 + 跨会话事件失效`
> 修复对象:`[read-ref] 本会话已读且未变` 在 edit_file 成功后仍然命中、返回编辑前内容的缓存中毒 bug,及其镜像缺陷(过期检测静默失效)。

## 1. 故障机制回顾

`read_file` 有两层进程内去重缓存:`readHistory`(path+offset+limit 切片级)和 `fileReadHistory`(文件全量级),判断"未变"的依据是缓存条目 mtime 与磁盘当前 mtime 相等。两个缺陷互为镜像:

**语义中毒(用户报告的 bug)**:旧的 `refreshFileReadMtime` 在每次编辑成功后把缓存条目的 mtime **续期**成编辑后的值,但条目里的行数/字节数/artifactId 仍指向编辑前内容。下一次 read_file 一比对 mtime 相等 → 误判"已读且未变" → 返回 `[read-ref]` 指针或从编辑前的 artifact 切片。模型永远看不到自己刚改出来的内容,进而怀疑工具、绕路重试。

**键不一致(3d013535 引入)**:该提交给存储键加了 `sessionId::` 前缀防 fork/worker 互串,但三个模块级 helper(`getFileReadMtime`/`refreshFileReadMtime`/`registerGrepFileAccess`)仍用裸路径查表 → 永远 miss。副作用是中毒路径断了(负负得正),代价是 edit_file/hash_edit/write_file/read_section 四处的外部修改检测全部静默失效。

**为什么测试没抓住**:旧测试用 `fs.writeFileSync` 模拟"文件被修改",绕开了真实编辑工具的 refresh 调用链——中毒路径从未被测试覆盖。

## 2. 修复设计:双表拆分

根因是**一张表承载了两种互斥的语义**:

| 语义 | 需要的失效行为 |
|------|----------------|
| "模型实际读过什么内容"(read-ref/去重/artifact 切片的依据) | 编辑后必须**作废**——内容元数据已失真 |
| "本会话最后观察到的文件状态"(编辑工具 stale 检测的依据) | 编辑后必须**更新**——否则下次编辑误报"被外部修改" |

旧代码用一个 refresh 同时服务两者,必然顾此失彼。拆成两张表:

```
表1 readHistory / fileReadHistory   ← 只由读路径写入;编辑调 invalidateReadHistory() 删除
表2 lastKnownFileState              ← read_file / grep / 编辑成功 都写入;stale 检测只读它
```

- **表1** 新增 `sizeBytes` 字段,"未变"判断从单 mtime 升级为 **mtime + size 双校验**(`isUnchangedRepeatRead` 与 execute 内两处 artifact 快速路径),防 exFAT 等 2 秒 mtime 粒度文件系统上"读后立即编辑"击穿比对。
- **表2** 接替旧 refresh 的防"读-改-stale 死循环"职责:编辑成功后 `noteFileObserved()` 记下新 mtime,下次编辑的 stale 检测不误报;但表2 永远不参与 read-ref 判断,说谎通道被结构性封死。
- 编辑成功的三件套收口为一个入口 `recordSuccessfulEdit(path, sessionId)`:`invalidateReadHistory`(删表1,全会话)+ `markSessionFileEdit` + `noteFileObserved`。五个调用方(edit/hash_edit/write_file × 各写成功点)只调它,不再有人手工组合。

## 3. 并发会话覆盖

三层防线,对齐已落地的文件级并发归属语义(SessionRegistry exclusive claims):

1. **进程内多会话(fork/worker 共享模块级 Map)**:所有状态(表1/表2/`sessionFileEdits`)统一走 `${sessionId ?? ''}::${canonical}` 键,sessionId 从 `ToolCallParams` 一路线程化到 grep 的内部函数。A 会话的读取/编辑标记对 B 完全不可见——B 不会被误报 "you previously edited"、position-only hash_edit 不会被 A 的编辑误硬拒。
2. **跨进程被动失效**:mtime + size 双校验。他进程改了文件,磁盘状态变化自然使表1条目失效。
3. **跨进程主动失效**:复用已有的 `file_changed` 事件通道(stigmergy-hook 发布 → SQLite events 表 → turn 边界消费)。`turn-step-producer.ts` 消费到他会话的 `file_changed` 事件时调用 `invalidateReadCachesForEvents()` 删本地表1条目,保证下一次 read_file 必然真读。R2 独占写闸门(claims)不动——**claims 管跨会话写权,读缓存管本会话观察状态**,职责不混。

`invalidateReadHistory` 有意删除**所有会话**对该路径的条目:磁盘内容已变,任何会话的旧条目都不该活着;跨会话删除的最坏情况只是多一次真实读,永远安全。

## 4. 可复用的模式方法

**模式一:缓存失效语义——"作废"与"续期"不可共用一个入口。**
任何"观察缓存"(记录了内容特征的)在被观察对象变化后只能删除,不能改时间戳保活。需要"我自己刚改过它、别误报"的场景,另开一张只存状态戳、不存内容特征的表。识别信号:一个 refresh/touch 函数被"读路径"和"写路径"共同依赖时,几乎必然存在语义冲突。

**模式二:键方案变更必须全量灰度所有访问点。**
3d013535 给 Map 加 sessionId 前缀时漏掉了三个 helper,产生"写新键、读旧键"的静默 miss——比崩溃更糟,因为一切看起来还在跑。方法:改键时 grep 该 Map 的**每一个** `.get/.set/.has/.delete` 调用点列清单;或者把键构造收口成唯一函数(`fileHistoryKey`),禁止裸键字面量。本次把 `sessionFileEdits`/`lastKnownFileState` 也统一走同一键函数。

**模式三:mtime 判等永远配 size 副证。**
mtime 在粗粒度文件系统(exFAT 2s、旧 FAT)和快速读-写序列下会碰撞。`stat()` 一次就同时拿到两者,双校验零额外 IO。内容 hash 更强但有读取成本,mtime+size 是性价比拐点。

**模式四:进程内共享可变状态,一律按 sessionId 分域。**
本仓库常态是同进程多会话(主会话 + worker)。模块级 `Map`/`Set` 就是隐式全局变量,任何"本会话如何如何"的语义都必须把 sessionId 编进键。约定:`${sessionId ?? ''}::${canonical}`,undefined 归一为空串,保证单会话场景零成本兼容。

**模式五:跨进程缓存失效 = 被动校验 + 主动事件,双保险。**
被动(每次访问时校验磁盘状态)保证正确性下限;主动(消费 `file_changed` 事件删条目)消灭"校验本身被骗"的窗口(如模式三的 mtime 碰撞)。已有事件总线时,主动失效只是一个消费者,不需要新基建。注意接线要接**生产路径**——本次发现 `createCrossSessionHook` 只有测试在用,真实消费点在 `turn-step-producer.ts` 的 turn 边界,两处都接了。

**模式六:回归测试必须驱动真实工具链,不用 fs 模拟。**
"编辑后重读"的测试若用 `writeFileSync` 模拟编辑,恰好绕开编辑工具的缓存副作用(refresh/invalidate 调用),这正是本 bug 逃逸三周的原因。`read-file-invalidation.test.ts` 全部走 `EDIT_FILE_TOOL.execute → READ_FILE_TOOL.execute` 真实链路。判据:被测行为若由工具 A 的**副作用**触发,测试就必须真调工具 A。

## 5. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/tools/read-file.ts` | 双表拆分、`invalidateReadHistory`/`noteFileObserved`/`recordSuccessfulEdit`、mtime+size、键统一 |
| `src/tools/edit.ts` `hash-edit.ts` `write-file.ts` | 写成功点改 `recordSuccessfulEdit`;stale 检测/编辑标记传 sessionId |
| `src/tools/read-section.ts` `grep.ts` | sessionId 线程化,过期提示/grep 注册复活 |
| `src/agent/hooks/cross-session-hook.ts` | `invalidateReadCachesForEvents()`;hook deps 加可选 `cwd` |
| `src/agent/turn-step-producer.ts` | turn 边界消费 `file_changed` 事件时主动失效 |
| `src/tools/__tests__/read-file-invalidation.test.ts` | 新增 12 用例(真实工具链回归 + 并发隔离 + 事件失效 + size 硬化) |
| `src/tools/__tests__/read-file-dedup.test.ts` | 适配新签名,补 size 用例 |
