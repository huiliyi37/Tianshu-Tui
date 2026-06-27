# P1 投机预读方案（pi 版）

> 流式解析到 read 工具的 path 参数时，提前把文件读入 per-session 内存 LRU，
> 让正式 read 命中内存而非磁盘。比天枢原版更进一步（天枢只暖 OS 页缓存，不命中内存）。
>
- 目标项目: `/Users/banxia/app/deepseek-tui/oh-my-pi`
- 参考来源: 天枢 `src/agent/turn-stream.ts:187` + `prewarm-file.ts`
- 制定日期: 2026-06-26
- **状态: 方案待实现**

---

## 一、目标与关键决策

**目标**：模型流式输出 thinking/tool_use 时，增量解析出 read 的 `path` 参数，异步把文件全文读入 per-session LRU。正式 read 执行时查缓存命中，省掉 `Bun.file().text()` 的磁盘 I/O。

### 关键决策（已确认）

1. **内存 LRU 命中**（非天枢的 OS 页缓存预热）——比天枢原版更强，read 工具真正从缓存读取。
2. **只做 P1，先验证收益**——不接 P2（grep→read 批量）和 P3（turn-boundary）。
3. **cap 一致性**：缓存**原始全文**（normalized），不应用任何 cap；消费时按当前 cap 处理。彻底规避天枢注释（`tool-pipeline.ts:870-874`）指出的"预热 cap ≠ 正式 cap 导致截断回归"问题。

### 与天枢的关键差异

| 维度 | 天枢 | 本方案（pi） |
|------|------|------------|
| read 是否消费缓存 | ❌ 不消费（dead store，靠 OS 页缓存）| ✅ 消费（内存 LRU 命中）|
| cap 一致性处理 | 无（所以不消费）| 缓存原始全文，消费时按 cap 处理 |
| 命中率统计 | 永远 0（get() 未被调用）| 真实统计 |
| 触发点 | turn-stream.ts onToolHint | onAssistantMessageEvent（agent 配置）|

---

## 二、设计依据（已核实的事实）

1. **pi 已有增量 tool args 解析**：`packages/ai/src/providers/*.ts` 在 `toolcall_delta` 事件里，用 `parseStreamingJsonThrottled`（`utils/json-parse.ts:550`）把部分 JSON 解析成 `block.arguments`。**预读层无需自己写增量 JSON 解析器**，直接读 `event.partial.content[idx].arguments.path`。

2. **pi 已有 onAssistantMessageEvent 回调**：`packages/agent/src/types.ts:377` 定义 `(message, event) => void`，在每个 `toolcall_delta`/`toolcall_end` 上同步触发。注册点 `agent.ts:462/770`（`setOnAssistantMessageEvent` 或 opts 注入）。**这是投机预读的正确落点**——早于 beforeToolCall（后者在流结束后才触发，太晚）。

3. **pi 的 LRU per-session 范式**：`read.ts:124-133` 的 `summaryParseCaches = WeakMap<session, LRUCache>` 是现成模板——session GC 时缓存自动回收。直接复制这个结构。

4. **read 工具的读取路径**：本地文件分支用 `Bun.file(absolutePath).text()`（无内存缓存）。预读缓存的命中点应放在该分支入口、`Bun.file().text()` 之前。

5. **read 工具的 cap 机制**：用固定的 `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`（从 output-meta import），无动态 contextWindow cap。缓存原始全文、消费时按固定 cap 处理即可。

---

## 三、实现方案

### 改动范围：3 个文件

| 文件 | 改动 |
|------|------|
| `packages/coding-agent/src/tools/prewarm-cache.ts` | **新建**: per-session LRU + mtime 校验 + 统计 |
| `packages/coding-agent/src/tools/read.ts` | **改**: execute 本地文件分支加缓存命中点 |
| `packages/coding-agent/src/session/agent-session.ts` | **改**: 注册 onAssistantMessageEvent 投机预读 |

### 3.1 新建 `prewarm-cache.ts`（核心，~90 行）

```ts
/**
 * Speculative file prewarm cache — when the model streams a `read` tool call,
 * the path argument is extracted early from the partial tool args and the file
 * is read into this per-session LRU. The read tool's execute then hits the
 * cache instead of re-reading from disk.
 *
 * Stores the **full normalized text** (no read cap applied), so cap consistency
 * is automatic: the cache holds raw material, the read tool applies its cap at
 * consume time. This avoids the truncation-regression trap that made tianshu
 * keep its prewarm cache as a dead store (tool-pipeline.ts:870-874).
 *
 * mtime is recorded alongside the text; a cache entry is only served when the
 * live file's mtime still matches, so external edits between prewarm and the
 * real read never serve stale content.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LRUCache } from "lru-cache/raw";
import { normalizeToLF } from "../edit/normalize";

interface PrewarmEntry {
	/** LF-normalized full file text, no cap applied. */
	readonly text: string;
	/** File mtime (ms) when prewarmed; checked against live mtime on hit. */
	readonly mtimeMs: number;
}

/** Files above this size are not prewarmed (matches snapshot store cap). */
const PREWARM_MAX_BYTES = 4 * 1024 * 1024;

interface SessionOwner {
	prewarmCache?: LRUCache<string, PrewarmEntry>;
}

/** Look up (or lazily create) the per-session prewarm cache. */
export function getPrewarmCache(session: SessionOwner): LRUCache<string, PrewarmEntry> {
	if (!session.prewarmCache) {
		session.prewarmCache = new LRUCache<string, PrewarmEntry>({
			max: 50,
			ttl: 60_000,
			allowStale: false,
		});
	}
	return session.prewarmCache;
}

/** Canonical key for a path — realpath-collapsed so symlink/suffix forms fuse. */
export function prewarmKey(cwd: string, inputPath: string): string {
	const abs = path.resolve(cwd, inputPath);
	try {
		return fs.realpathSync.native(abs);
	} catch {
		return abs;
	}
}

/**
 * Speculatively read a file into the cache, fire-and-forget. No-op on errors
 * (missing file, binary, oversized) — the real read handles those. Returns the
 * canonical key on success for stats, undefined otherwise.
 */
export async function prewarmFile(session: SessionOwner, cwd: string, inputPath: string): Promise<string | undefined> {
	const key = prewarmKey(cwd, inputPath);
	const cache = getPrewarmCache(session);
	if (cache.has(key)) return key; // already warm
	try {
		const file = Bun.file(key);
		const stat = await file.stat();
		if (stat.isDirectory() || stat.size > PREWARM_MAX_BYTES) return undefined;
		const text = normalizeToLF(await file.text());
		cache.set(key, { text, mtimeMs: stat.mtimeMs });
		return key;
	} catch {
		return undefined;
	}
}

/**
 * Consume a prewarmed file. Returns the normalized full text only when a cache
 * entry exists AND the live file's mtime still matches (no external edit).
 * Returns null on miss/stale — caller falls back to `Bun.file().text()`.
 */
export function consumePrewarm(session: SessionOwner, absolutePath: string): string | null {
	const cache = getPrewarmCache(session);
	const entry = cache.get(absolutePath);
	if (!entry) return null;
	try {
		const liveMtime = fs.statSync(absolutePath).mtimeMs;
		if (liveMtime !== entry.mtimeMs) {
			cache.delete(absolutePath);
			return null; // file changed externally since prewarm
		}
		return entry.text;
	} catch {
		return null; // file deleted or unreadable
	}
}

export interface PrewarmStats {
	hits: number;
	misses: number;
	warmed: number;
}

let hits = 0;
let misses = 0;
let warmed = 0;

/** Called by consumePrewarm's caller to record hit/miss. */
export function recordPrewarmHit(): void { hits++; }
export function recordPrewarmMiss(): void { misses++; }
export function recordPrewarmWarmed(): void { warmed++; }

export function getPrewarmStats(): PrewarmStats {
	return { hits, misses, warmed };
}

export function resetPrewarmStatsForTests(): void {
	hits = 0; misses = 0; warmed = 0;
}
```

### 3.2 改 `read.ts`：本地文件分支加缓存命中点

在 execute 的纯本地文件分支（read-ref 判定之后、或与之并列），`Bun.file().text()` 之前插入命中检查：

```ts
// —— prewarm: hit memory cache when the file was speculatively prewarmed ——
const cached = consumePrewarm(this.session, canonicalSnapshotKey(absolutePath));
// canonicalSnapshotKey 已 import；用 realpath 后的 key 对齐 prewarmFile 的 key
```

**关键**：prewarm 存的是**原始全文**，read 拿到后继续走原有的 cap/format 流程（不做任何特殊处理）。命中只是省掉一次 `Bun.file().text()` 磁盘读，后续逻辑完全不变。

具体接入位置（与 read-ref 协调）：
- read-ref 在最前（重复读→返回引用）
- prewarm 命中在 read-ref 之后（非重复读→省磁盘读，但仍返回完整内容）

### 3.3 改 `agent-session.ts`：注册投机预读回调

在 AgentSession 构造或 agent 配置处，注册 `onAssistantMessageEvent`：

```ts
onAssistantMessageEvent: (message, event) => {
	// Only the streaming tool-call deltas carry partial args worth prewarming.
	if (event.type !== "toolcall_delta" && event.type !== "toolcall_start") return;
	const block = message.content[event.contentIndex];
	if (block?.type !== "toolCall" || block.name !== "read") return;
	const args = block.arguments as Record<string, unknown> | undefined;
	const readPath = typeof args?.path === "string" ? args.path : undefined;
	// Only prewarm once we have a path that looks complete enough (closed
	// quote or reasonable length) to avoid churning on half-parsed JSON.
	if (!readPath || readPath.length < 2 || readPath.includes('"')) return;
	// Fire-and-forget; never block the stream.
	void prewarmFile(this.toolSession, this.toolSession.cwd, readPath)
		.then(key => { if (key) recordPrewarmWarmed(); })
		.catch(() => {});
},
```

**关键细节**：
- 只对 `read` 工具触发（pi 的工具名是 `read`，参数名是 `path`——不是天枢的 `read_file`/`file_path`）
- `readPath.includes('"')` 守卫：JSON 未闭合引号时不预读，避免路径残缺
- fire-and-forget（`void`），不 await，不阻塞流

---

## 四、cap 一致性的核心设计（为何规避天枢的坑）

天枢的 `tool-pipeline.ts:870-874` 注释解释了为什么 read_file 不消费 prewarm：

> The prewarm cache is shared with P3 speculative reads which may have been
> populated under a different (smaller) cap; serving cached content here would
> re-introduce the truncation regression.

本方案的解法是**缓存原始全文、消费时按 cap 处理**：

```
预热阶段：prewarmFile → 读全文 → normalizeToLF → 存 {text: 全文, mtimeMs}
                                    ↑ 不应用任何 cap
正式读阶段：consumePrewarm → 拿到全文 → 走 read 原有的 cap/format 流程
                                            ↑ cap 在这里才应用
```

因为缓存的是"无 cap 原料"，无论正式读时 cap 是多少，都从同一份原料按当前 cap 截断。**cap 在消费点应用，天然一致，不可能回归。**

---

## 五、mtime 校验（防陈旧内容）

`consumePrewarm` 在命中时比对 live mtime：

```ts
const liveMtime = fs.statSync(absolutePath).mtimeMs;
if (liveMtime !== entry.mtimeMs) {
	cache.delete(absolutePath);
	return null; // 文件在预热后被外部改了
}
```

这覆盖所有"预热后文件被改"的场景：
- 用户在编辑器里改了文件
- 另一个进程/agent 改了文件
- git checkout 切换分支

mtime 不匹配 → 不命中 → fall back 到正常 `Bun.file().text()`。这是 `statSync`（同步），但只在缓存命中时才调一次，且 stat 本身极快。

---

## 六、边界与风险

| 风险 | 处理 |
|------|------|
| 模型改主意（streamed path A，最终读 path B）| 无害：A 被预热进 LRU 占一个槽位，B miss 走正常读。LRU 50 槽位足够，60s TTL 自动过期 |
| 路径残缺（JSON 半解析）| `readPath.includes('"')` + `length < 2` 守卫跳过 |
| 大文件预热吃内存 | `PREWARM_MAX_BYTES = 4MB` + LRU 50 槽 = 最坏 200MB 上限；TTL 60s 回收 |
| 外部修改导致陈旧 | mtime 校验，不匹配则不命中 |
| 预热浪费（模型根本没调 read）| 无害：只是多一次后台 fs 读，OS 页缓存顺带也暖了 |
| 并发：预热和正式读同时 | 无害：都是只读，LRU 是线程安全的写入（last-write-wins），mtime 校验保证正确性 |

---

## 七、与 pi 现有机制的关系

### 与 read-ref 的关系（刚实现）

两者正交、互补：
- **read-ref**：重复读未变文件 → 返回引用行（省的是"内容进上下文"）
- **prewarm**：首次/任意读 → 命中内存缓存（省的是"磁盘 I/O"）

read-ref 在前（先判重复），prewarm 在后（非重复时省磁盘）。一个管"要不要再发内容"，一个管"读得快不快"。

### 不动的东西

- **不碰 summarizeCode**：summary 是"显示前压缩"，prewarm 是"读取加速"，不同层
- **不碰 snapcompact/pruning**：压缩是 L3，prewarm 是 L1
- **不接 P2/P3**：本方案只做 P1，验证收益后再决定
- **不碰 provider 层**：增量 JSON 解析 pi 已经有，直接读 `.arguments.path`

---

## 八、验证计划

### 8.1 单测（`prewarm-cache.test.ts`，~120 行）

- `prewarmFile` 存入缓存 + `consumePrewarm` 命中
- mtime 变化后 `consumePrewarm` 返回 null
- 大文件（>4MB）不预热
- 目录不预热
- 不存在的文件预热静默失败
- LRU 容量上限驱逐
- TTL 过期（用 fake timer 或直接测 TTL 配置）
- path 含未闭合引号被守卫拦截（这个测 agent-session 的回调逻辑）

### 8.2 实测（验证收益）

这是 P1 的核心目标——验证 turn interval 下降。方法：
1. 跑一个会反复 read 大文件的会话
2. 对比 prewarm 开启前后的：read 工具执行耗时、turn 间隔
3. 看 `getPrewarmStats()` 的 hits/warmed 比值（命中率高说明投机预读有效）

预期：SSD 上 fs.read 已经很快（~1-5ms），prewarm 的收益主要在**大文件**和**机械盘/NFS**场景。如果实测 SSD 收益不明显，说明 P1 的价值有限，应转向其它能力增强。

---

## 九、改动量

- 新建 `prewarm-cache.ts`: ~90 行
- 改 `read.ts`: ~8 行（1 import + 命中检查块）
- 改 `agent-session.ts`: ~20 行（onAssistantMessageEvent 回调注册）
- 新建 `prewarm-cache.test.ts`: ~120 行

总计约 240 行，分布在 3 个文件。

---

## 十、关键文件索引

### 天枢（参考来源）
- `src/agent/turn-stream.ts:187-193` — onToolCallHint → setImmediate(prewarmFile)
- `src/api/openai-client.ts:772-795` — SSE 增量 tool args 解析（乐观 JSON.parse）
- `src/agent/prewarm.ts:9-72` — PrewarmCache（TTL 60s, LRU 50）
- `src/agent/prewarm-file.ts:20-33` — buildPrewarmValue
- `src/agent/tool-pipeline.ts:870-874` — **关键注释**：为何 read_file 不消费 prewarm
- `src/agent/tool-pipeline.ts:1240-1245` — P2 grep→read 批量预热（本方案不做）

### pi（目标 + 已有设施）
- `packages/agent/src/types.ts:377` — onAssistantMessageEvent 回调签名
- `packages/agent/src/agent.ts:462/770` — 回调注册点
- `packages/ai/src/utils/json-parse.ts:512/550` — parseStreamingJson（pi 已有，无需移植）
- `packages/coding-agent/src/tools/read.ts:124-133` — summaryParseCaches WeakMap-per-session 模板
- `packages/coding-agent/src/tools/read.ts` — execute 本地文件分支（命中点）
- `packages/coding-agent/src/session/agent-session.ts` — AgentSession（回调注册处）
- `packages/coding-agent/src/edit/normalize.ts` — normalizeToLF（已 import）

---

## 十一、实施顺序

1. 建 `prewarm-cache.ts`（纯函数 + LRU + mtime 校验 + 统计）
2. 建 `prewarm-cache.test.ts`，验证核心逻辑（命中/miss/mtime/边界）
3. 改 `read.ts`：execute 本地文件分支加命中点（与 read-ref 协调顺序）
4. 改 `agent-session.ts`：注册 onAssistantMessageEvent 投机预读回调
5. typecheck + lint
6. 实测验证 turn interval 收益

---

*文档结束。核心设计点：缓存原始全文（cap 在消费点应用）+ mtime 校验，彻底规避天枢注释指出的截断回归。只做 P1，收益验证后再决定 P2/P3。*
