# 2026-07-07 — 投机预执行链整链封存 + 陈旧读残留补口

## 背景

2026-07-06 陈旧读事故（见 `2026-07-06-disable-speculative-serving.md`）切断了
ShadowQueue → 模型的服务路径，但保留了后台预执行链做影子遥测，理由是
「继续产出命中率数据供重启决策」。复盘一天后定论：**重启前提（ShadowQueue
记 mtime + checkHit 现场 stat）无论命中率数据长什么样都必须做**，影子数据
不改变任何决策，预执行是纯耗资源（每次工具启动跑 miner 预测 + 后台真实
read_file/grep），遂整链封存。

## 处置

**封存范围（SEALED，模块与单测保留，生产路径全部惰性）：**

- `p3-integration.ts`：`P3Config.speculativeEnabled` 从死字段接活为主开关，
  默认 off。`onToolStart` 不再触发 IdleSpec 预执行；
  `enqueuePhysarumFilePredictions` / `enqueueLlmPredictions` /
  `checkSpeculativeCache` 未开启时直接 no-op。miner 仍记录工具序列
  （内存计数，零 IO）。
- `loop.ts`：不再向 `createP3Integration` 传 execute 回调——即使意外入队，
  也没有任何文件系统读取能力（结构性消除陈旧读隐患）。
- `tool-pipeline.ts`：删除遥测残留的 `checkSpeculativeCache` 调用。
- `loop-factory.ts`：physarum 文件预测只喂 prewarm（消费时 mtime+size 双验），
  不再入队 ShadowQueue；LLM speculation 引擎不再构造——服务已切断，
  opt-in 用户白烧侧路 LLM 调用。`config.agent.llmSpeculation` 保留可解析
  但标注 INERT。
- postSession 的 `speculationStats` / `llmSpeculationEngine` meta 写入路径
  保留 `?.` 守卫，永远无活动即永远不写。

**同批陈旧读残留补口：**

- `prewarm-file.ts`：`consumePrewarm` 从只验 mtime 升级为 mtime+size 双信号
  （对齐 read-dedup），防粗粒度 mtime 文件系统（exFAT 2s 窗口内编辑）。
- `read-file.ts`：read-dedup repeatWarning 文案去掉「回看上文结果即可」——
  历史 tool_result 可能已被压缩/修剪，该指引曾诱发回看无果→再读循环；
  改为指向随附的本次全文。

## 重新启用契约

见 `P3Config.speculativeEnabled` 的 doc comment：ShadowQueue 条目记录投机时
mtime，`checkHit` 现场 re-stat 比对，`recordSuccessfulEdit` 接入失效钩子。
满足前不得重新构造 LLM speculation 引擎或打开 speculativeEnabled。

## 关联

- 前情：`2026-07-06-disable-speculative-serving.md`（服务路径切除）
- 同期：`2026-07-06-llm-speculation-suffix-double-append.md`（spec 侧路缓存污染）
