# 工程质量指标 · Engineering Metrics

> 数据截至 **2026-07-15**，基于开发仓库 `git ls-files` + `wc -l` 实测。所有数字均可用文末命令复现。
> Data as of **2026-07-15**, measured on the development repository. All numbers are reproducible with the commands at the bottom.

## 核心指标 · Key Metrics

| 指标 Metric | 数值 Value |
|------|------|
| 版本 Version | **2.19.3**（`package.json`） |
| TUI 源码 (TypeScript, 不含测试) | **825 文件 / 173,374 行** |
| TUI 测试代码 | **995 文件 / 165,553 行** |
| 测试 : 源码 行数比 | **≈ 0.95 : 1** |
| 桌面端源码 (React + Tauri) | **154 文件 / 34,601 行**（另有约 39 个测试文件 / 4,649 行） |
| 运行时 Hook 模块 (`src/agent/hooks/*.ts`) | **62** |
| 内置工具模块 (`src/tools/`, 含子目录) | **100+**（kernel 注册 ≤26；其余 EXTENDED / 装配注入） |
| 星域 | **11**（`src/agent/star-domain.ts`） |
| 类型检查 | `tsc --noEmit` strict + `noUncheckedIndexedAccess` |

> 测试用例总数随套件演进；以 `npm test` 末尾 `tests` 行为准。README badge「10,000+」为数量级声明，非单次锁死数字。

## 为什么这些数字重要 · Why It Matters

**测试纪律接近 1:1。** 编码 agent 的核心逻辑（多轮循环、工具流水线、上下文压缩）以难测著称，开源 agent 项目普遍测试覆盖很薄。本项目测试与源码近等量，覆盖 agent 循环、runtime hook 流水线、前缀缓存字节稳定性、压缩边界、工具执行、TUI 渲染引擎等核心路径——changelog 里的事故修复通常带回归测试。

**Nearly 1:1 test-to-source ratio.** Agent core logic is notoriously hard to test. This project pairs ~166k lines of tests with ~173k lines of TUI source, covering the agent loop, runtime-hook pipeline, prefix-cache byte stability, compaction boundaries, tool execution, and the ANSI rendering engine.

**前缀缓存是被工程化的成本指标。** DeepSeek V4 对缓存未命中按命中的至多 50 倍计费。冻结前缀、增量附录字节稳定、请求确定性序列化、压缩只在用户边界重写历史。长会话稳态命中率实测 95–99%。

**Prefix-cache hit rate is engineered as a first-class cost metric.** Frozen prefixes, byte-stable delta appendices, deterministic request serialization, and boundary-only history rewrites deliver a measured 95–99% steady-state hit rate on long sessions.

## 同类项目规模参考 · Ecosystem Context

> 以下为 2026 年 7 月上旬 GitHub 公开数据快照，仅供规模参考，会随时间变化。各项目定位不同，不构成能力对比。

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

在仓库根目录执行:

```bash
# 测试用例总数（输出末尾的 tests 行）
npm test

# 源码 / 测试行数统计
git ls-files 'src/**/*.ts' 'src/**/*.tsx' | grep -v '__tests__\|\.test\.\|\.spec\.' | xargs wc -l | tail -1
git ls-files 'src/**/*.test.ts' 'src/**/__tests__/**' | xargs wc -l | tail -1

# 文件数
git ls-files 'src/**/*.ts' 'src/**/*.tsx' | grep -v '__tests__\|\.test\.\|\.spec\.' | wc -l
git ls-files 'src/**/*.test.ts' 'src/**/__tests__/**' | wc -l

# 桌面端
git ls-files 'desktop/**/*.ts' 'desktop/**/*.tsx' | grep -v '__tests__\|\.test\.' | xargs wc -l | tail -1

# Hook 模块数
ls src/agent/hooks/*.ts | grep -v '\.test\.' | wc -l

# 类型检查
npm run typecheck

# 前缀缓存命中率实测（需 DEEPSEEK_API_KEY）
npm exec -- tsx scripts/verify-cache-hit-rate.ts
```
