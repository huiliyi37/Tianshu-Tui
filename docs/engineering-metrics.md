# 工程质量指标 · Engineering Metrics

> 数据截至 **2026-07-07**,基于开发仓库实测统计。所有数字均可用文末命令复现。
> Data as of **2026-07-07**, measured on the development repository. All numbers are reproducible with the commands at the bottom.

## 核心指标 · Key Metrics

| 指标 Metric | 数值 Value |
|------|------|
| TUI 源码(TypeScript,不含测试) | **770 文件 / 159,328 行** |
| TUI 测试代码 | **922 文件 / 152,365 行** |
| 测试用例总数(node:test) | **10,117**(全量套件绿,2026-07-07 实测) |
| 测试 : 源码 行数比 | **≈ 0.96 : 1** |
| 桌面端源码(React + Tauri) | 132 文件 / 29,073 行(另有 28 个测试文件 / 3,248 行) |
| 运行时 Hook 模块(`src/agent/hooks/`) | 54 个 |
| 内置工具模块(`src/tools/`) | 100+ 个 |
| 类型检查 | `tsc --noEmit` strict + `noUncheckedIndexedAccess`,零错误 |

## 为什么这些数字重要 · Why It Matters

**测试纪律接近 1:1。** 编码 agent 的核心逻辑(多轮循环、工具流水线、上下文压缩)以难测著称,开源 agent 项目普遍测试覆盖很薄。本项目 15.2 万行测试对 15.9 万行源码,10,117 个用例覆盖 agent 循环、runtime hook 流水线、前缀缓存字节稳定性、压缩边界、工具执行、TUI 渲染引擎等全部核心路径——每一条 changelog 里的事故修复都带回归测试。

**Nearly 1:1 test-to-source ratio.** Agent core logic (multi-turn loops, tool pipelines, context compaction) is notoriously hard to test, and most open-source agents ship with thin coverage. This project pairs 152k lines of tests with 159k lines of source — 10,117 cases covering the agent loop, runtime-hook pipeline, prefix-cache byte stability, compaction boundaries, tool execution, and the ANSI rendering engine. Every incident documented in the changelog ships with a regression test.

**前缀缓存是被工程化的成本指标。** DeepSeek V4 对缓存未命中按命中的至多 50 倍计费。本项目把「前缀缓存命中率」当作一级工程目标:冻结前缀、增量附录字节稳定、请求确定性序列化、压缩只在用户边界重写历史。长会话稳态命中率实测 95–99%,直接反映在 API 账单上。

**Prefix-cache hit rate is engineered as a first-class cost metric.** DeepSeek V4 bills cache misses at up to 50× the hit price. Frozen prefixes, byte-stable delta appendices, deterministic request serialization, and boundary-only history rewrites deliver a measured 95–99% steady-state hit rate on long sessions — visible directly on the API bill.

## 同类项目规模参考 · Ecosystem Context

> 以下为 2026 年 7 月上旬 GitHub 公开数据快照,仅供规模参考,会随时间变化。各项目定位不同,不构成能力对比。

| 项目 | Stars | 语言 | 许可 | 备注 |
|------|-------|------|------|------|
| opencode | ~183k | TypeScript | MIT | Anomaly 团队,460+ 贡献者,模型无关 |
| Claude Code | ~137k | 闭源核心 | 闭源 | Anthropic 官方,仓库为插件/文档 |
| Codex CLI | ~95k | Rust | Apache-2.0 | OpenAI 官方,~70 crate 工作区 |
| Cline | ~62k | TypeScript | 开源 | VS Code 扩展,500 万+ 安装 |
| aider | ~46k | Python | Apache-2.0 | 个人项目,680 万+ pip 安装 |
| **天枢 Tianshu** | 早期 | TypeScript | Apache-2.0 | 个人项目,DeepSeek 前缀缓存深度优化 |

天枢在社区规模上是早期项目;上表想说明的是另一件事:**在工程纪律维度(测试:源码 ≈ 1:1、事故驱动的回归测试文化、字节级缓存稳定性工程),本项目对标的是第一梯队标准,而非早期项目的常见水位。**

## 复现方法 · How to Reproduce

测试套件随源码公开(2026-07-07 起),在仓库根目录即可执行:

```bash
# 测试用例总数(约 6 分钟,输出末尾的 "tests" 行)
npm test

# 源码 / 测试行数统计
git ls-files 'src/**/*.ts' | grep -v '__tests__\|\.test\.ts' | xargs wc -l | tail -1
git ls-files 'src/**/*.test.ts' | xargs wc -l | tail -1

# 类型检查
npm run typecheck

# 前缀缓存命中率实测(需 DEEPSEEK_API_KEY)
npm exec -- tsx scripts/verify-cache-hit-rate.ts
```
