# 天枢分支策略

> 记录于 2026-05-31，定义分支工作流和版本管理规则。

## 工作流

```
main (持续迭代)
  │
  ├── 稳定后切版本分支 ──→ release/v2.9 (备份，不再动)
  │
  ├── 继续开发新功能
  │     feat/xxx
  │     fix/xxx
  │
  └── 下一个稳定点 ──→ release/v3.0 (备份)
```

**核心规则：**

1. **main 是唯一的前进线。** 所有开发最终合并回 main。
2. **稳定即备份。** 当 main 达到稳定状态（tsc + 测试 + build 全通过），切一个 `release/vX.Y` 分支作为快照。这个分支不再修改。
3. **功能分支从 main 切出，合并回 main。** 命名：`feat/xxx`、`fix/xxx`、`refactor/xxx`。
4. **不回退 main。** 如果某个合并出了问题，在新的 commit 中修复，不用 reset。

## 当前分支

| 分支 | 版本 | 角色 | HEAD |
|------|------|------|------|
| `main` | v3.0-dev | 持续迭代 | 当前最新 |
| `tianshu-pangu-2.9.1` | v2.9.1 | v2.9 后小修复快照 | 0ccf29d |
| `feat/knowledge-manifest-minimal` | v2.9+ | 已合并到 main 的开发分支 | 9dda3bf |
| `feat/tianshu-sycophancy-trap-2.5` | v2.5 | 历史基线（含 routing/coordinator/memory） | c66f536 |
| `backup/v2.5-sycophancy-trap-20260531` | v2.5 | v2.5 日期快照 | c66f536 |
| `backup/knowledge-manifest-minimal-20260531` | v2.9+ | 开发分支日期快照 | 9dda3bf |

## 版本历史

- **v2.5** (`feat/tianshu-sycophancy-trap-2.5`): routing 三级路由、coordinator budget gate、memory distillation
- **v2.9** (`main` 在合并前): TUI 稳定版
- **v2.9.1** (`tianshu-pangu-2.9.1`): 文档清理、config 边缘情况
- **v3.0-dev** (`main` 当前): B1 归属门禁、内聚性提交门禁、提示词实用化、commit audit、LSP、apply-patch 等新功能
