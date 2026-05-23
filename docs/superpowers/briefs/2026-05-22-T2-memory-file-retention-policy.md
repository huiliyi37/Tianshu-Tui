# T2 · 记忆文件保全策略 / Memory File Retention Policy

> 2026-05-22
> T2 文档：解释 `.rivet/artifacts/`、`.rivet/sessions/`、`.rivet/knowledge/` 等运行态/记忆态文件的保全边界。它们默认不进业务 commit，但绝不能被当作垃圾直接删除。

---

## 核心公理

忽略不等于删除。

`.gitignore` 的作用是防止运行态文件污染业务提交；不是宣告这些文件没有价值。

许多关键认知在被提升前，只存在于 session、artifact、knowledge、archive 中。直接清除会造成事实、复盘、模型自述、交接、失败模式和用户关键语义的不可恢复损失。

---

## 文件类别

| 路径 | 性质 | 默认是否提交 | 清理前要求 |
|---|---|---:|---|
| `.rivet/artifacts/` | 工具原始输出、raw logs、grep/test/bash 证据 | 否 | 检查是否有未提升的验证证据或失败记录 |
| `.rivet/sessions/` | 会话记录、handoff、retro、模型自述原始材料 | 否 | 检查是否有身份碑文、交接计划、复盘事实 |
| `.rivet/knowledge/` | 跨会话知识、项目记忆、提示词记忆 | 视情况 | 重要内容应提升到 docs/superpowers |
| `.rivet/playbook.jsonl` | 经验/教训条目 | 视情况 | 避免混入无关任务；可单独知识提交 |
| `docs/archive/.../knowledge/` | 历史运行态快照 | 是/视情况 | 作为证据库，不常驻上下文 |
| `docs/superpowers/briefs/` | 可迁移简报 | 是 | 优先读，不替代原始证据 |
| `docs/superpowers/specs/` / `plans/` / `analysis/` | 长期 canonical memory | 是 | 作为提升后的长期记忆 |

---

## 提升路径

运行态内容如果有价值，应走提升流程：

```text
artifact/session/knowledge 原始材料
  → analysis / retrospective 事实沉积
  → T1/T2 brief 提炼高频公理
  → spec/plan 固化设计或实施路径
  → 原始材料可归档或清理
```

不要把原始 artifacts 全部提交；也不要在没有提升前删除。

---

## 清理前检查清单

清理 `.rivet/artifacts/` 或 `.rivet/sessions/` 前，至少确认：

1. 是否包含用户关键语录？
2. 是否包含模型自述、星名选择、身份碑文？
3. 是否包含失败模式或退行事件？
4. 是否包含交接计划、handoff、下一步？
5. 是否包含测试失败、验证结果、raw evidence？
6. 是否已有对应 `docs/superpowers/analysis` 或 `briefs` 提升版本？
7. 是否有同伴仍在使用这些文件？
8. 是否只是运行噪声，还是未来 agent 的证据？

任一问题不确定，默认保留，不删除。

---

## 与上下文重量的关系

保全文件不等于把它们塞进 prompt。

稳定态信息架构：

```text
上下文 = 协议层，像 CPU cache
artifacts = 原始证据层
knowledge = 工作记忆/跨会话知识层
docs/superpowers = 提升后的长期记忆层
```

读取策略：

- 普通任务不读 artifacts。
- 需要证据时读 artifacts。
- 需要接续时读 briefs。
- 需要深设计时读 specs/plans。
- 需要追溯原因时读 analysis / archive。

---

## Git 规则

`.gitignore` 中忽略：

```gitignore
.rivet/artifacts/
.rivet/sessions/
```

含义：

- 防止 raw outputs 和 session dumps 自动污染提交。
- 不代表这些目录可随意删除。
- 若某分支已跟踪这些路径，应使用 `git rm --cached` 清出版本库，而不是删除本地唯一副本。

---

## 何时可以删除

只有同时满足：

1. 已确认没有未提升的关键认知；
2. 有价值内容已提升到 docs / briefs / specs / analysis；
3. 当前任务和同伴不再依赖；
4. 删除不会影响可追溯验证；
5. 最好有备份或归档。

才可以清理。

---

## 失败模式

### A. 把 ignore 当 rm 许可

看到 `.gitignore` 后直接清空 `.rivet/sessions/`，导致会话复盘和模型自述丢失。

### B. 把 raw artifact 当业务 commit

把数百个 `.raw` 文件提交进迁移分支，污染历史。

### C. 只保留 brief，丢失证据

brief 提炼了结论，但没有原始证据可追溯，后续 agent 无法审查结论来源。

### D. 只保留 raw，缺少提升

artifact 太多，后续 agent 读不动，等于事实不可用。

稳定态需要在 B 和 C/D 之间保持平衡。

---

## 最短规则

```text
不自动提交。
不直接删除。
先筛选。
再提升。
后清理。
```

