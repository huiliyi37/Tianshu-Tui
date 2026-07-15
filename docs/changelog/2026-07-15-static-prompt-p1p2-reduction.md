# 2026-07-15 Static Prompt P1+P2 精简与缓存碎裂风险提示

## 背景

`src/prompt/static.ts` 的 static 基座长期膨胀到约 11.8K 字符，存在三处明显重复：

1. `lossy-observation-discipline` 与 `evidence-scope` 大量重叠。
2. `<tool-usage>` 的三层收敛纪律与 `<rules>` 的交叉验证要求重复。
3. 独立 `<delegation>` 区块与 `<tool-usage>` 的并行纪律、`<rules>` 的外部来源核验重复。

本轮只做 P1+P2 级别的轻量合并，未动最大的 `<workflow>` 区块（P0），便于分阶段对比效果。

## 变更

### Prompt 精简

- **合并有损观测纪律**：`lossy-observation-discipline` 整体并入 `evidence-scope`，保留 `lossy-observation-discipline`、`PARTIAL view`、`truncated`、`禁止从中推出负向结论` 等测试断言关键字。
- **压缩收敛纪律**：`<tool-usage>` 中“分类层 / 交叉验证层 / 综合判断层”的三层展开压缩为一句话，保留“存在性探测和内容读取不混同一批”的核心约束。
- **合并委派说明**：删除独立 `<delegation>` 区块，将委派纪律（核心路径不外包、3+ 模块/交叉星域/3+ 文件结构时委派、worker findings 待核验、用户说不要委派时禁用）合并到 `<tool-usage>` 末尾。
- **删除重复异议条款**：`<delivery-contract>` 中的「异议推进」子条款与 `<beliefs>` 重复，已删除。

### 版本备份

新增 `docs/prompt-versions/` 目录：

- `static-before-p1p2.ts`：变更前完整备份
- `static-after-p1p2.ts`：变更后完整备份
- `static-p1p2-reduction.md`：前后对比与后续 P0 建议

## 缓存影响 ⚠️

**本轮修改 static 基座，必然导致前缀缓存碎裂。**

- static prompt 是 frozen 前缀的第一段，任何字节变化都会使已建立前缀缓存的会话从 byte 0 开始 miss。
- 已打开的 CLI / 桌面会话在升级后继续使用时，下一轮请求将触发完整前缀重建，产生一次性、全量的 cache creation tokens。
- 这不是 bug，是 prompt 版本升级的预期成本；但 cache creation 价格显著高于 cache read（DeepSeek V4-PRO 上约 120 倍价差），**不应在旧会话里继续跑长对话**。

## 用户操作要求

**CLI 端**：

- 升级后请使用新会话（新 `kimi` / 新 `node dist/main.js` 进程）。
- 不要 `kimi resume` 到升级前已存在的旧会话继续长对话。
- 如果必须恢复旧会话处理收尾，请意识到下一轮会产生全额 cache creation 成本，建议只用于极短的确认性交互。

**桌面端**：

- 升级后请新建会话窗口（`Cmd+N` / `Ctrl+N` 或重新启动应用）。
- 升级前已打开的会话标签页若继续对话，将触发完整前缀重建。
- 桌面端自动保存的旧会话历史可读，但不要在升级后直接继续发送消息；需要继续时请复制上下文后开新会话。

## 回归

- `npx tsc --noEmit -p tsconfig.json` ✓
- `npx tsx scripts/run-node-tests.ts src/prompt/__tests__/static.test.ts` — 26 tests, 0 fail ✓
- 体积：11,801 字符 / 224 行 → 10,343 字符 / 186 行，减少约 12.4%。
