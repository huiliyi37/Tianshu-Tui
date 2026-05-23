T1 · 体验问题沉积：2026-05-23 会话复盘

日期：2026-05-23
来源：worktree-reality-contract 实现后的 session 回顾

## 已验证事实

### F1. tool-history 已有滚动窗口
代码位置：`src/agent/loop.ts:445`
```typescript
if (this.recentToolHistory.length > 5) this.recentToolHistory.shift()
```
结论：tool-history 不会无限增长，只保留最近 5 条。上下文压力来源不是 tool-history 累积，而是多动态块（git-status + tool-history + session-state + cross-session-events）叠加。

### F2. read_section artifact 读取偶发不稳定
这是运行时工具链限制，不是代码 bug。Workaround：`sed -n 'X,Yp' file` + `tail -N file` 替代 `read_section`。不改代码。

### F3. 全量测试 suite 耗时长
`tsx --test 'src/**/__tests__/*.test.ts'` 全量跑需 120s+。startup-memory 测试在全局模式下因 RSS 200MB 超限失败（已有问题，非本次引入）。本地开发时用单文件 `tsx --test path/to/test.ts` 足够。

## 流程约束（建议写入 playbook）

### P1. 改动后先跑单文件测试
在修改任何实现代码后，立即跑对应的单文件测试确认方向正确，避免"改断言→跑→失败→改断言"的振荡循环。
```bash
./node_modules/.bin/tsx --test src/agent/__tests__/worktree-reality.test.ts
```
确认通过后再跑 typecheck，最后跑全量。

### P2. bash 长输出写文件而非依赖 artifact
当命令输出超过 ~50 行时，重定向到临时文件，用 `read_file` 读，避免 artifact 引用丢失。
```bash
./node_modules/.bin/tsx --test src/agent/__tests__/xxx.test.ts > /tmp/test-output.txt 2>&1
```

## 不改代码的原因

这 4 个问题本质是运行时体验和流程纪律，不是代码缺陷。强行改代码（比如拆 fast/slow 测试层）收益低于稳定态迭代本身的优先级。
