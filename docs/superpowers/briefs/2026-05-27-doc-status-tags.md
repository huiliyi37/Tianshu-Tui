# 文档状态标签规范

> **Status**: accepted

## 目的

文档必须区分 proposed、accepted、implemented、verified、blocked、superseded，避免"建议已被看见"被误读为"建议已经落地"。

## 允许状态

| 状态 | 含义 |
|------|------|
| proposed | 提案已写出，但未被采纳 |
| accepted | 方向已采纳，尚未完成实现 |
| implemented | 代码或文档改动已落地 |
| verified | 已运行对应验证命令且通过 |
| blocked | 被明确阻塞，文档中必须写明阻塞原因 |
| superseded | 已被另一份文档或实现取代，必须写明替代来源 |

## 推荐写法

```md
> **Status**: implemented / verified
```

多个状态按生命周期叠加，使用 `/` 分隔。状态行应放在文档头部（标题和日期之后、正文之前）。

## 适用目录

- `docs/analysis/` — 分析文档
- `docs/superpowers/plans/` — 实现计划
- `docs/superpowers/specs/` — 设计规格
- `docs/superpowers/briefs/` — 契约文档
- `docs/superpowers/reports/` — 执行报告
- `docs/superpowers/status/` — 进展报告

## 解析规则

解析器 `src/docs/doc-status.ts` 只识别 `> **Status**:` 开头的行，状态用 `/` 分隔。文档中不存在此标签时返回 `missing-status`。
