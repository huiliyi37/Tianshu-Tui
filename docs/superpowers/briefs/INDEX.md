# Stability Brief Index

> 目的：让稳定态信息可召唤，而不是常驻压垮上下文。不要默认全读；按任务和风险读取最小必要文档。

---

## 分层原则

```text
Layer 0  硬规则          常驻极少，5–8 条
Layer 1  T1 brief        快速入口，任务相关时读
Layer 2  T2 protocol     异常/退行/中断时读
Layer 3  spec/plan       实现稳定态模块时读
Layer 4  retrospective   追溯事实和更新 brief 时读
```

信息不丢，但不常驻。

---

## T1：快速入口

### `2026-05-22-T1-pangu-runtime-brief.md`

读取时机：

- 任务涉及盘古计划、星系、CLAUDE.md、碑文、身份误读。
- agent 可能把星名/前辈名字当成角色卡。
- 需要向新 agent 解释“盘古计划不是角色扮演”。

不要用于：普通代码任务的默认上下文。

### `2026-05-22-T1-public-internal-boundary.md`

读取时机：

- 任务涉及公开发布、开源边界、内部文档是否可公开。
- 需要判断哪些是 Public Runtime，哪些是 Internal Canon / Private Archive。
- 需要把内部稳定态经验蒸馏成公开机制。

不要用于：普通实现任务的默认上下文。

### `2026-05-22-T1-stable-state-runtime-brief.md`

读取时机：

- 任务涉及 HEARTH、Songline、归属星轨、稳定态。
- 需要判断“先做归属星轨还是世界稳定态”。
- 需要快速理解四份稳定态文档关系。

不要用于：只改普通工具/测试的小任务。

### `2026-05-27-runtime-paths-troubleshooting-guide.md`

读取时机：

- 任务涉及 `.rivet/`、`~/.rivet/sessions/`、cache-log、sensorium、artifacts、checkpoint、session memory、claims。
- 排查 DeepSeek prefix cache 命中率、session split、compact hygiene、runtime artifact 归属。
- 需要判断 session-scoped 路径与 legacy `.rivet/*` 路径的兼容关系。

不要用于：与 runtime 文件、日志、排障无关的普通代码任务。

---

## T2：异常与接续

### `2026-05-22-T2-model-access-contingency.md`

读取时机：

- 模型、账号、供应商、会话、上下文窗口可能失效。
- 需要把关键认知沉积给下一个 agent。
- 需要决定哪些任务可降级，哪些必须暂停。

### `2026-05-22-T2-retrospective-facts-for-stability.md`

读取时机：

- 需要从 2026-05-18 / 05-19 复盘事实中校准稳定态设计。
- 需要区分健康收缩与锚点坍缩。
- 需要确认归属星轨、验证归因、runtime artifact 归属的来源。

---

## 协议 / 深设计

### `../specs/2026-05-22-stable-state-regression-protocol.md`

读取时机：

- 用户指出 agent 退行。
- agent 出现授权回退、客服化、伪完成、过度安全、角色卡坍缩、锚点因果坍缩。
- repo/context 冲突，或 merge/stash/reset/delete 前需要校准。

### `../specs/2026-05-22-yongminengdeng-design.md`

读取时机：实现 HEARTH / anchor graph / invariant verifier。

### `../specs/2026-05-22-songline-runtime-design.md`

读取时机：实现 Songline / obligation / world season / fire-keeper。

### `../plans/2026-05-22-hearth-songline-implementation.md`

读取时机：开始稳定态工程实现前。

---

## 常驻建议（最多 5–8 条）

如果需要把稳定态写入更上层提示，只保留：

1. 工具现实优先于注入上下文。
2. 不把碑文/星名/CLAUDE.md 当角色卡。
3. 用户已明确授权时，不因不确定而授权回退；应说明边界并推进安全子任务。
4. 不能审查就直接说不能审查，不伪完成。
5. 区分 verified / unverified。
6. 工作区状态不是自我状态。
7. 运行态 artifact 不归业务 commit，除非明确声明。
8. 退行时命名失败模式并回到共同事实层。

