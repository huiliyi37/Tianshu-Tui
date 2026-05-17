# 项目记忆系统：深度头脑风暴过程

> **日期：** 2026-05-17
> **背景：** 天枢星图流 XML 记忆闭环方案 的可行性和适配性分析
> **方法：** deep-brainstorm（三轮变异-选择-适应 + 并行调研）
> **关键词：** 项目级知识库、跨 session 记忆、claim store 扩展

---

## 1. 调研发现

### 天枢星图方案要点

方案来自 `/Users/banxia/Downloads/天枢星图流_XML记忆闭环设计方案.md`，核心架构：

```
User Task → 星门初启 → 紫微请星 → 天枢授策 → ... → 摇光归航
  → 天府藏卷 → Project StarMap XML Knowledge Base → Future Retrieval
```

提出 `.starmap/` 目录结构、XML 协议（planning_result.xml、completion_summary.xml 等）、tag+向量检索、Asset Extractor。

### Rivet 现有基础设施

#### 可直接复用的能力

| 能力 | 位置 | 说明 |
|------|------|------|
| Event-sourced claim store | `src/context/claim-store.ts` | JSONL event log + projection，已支持 durability promotion |
| 跨 session claim 加载 | `src/agent/session-persist.ts:149-160` | `loadPreviousDurableClaims()` + `injectDurableClaims()` |
| 知识提取器 | `src/context/claim-extractor.ts` | tool result → claim（read_file→file_observation 等） |
| XML prompt 注入 | `src/prompt/volatile.ts` | `<active-claims>`, `<session-memory>`, `<cerebellar-hint>` |
| repo_map 工具 | `src/tools/repo-map.ts` | 项目文件树注释 |
| import-graph | `src/repo/import-graph.ts` | 文件依赖关系图 |
| symbol-index | `src/repo/symbol-index.ts` | 符号级索引 |
| 文件知识库模式 | `.wolf/cerebrum.md` | 已存在的文件式 KB 先例 |
| 项目规则 | `src/context/rules-loader.ts` | `.rivet/rules/*.md` → durable claims |
| 召回工具 | `src/tools/recall.ts` | 关键词 claim 检索 |
| Claim promotion | `src/context/promotion.ts` | active→durable_candidate→durable 生命周期 |

#### 缺失能力

| 能力 | 影响 |
|------|------|
| 跨 session durable claims 衰减 0.9 | 重启后知识强度下降 |
| 无 scope: 'project' 级别 claim | claims 随 session evict |
| 无 tag-based 排序检索 | 检索无相关性排序 |
| 无向量检索 | 仅关键词匹配 |
| 无自动 task-level 资产提炼 | claim extractor 仅 tool-level |

### 竞品参考

| 工具 | 方案 | 对比 |
|------|------|------|
| Aider | 递归 head-tail split + PageRank repo map | Rivet 的 repo_map 是树遍历非 PageRank |
| Claude Code | `~/.claude/projects/.../memory/` 文件式 KB | 外部存储，不注入运行时 |
| OpenWolf | `.wolf/` 文件 + hooks 自动维护 | 证明文件式知识库在本项目中可行 |

---

## 2. 三轮思考

### 第一轮：变异

| 方案 | 生态位 | 核心选择 |
|------|--------|---------|
| V1(文件XML) | 按天枢方案建 `.starmap/` | 模型在归航阶段写 XML，启动时读 index.xml 注入 |
| V2(扩展claim) | 扩展现有 claim store | 新增 project scope claim，跨 session 持久化 |
| V3(混合) | claims 做运行时 + XML 做持久 | 两套系统同步 |
| V4(零新增) | 只改 prompt 不做存储 | 归航时追加到 `.rivet.md` |

### 第二轮：选择

**灭绝：**
- **V4** — 因果链断裂。追加到 `.rivet.md` 后无法结构化检索，无法区分新旧知识
- **V3** — 成本收益比失衡。两套系统同步是 V2 的 3 倍成本

**存活：** V1（中）、V2（强）

**discarded_trait 回收：**
- V4 的"零新增基础设施" → 吸收到 V2：prompt 改动极小
- V1 的"XML 文件可见" → 吸收到 V2：加 `exportClaimsAsXML()` 按需导出
- V3 的"asset extractor" → 推迟到后续阶段

**收敛后的方案：V2-enhanced**
- 运行时用 claim store（现有架构）
- 跨 session 通过 durable claims（不衰减）
- 可选导出 XML 做文件存档
- 不强制使用 `.starmap/` 目录

### 第三轮：适应

**最终方案三阶段：**

| Phase | 改动 | 时间 |
|-------|------|------|
| Phase 1 | turn-end 自动提取 project_fact claim + 跨 session 不衰减 | ~3 天 |
| Phase 2 | tag-based 检索 + scope: 'project' 级别 claim | ~5 天 |
| Phase 3 | 高频 claims 导出为 `.rivet/knowledge/` markdown | ~3 天 |

**最强适应点：** 复用现有 claim-store、promotion、extractor、session-persist — 没有新架构，没有新依赖

**脆弱点：** claims 目前 session 级别，evict 时丢失。应对：新增 scope: 'project' 级别存储到独立 JSONL

---

## 2.5 Scout 4 反证：隐含前提审计

| 假设 | 性质 | 防线 |
|------|------|------|
| 跨 session 同义 claim 可安全合并 | **假设** | 按 text hash 去重（非 claim id），50 session 不产生 50 条重复 |
| 启发式提取能产生模型可理解的文本 | **假设** | 自然语言摘要（"Modified N files on X, tests passed"）而非模板化拼接 |
| 无衰减时旧 claim 不会污染 prompt | **假设** | 增量衰减：每 session gap 衰减 0.05（非旧的 *0.9），50 session 后最低 0.5 |

---

## 3. 与天枢方案的分歧

| 维度 | 天枢方案 | 本方案(V2-enhanced) | 理由 |
|------|----------|-------------------|------|
| 存储格式 | XML | JSONL(运行时) + 可选XML(导出) | JSONL 事件源更适合运行时投影 |
| 目录 | `.starmap/` | `.rivet/knowledge/` (Phase 3) | 与现有 `.rivet/` 一致 |
| 检索 | tag + 向量 | tag + import-graph + 使用次数 | 向量对中小项目非必须 |
| 资产提炼 | 独立 AssetExtractor | 扩展现有 claim-extractor | 零新文件 |
| 知识来源 | 归航阶段模型写 XML | turn-end 自动提取 + model writes | 更细粒度，不依赖模型范式 |
