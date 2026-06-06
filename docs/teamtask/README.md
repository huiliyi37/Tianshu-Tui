# Team Task — 系统级收束工作

本目录存放**系统架构收束工作（团队级）**：跨子系统的架构梳理、信任链/链路复盘，以及由复盘导出的收束任务清单。

与其他 docs 目录的区别：
- `known-issues/` — 单点 bug / handoff，问题驱动
- `superpowers/specs/` — 改造前的设计 spec，前瞻驱动
- `tasks/` — 散落的单项任务
- **`teamtask/`（本目录）** — **系统级收束**：架构已落地后，做整体梳理 + 裂缝收口，阶段化推进

## 阶段标记

- **T1 收束** — 第一轮系统架构收束（2026-06-06 起）

## 文档索引

### T1 收束

| 文档 | 类型 | 内容 |
|------|------|------|
| [T1收束-子代理工具隔离信任链](./T1收束-子代理工具隔离信任链.md) | 架构 | 子代理工具隔离全链路 7 环 + 三不变量；`architecture-subagent.md` 的信任链专题补充 |
| [T1收束-子代理工具隔离优化任务](./T1收束-子代理工具隔离优化任务.md) | 任务 | 该链路 4 正确性裂缝 + 3 健壮性点，分级 + 取证 + 修法 |
| [T1收束-server任务系统锁与持久化收口](./T1收束-server任务系统锁与持久化收口.md) | 架构+任务 | server 层 cron-lock/task-store 零测试盲区；6 裂缝（脑裂/僵尸 scheduler 为首），取证 + 修法 |
| [T1收束-回合边界abort看门狗恢复链](./T1收束-回合边界abort看门狗恢复链.md) | 架构（正面） | 验证该链健全（看门狗有牙+全 boundary 包 rejectOnAbort+同信号 abort）；仅 1 残留竞态（晚到 LLM compact mutate session）；更正过时记忆 |
| [T1收束-context-claim持久化checkpoint死接线](./T1收束-context-claim持久化checkpoint死接线.md) | 架构+任务 | checkpoint/snapshot 整套机制造好测过却生产零调用→JSONL 无界增长 + 并行投影漂移 + 潜伏非幂等（接线即引爆）；最纯粹的"造好未集成"案例 |
