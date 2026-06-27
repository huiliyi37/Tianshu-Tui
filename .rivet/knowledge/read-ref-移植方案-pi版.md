# read-ref 移植方案（pi 版）

> 把天枢的 read-ref 引用行机制移植到 oh-my-pi 的方案文档。
>
- 目标项目: `/Users/banxia/app/deepseek-tui/oh-my-pi`
- 参考来源: 天枢 `/Users/banxia/app/deepseek-tui/opencode-tui/src/tools/read-file.ts:508-552`
- 制定日期: 2026-06-26
- **状态: 已实现** — typecheck + lint 通过，6 个单测全过

---

## 一、目标

当模型重复读取一个**本会话已读且内容未变**的本地文件时，在 `ReadTool.execute` 入口直接返回一行引用，不让全量内容再次进上下文。

**核心判定方式**: 复用 pi 已有的 `fileSnapshotStore`（内容 hash），不用 mtime。这是最小侵入、零新存储的方案。

**实证价值**: 天枢三个会话实测累计省 9.3MB 不进上下文（worker 会话 214 次 read-ref，平均每次省 41.9KB）。这些字节不省的话会变成 input token，既增每轮耗时又威胁缓存窗口稳定性。

---

## 二、设计依据（已核实的事实）

1. **pi 的 read 工具（`packages/coding-agent/src/tools/read.ts`，121KB）只在写侧记录快照**: `recordFileSnapshot` 在 `1598/2474/2478/2674` 行调用，但**从不在读前查表**。read-ref 就是补上这个对称的"读前查表"。

2. **pi 已有 `getFileSnapshotStore(session).head(key)`** 返回历史 `Snapshot`（含 `.hash`），是现成的内容指纹源。定义在 `packages/coding-agent/src/edit/file-snapshot-store.ts:33`。

3. **`record(canonical, text)` 返回的 tag 就是内容哈希**（同内容复用 tag，`packages/hashline/src/snapshots.ts:114-116` 注释），可与新读算出的哈希直接比对。

4. **pi 没有 read_section 工具**（全库零命中），但 read 本身支持 `path:N-M` selector（`read.ts:745-777` 的 `parseSel`），所以引用行应建议 `read <path>:<行范围>`。

5. **execute 入口（`read.ts:2010`）前有 conflict/URL/internal-url/archive/sqlite/pdf 多条特殊路径分支**，read-ref 必须挂在**纯本地文件主分支**内，避免误触发。

6. **判定方式选择**: 经确认采用 pi 的 snapshot hash（内容哈希）而非天枢的 mtime。理由: hash 比 mtime 更严格（外部 `touch` 不会误触发重读），且 pi 已有完整基础设施，零新存储。

---

## 三、两套基础设施对比

| 维度 | 天枢（mtime） | pi（内容 hash） |
|------|------------|--------------|
| 判定依据 | `priorSame.mtimeMs === currentMtimeMs` | `prior.hash === currentTag` |
| 存储 | 模块级单例 `readHistory`/`fileReadHistory` 两个 Map | `session.fileSnapshotStore`（per-session） |
| 误触发 | `touch` 会改 mtime 但内容未变 → 可能误判已变 | hash 不变 → 准确判定未变 |
| 复用已有设施 | 是（天枢自己的） | **是（pi 已有的 snapshot store）** |
| 归属 | 进程级全局 | per-session（随会话老化） |
| 决策 | — | **采用**（更严格 + 零新存储） |

---

## 四、实现方案

### 改动范围: 2 个文件

| 文件 | 改动 |
|------|------|
| `packages/coding-agent/src/tools/read.ts` | 新增 `read-ref.ts` 辅助模块的调用（execute 主分支入口）+ 1 个新 import |
| `packages/coding-agent/src/tools/read-ref.ts` | **新建**: 纯函数判定 + 引用行渲染 + 统计 |

不改 agent 包、不改 session 结构、不动 tool-result builder。

### 4.1 新建 `read-ref.ts`（核心，~80 行）

```ts
/**
 * read-ref — 当模型重复读一个本会话已读且内容未变的文件时，
 * 返回一行引用而非全文。复用 fileSnapshotStore 的内容 hash 判定，
 * 不引入 mtime、不引入新存储。
 *
 * 默认开（opt-out: OMP_READ_REF=0）。
 */
import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";

/** 内容超过此阈值（字节）才返回引用；小片段走正常 read 避免无谓往返 */
const READ_REF_THRESHOLD = 2048;

let savedBytes = 0;
let hitCount = 0;

/** 判定 + 返回引用行。命中返回引用文本，否则返回 null（走正常 read）。 */
export function maybeReadRef(opts: {
  store: InMemorySnapshotStore;
  canonicalKey: string;        // canonicalSnapshotKey(absolutePath)
  liveText: string;            // 当前磁盘内容（已读入）
  displayPath: string;         // 相对 cwd 的展示路径
  totalLines: number;          // 行数（用于提示）
}): string | null {
  if (process.env.OMP_READ_REF === "0") return null;
  if (opts.liveText.length <= READ_REF_THRESHOLD) return null;

  const prior = opts.store.head(opts.canonicalKey);
  if (!prior) return null;

  // 算当前内容哈希与历史比对。
  // store.record 对同内容会复用 tag（幂等，snapshots.ts:114-116），不产生副作用。
  const currentTag = opts.store.record(opts.canonicalKey, opts.liveText);
  if (currentTag !== prior.hash) return null;  // 内容变了

  // 命中：累加统计
  savedBytes += opts.liveText.length;
  hitCount++;
  return [
    `[read-ref] ${opts.displayPath} 本会话已读且内容未变（${opts.totalLines} 行）。`,
    `完整内容在你上文的 read 结果里——回看即可。`,
    `需要具体区段: read ${opts.displayPath}:<行范围>(如 :100-200)`,
  ].join("\n");
}

export function getReadRefStats(): { savedBytes: number; hitCount: number } {
  return { savedBytes, hitCount };
}

export function resetReadRefStatsForTests(): void {
  savedBytes = 0; hitCount = 0;
}
```

### 4.2 改 `read.ts`: 在纯文件主分支插入判定（精确位置 L2193）

`execute`（`read.ts:2010`）有深层嵌套分支，精确插入点在 **L2193**（conflict 检查 `return` 之后、`readImageMetadata` 之前）:

```
2138: absolutePath 已确定
2175: 目录 → #readDirectory (排除)
2190: conflict → #readFileConflicts (排除)
2193: ★ read-ref 插入点（parsed.kind === "none" 守卫）
2194: readImageMetadata → image/notebook/markit 分支
```

**为什么是 L2193 而非更早/更晚**:
- conflict 之后: 避免对冲突文件误读全文
- image/notebook 之前: 如果文件在 snapshot store 有记录（之前作为文本读过），hash 比对能命中；图片/notebook 从未被 record 为文本，`head()` 返回 null → 不命中 → 正常 fallthrough 到 image/notebook 分支，**不会误伤**
- 只有"之前作为纯文本读过且内容未变"才命中

```ts
// —— read-ref: 重复读未变文件返回引用行 ——
const canonicalKey = canonicalSnapshotKey(absolutePath);
const fileText = await Bun.file(absolutePath).text();  // 正常读取本来就要做
const refLine = maybeReadRef({
  store: getFileSnapshotStore(this.session),
  canonicalKey,
  liveText: normalizeToLF(fileText),
  displayPath: path.relative(this.session.cwd, absolutePath),
  totalLines: fileText.split("\n").length,
});
if (refLine) {
  return toolResult<ReadToolDetails>({ kind: "file" })
    .text(refLine)
    .sourcePath(absolutePath)
    .done();
}
// 未命中: 继续原有读取流程（recordFileSnapshot 会写入这次内容）
```

**关键细节**:
- 判定需要先 `fileText`——但这不是浪费，因为正常 read 本来就要读全文（`recordFileSnapshot` 也是 `Bun.file().text()` 读全文算 tag）。read-ref 命中时省的是"把全文塞进上下文"，不是"省 fs 读"。
- **必须用 `normalizeToLF`** 处理后比对，因为 `recordFileSnapshot` 写入时也做了 normalize（`file-snapshot-store.ts:86`）。不一致会误判。
- 挂载点必须排除 `:N-M` selector（片段读）——只在全量读时触发引用。selector 解析在主分支内已有，检查 `parsed.kind === "none"` 即全量读。

### 4.3 行范围 selector 的处理

只对**全量读**触发 read-ref（与天枢一致: `offset === 1 && !limit`）。片段读（`:100-200`）即使内容未变也正常返回——因为模型显式要某个区段，引用化反而误导。

pi 的 `parseSel`（`read.ts:745-777`）返回 `{ kind: "none" }` 表示无 selector（全量读），用这个判定。

---

## 五、边界与风险

| 风险 | 处理 |
|------|------|
| 模型真的需要看内容（比如用户编辑后想确认） | 内容 hash 变了 → `currentTag !== prior.hash` → 不命中 → 正常返回全文。hash 比 mtime 更可靠，touch 不会误判 |
| 大文件每次重读都要读全文算 hash | 正常 read 本来就读全文（为 record tag），无额外成本 |
| `record()` 调用会污染统计 | record 对同内容复用 tag 是幂等的（`snapshots.ts:114-116`），不产生副作用 |
| selector 片段读误触发 | 用 `parsed.kind === "none"` 严格限定全量读 |
| 默认开影响现有行为 | env `OMP_READ_REF=0` 可 opt-out；统计可通过 `getReadRefStats()` 观测 |
| 新文件首次读 | `store.head(key)` 返回 null → 不命中 → 正常读 + record。第二次读同内容才命中 |

---

## 六、与 pi 现有机制的关系

### 与 `pruneSupersededToolResults`（`compaction/pruning.ts`）的关系

两者正交，不冲突:

| 维度 | read-ref（本方案） | pruneSuperseded（pi 已有） |
|------|------------------|--------------------------|
| 作用阶段 | **源头拦截**（工具执行时） | **事后裁剪**（压缩阶段） |
| 作用对象 | 新的重复读请求 | 历史里的旧 read 结果 |
| 效果 | 重复读从源头就是引用，零膨胀 | 旧的折叠了，但新的全量内容已进过上下文 |
| 互补性 | read-ref 处理"未来重复" | supersede 处理"历史沉淀" |

pi 现在只有事后裁剪，补上 read-ref 后两者形成完整的"前堵后清"。

### 不动的东西

- **不引入 read_section 工具**: pi 的 `read path:N-M` 已覆盖该能力
- **不改 agent-loop / afterToolCall hook**: 在工具内部判定，零跨层改动
- **不引入 mtime**: 完全用 pi 已有的 hash 机制
- **不碰 pruning.ts 的 supersede 机制**: 两者正交
- **不动 ArtifactManager**: read-ref 用的是 fileSnapshotStore，与 ArtifactManager（超长输出落盘）无关

---

## 七、验证计划

### 7.1 单测（`read-ref.test.ts`，~100 行）

- 首次读不命中 → 正常返回
- 同内容二次读命中 → 返回引用行 + 统计累加
- 内容改动后读不命中（hash 不同）→ 正常返回
- `:N-M` 片段读不触发
- 小文件（<2048B）不触发
- `OMP_READ_REF=0` 关闭

### 7.2 实测

跑一个真实会话，对比开启前后的 input token（用 pi 的 stats 或 session dump）。预期: 频繁重读源文件的任务会显著降低 input token。

---

## 八、改动量

- 新建 `read-ref.ts`: ~80 行
- 改 `read.ts`: ~15 行（1 import + 主分支插入判定块）
- 新建 `read-ref.test.ts`: ~100 行

总计约 200 行，集中在 1 个工具文件，不动 agent/session 架构。

---

## 九、关键文件索引

### 天枢（参考来源）
- `src/tools/read-file.ts:508-552` — read-ref 核心实现
- `src/tools/read-file.ts:125-137` — `isUnchangedRepeatRead`
- `src/tools/read-file.ts:36-62` — `readHistory`/`fileReadHistory` Map 定义
- `src/tools/read-file.ts:67-78` — `isReadRefEnabled`/`READ_REF_THRESHOLD`/统计
- `src/tools/read-section.ts:139-188` — 配套的 `read_section` 工具（pi 无需移植）

### pi（目标 + 已有设施）
- `packages/coding-agent/src/tools/read-ref.ts` — **新建**，read-ref 纯函数判定 + 统计
- `packages/coding-agent/src/tools/read.ts:2193` — **改**，插入判定块（`parsed.kind === "none"` 守卫）
- `packages/coding-agent/test/tools/read-ref.test.ts` — **新建**，6 个单测场景
- `packages/coding-agent/src/tools/read.ts:1598/2474/2478/2674` — 现有 `recordFileSnapshot` 调用点（只写不查）
- `packages/coding-agent/src/edit/file-snapshot-store.ts:33` — `getFileSnapshotStore`
- `packages/coding-agent/src/edit/file-snapshot-store.ts:55` — `canonicalSnapshotKey`
- `packages/coding-agent/src/edit/file-snapshot-store.ts:79` — `recordFileSnapshot`（返回内容哈希 tag）
- `packages/hashline/src/snapshots.ts:114-116` — `record` 同内容复用 tag（幂等）
- `packages/coding-agent/src/tools/tool-result.ts:100` — `toolResult` builder

---

*文档结束。已实现并通过验证（typecheck + lint + 6 单测）。*
