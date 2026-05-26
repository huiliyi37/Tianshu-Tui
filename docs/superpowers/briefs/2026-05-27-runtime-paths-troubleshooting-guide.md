# Runtime 路径与排障指南

> 最后更新：2026-05-27  
> 适用范围：当前 `tianshu-pangu-2.9.1` 系列运行时；覆盖 DeepSeek cache-log、sensorium、session memory、claims、artifacts 与 legacy 路径兼容排查。

## 1. 背景

当前 runtime 文件已经从早期的全局 `.rivet/*` 逐步迁移到 session-scoped 路径。核心目标是：

1. **多会话隔离**：主会话、worker、并行 TUI 不再竞争同一个 runtime 文件。
2. **排障可定位**：cache 命中率、sensorium、memory、claims 都能按 session 归档。
3. **降低误判**：旧文档里常见的 `.rivet/cache-log.jsonl` / `.rivet/sensorium.jsonl` 仍可能出现在旧 bundle 或旧 commit 中，但不再是当前首选路径。

排障时原则：**先找 sessionId，再看 `.rivet/sessions/<sessionId>/...`；只有确认运行旧版本或无 sessionId 时，才回退到 legacy `.rivet/...`。**

## 2. 当前路径总览

| 数据 | 当前首选路径 | Legacy / 兼容路径 | 说明 |
|---|---|---|---|
| DeepSeek cache log | `.rivet/sessions/<sessionId>/cache-log.jsonl` | `.rivet/cache-log.jsonl` | `AgentLoop.recordTurnCache()` 当前写 session-scoped；旧 bundle/旧 commit 可能写全局路径。 |
| Sensorium telemetry | `.rivet/sessions/<sessionId>/sensorium.jsonl` | `.rivet/sensorium.jsonl` | `createTelemetryWriter(cwd, sessionId)` 有 sessionId 时写 session-scoped；无 sessionId 时回退 legacy。 |
| Session transcript | `~/.rivet/sessions/<sessionId>.jsonl` | 无 | OAI/session 持久化日志，不在项目 `.rivet/` 内。 |
| Session metadata | `~/.rivet/sessions/<sessionId>.meta.json` | 无 | session 元信息。 |
| Session memory | `~/.rivet/sessions/<sessionId>.memory.json` | 无 | compact/session memory；source 通常包含 `compact` 等。 |
| Durable claims | `~/.rivet/sessions/<sessionId>.claims.jsonl` | 无 | claim store append-only 日志。 |
| Claims snapshot | `~/.rivet/sessions/<sessionId>.claims.snapshot.json` | 无 | claim store 快照。 |
| Session backups | `~/.rivet/sessions/<sessionId>/backups/` | 无 | session persist 备份。 |
| Artifact store | `.rivet/artifacts/<sessionId>/...` | 旧 artifacts 可能无 session 分层 | 大工具输出的完整内容。 |
| Checkpoint | `.rivet/checkpoint-<sessionId>.json` | `.rivet/checkpoint.json` | sessionId 存在时优先 session-scoped；部分 legacy fallback 仍保留。 |
| Checkpoint index | `.rivet/checkpoints/index.json` | 无 | session checkpoint 索引。 |
| Pheromones | 当前代码/文档有过渡差异，见第 5 节 | `.rivet/pheromones.json` | 交接文档记录曾迁移到 session-scoped；部分模块注释仍描述全局路径。排障时两边都查。 |
| Heuristics | 当前代码/文档有过渡差异，见第 5 节 | `.rivet/knowledge/heuristics.jsonl` / `.rivet/heuristics.jsonl` | 代码层 `HeuristicStore` 接收外部 path；不同计划文档路径不完全一致。 |

## 3. 快速定位当前 sessionId

### 3.1 TUI 运行中

优先使用 UI/日志中显示的 sessionId。如果只知道 cache-log 或 sensorium 文件，可用目录名反推：

```bash
find .rivet/sessions -maxdepth 2 -name 'cache-log.jsonl' -print
find .rivet/sessions -maxdepth 2 -name 'sensorium.jsonl' -print
```

路径形如：

```text
.rivet/sessions/455e9a5a-0b50-41db-8a55-2edee46649dd/cache-log.jsonl
```

其中 `455e9a5a-0b50-41db-8a55-2edee46649dd` 就是 sessionId。

### 3.2 从持久化 session 目录找最近会话

```bash
ls -lt ~/.rivet/sessions/*.jsonl | head
```

如果要同时看 metadata / memory / claims：

```bash
sid='<sessionId>'
ls -l ~/.rivet/sessions/${sid}.*
```

## 4. 常见排障流程

### 4.1 cache-log 仍然是 0% 或找不到

1. 确认运行的是最新构建：

   ```bash
   npm run build
   node dist/main.js
   ```

2. 优先查 session-scoped 路径：

   ```bash
   find .rivet/sessions -maxdepth 2 -name 'cache-log.jsonl' -print
   tail -f .rivet/sessions/<sessionId>/cache-log.jsonl
   ```

3. 如果没有 session-scoped 文件，再查 legacy：

   ```bash
   test -f .rivet/cache-log.jsonl && tail -f .rivet/cache-log.jsonl
   ```

4. 判读字段：

   ```json
   {"t":...,"turn":2,"input":123456,"cacheRead":110000,"cacheCreate":1000,"hitRate":"89.1%"}
   ```

   - `cacheRead` 来自 provider usage 的 cache read tokens。
   - `hitRate = cacheRead / input`。
   - 首轮冷启动为 0% 或低命中是正常现象。
   - 修改 `src/prompt/static.ts`、tool definitions、provider/system prompt 配置后，下一轮 cache miss 是正常现象。

### 4.2 sensorium 没有更新

1. 当前首选：

   ```bash
   tail -f .rivet/sessions/<sessionId>/sensorium.jsonl
   ```

2. 无 sessionId 或旧版本 fallback：

   ```bash
   tail -f .rivet/sensorium.jsonl
   ```

3. 如果两个都没有，检查是否完成至少一个 turn；旧设计也要求 sensorium 至少有完整 turn 后才有有效数据。

### 4.3 session split 后想看 memory 是否写入

```bash
sid='<sessionId>'
cat ~/.rivet/sessions/${sid}.memory.json
```

重点看：

- 是否存在 `source: "compact"` 的 entries。
- 是否包含 split/ceiling 前提取出的 decision、failure、user preference 等信息。
- 是否出现重复 text+source；重复通常说明 memory extraction 去重策略需要检查。

### 4.4 找完整工具输出 artifact

工具结果在 UI 中可能只显示 preview，完整内容应从 artifact store 查：

```bash
find .rivet/artifacts/<sessionId> -type f | head
```

如果只有旧 artifacts 结构或无法确定 sessionId：

```bash
find .rivet/artifacts -type f | head
```

### 4.5 checkpoint / undo 排障

sessionId 存在时优先：

```bash
ls -l .rivet/checkpoint-<sessionId>.json
cat .rivet/checkpoints/index.json
```

legacy fallback：

```bash
ls -l .rivet/checkpoint.json
```

不要用 `git reset --hard` 代替项目 checkpoint/undo；共享 worktree 下这会破坏其他 session 的文件。

## 5. 过渡差异：pheromones 与 heuristics

这两类文件在历史计划与当前代码注释中存在路径表述差异：

- 交接文档记录：`pheromones.json` / `heuristics.jsonl` 已迁移为 session-scoped runtime 路径。
- `src/context/stigmergy.ts` 注释仍描述 `.rivet/pheromones.json`。
- `src/compact/heuristic-store.ts` 本身不固定路径，而是由调用方传入 path；历史文档中出现过 `.rivet/knowledge/heuristics.jsonl` 和 `.rivet/heuristics.jsonl`。

因此排障时不要只查一个位置：

```bash
find .rivet -path '*pheromones.json' -o -path '*heuristics.jsonl'
```

如果要做后续代码清理，应先读调用方，确认实际传入路径，再统一文档与注释。不要仅根据旧设计文档改 runtime 行为。

## 6. 文档更新规则

新增或更新排障文档时：

1. 对 cache-log / sensorium 示例，优先写 session-scoped 路径。
2. 如需提 legacy，明确标注“旧 bundle / 旧 commit / 无 sessionId fallback”。
3. 涉及 `~/.rivet/sessions` 的文件必须区分项目内 `.rivet/` 与用户级 `~/.rivet/`。
4. 不要把 runtime artifact 当成源代码证据提交；`.rivet/sessions/*`、`.rivet/artifacts/*`、cache-log、sensorium 都是运行产物。
5. 1M context / prefix cache 相关问题，应同时链接或引用 prefix cache 不变量文档，避免误把 session split 的一次性 cold start 当成 regression。

## 7. Prefix cache 相关提醒

在 `contextWindow >= 1_000_000` 的 DeepSeek exact-prefix 模式下：

- 历史 message content 不可修改。
- message 数组只 append，不插入/删除/重排。
- `volatileBlock`、tools 数组、system prompt 在 session 内应保持稳定。
- `trySessionSplit` 会重建 session，接受一次性 cold start；它避免的是后续大规模历史改写。

详见：`docs/superpowers/analysis/2026-05-27-prefix-cache-invariant-registry.md`。
