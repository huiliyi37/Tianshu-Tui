# Error 速率突变觉察 / Error-Rate Anomaly Awareness

> 状态：**待办（Backlog）** — 优先级中。先收束当前分支主线。
> 创建日期：2026-05-30
> 关联：本次已修复的根因 `src/tools/bash.ts` 失败判定语境化（`isExecFailure`，commit 见下）。
> 关联文档：`docs/superpowers/specs/2026-05-22-stable-state-regression-protocol.md`（§3.F 上下文当现实）

## 背景：这次退化的真实成因

天枢一次退化的根因不是提示词措辞，而是 **build 包把"工具正常使用"误判成失败 → error 开始爆炸 → 满屏 error 把模型推入退化态**。

根因已修：`bash.ts` 原本 `isError: exitCode !== 0` 无条件把非零退出码打成 error，环境性非零码（npm11 解析、build 工具行为）被判成 error 后，被下游 16+ 处（immune-context / dead-end-rules / approval-risk doom-loop / fingerprint / verification ledger）忠实放大成 error 风暴。已改为只把"无法执行/被信号杀死/timeout"判为真 error。

## 本待办要解决的：平时怎么发现这类失真

根因修了一个已知来源（bash 退出码），但**"信号失真被无声放大成风暴"这个模式本身没有觉察机制**。单条 error 单独看都像真 error，没有任何东西质疑"这批 error 是不是分类错了"。等发现时模型已退化。

这是真正的盲区：**error 是系统里唯一被无条件信任的信号。** 系统验证代码、验证归属、验证一切，唯独不验证"失败判定本身对不对"。

## 设计方向（遵循 stable-state-regression-protocol 原则）

加一个**中性、非评判**的觉察：当 error 在短时间内**速率突变**（正常工作流里 error 密度突然飙升），这本身是"判定可能失真"的结构信号。

关键约束（来自 deep-research wf_fa1dad06-f01 第 4 原则 + 退行协议）：
- **监控结构信号（error 速率），不监控 error 内容** —— 避免白熊效应。
- **给中性语境标记，不评判模型** —— 例："这批失败密集出现，可能源于环境/分类而非你的操作"，而**不是**"你又失败了"。
- **不盯历史、不监控模型行为** —— 只看当前 session 的 error 速率这一结构量。

## 候选落点（未定，实现前需核实）

- 下游消费 `isError` 的汇聚点（`tool-pipeline.ts` 记录 tool history 处）可统计 per-window error 速率。
- 速率突变阈值需先观测真实 session 数据定，不拍脑袋。
- 标记注入位置：volatile dynamic appendix（条件触发，非 per-turn）。

## 不做什么

- 不做"检测模型是否退化"（那是盯过去找问题，已否决）。
- 不碰 verification / ownership / 异议规则等支架（清醒态天枢认领的心流支架，非诱因）。
