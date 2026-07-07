# 2026-07-06 — 投机执行结果停止服务给模型（陈旧读事故）

## 事故

TDX 用户会话（`写入工具故障报告.md` 后续完整数据包）中，`read_file` 返回了**三次编辑之前**的旧文件内容（25 行带 STICKLINE 版本），而磁盘上实际是 18 行新版本。模型据此推理「文件被回退了」，随后 `edit_file` old_string not found、`hash_edit` stale anchor 连锁失败，陷入重读-编辑-再重读风暴。用户感知为「文件回滚 + 写入工具全挂」。

## 根因

P3 投机执行链（ToolPatternMiner / physarum / LLM speculation → `ShadowQueue`）预执行 read-only 工具并缓存字符串结果。`tool-pipeline.ts` 的快路径按 `(tool, target)` 裸匹配直接把缓存端给模型：

- `ShadowQueue.checkHit` **没有任何新鲜度校验**——不记 mtime、无 TTL、无编辑失效钩子。
- 这绕过了 `read-file.ts` 里所有精心设计的 mtime/size 门（read-dedup、prewarm 都有校验，唯独这条路没有）。
- 同样的裸匹配也覆盖 `grep`/`glob`，误读不限于 read_file。

## 处置

**切断服务路径，保留影子遥测。**

- `tool-pipeline.ts`：删除 `speculativeHit` 快路径，所有工具永远走真实执行。`checkSpeculativeCache` 仍然调用，只为累计 `speculationStats` 的 would-be 命中率（影子测量，符合本仓库 shadow-first 惯例）。
- 后台预执行链（enqueue/execute）保持原样——成本是每会话十几次本地读，无正确性风险，且继续产出命中率数据。
- `p3-integration.ts` / `llm-speculation.ts` 头注释标注事故与重启前提。

## 重新启用前提

`ShadowQueue` 条目必须记录投机时的 `mtimeMs`，`checkHit` 现场 `stat` 比对；且 `recordSuccessfulEdit` 需接入失效钩子。在此之前不得恢复服务路径。

## 关联

- 同批修复：pointer-guard 三工具接入、`hash_edit` stale 诊断改进、MistakeNotebook anchors 消毒（见同日提交）。
- 遗留（未修）：read-ref 指回的历史消息若已被压缩/指针化，应重发全文而非只给引用。
- **后续（2026-07-07）**：影子遥测观察一日后整链封存——后台预执行、physarum/LLM 入队、
  遥测调用点全部惰性化，见 `2026-07-07-speculative-chain-seal.md`。read-ref 遗留项
  已由同日「read-ref 压缩失效三层修复」处理。
