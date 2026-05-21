# 启动内存优化 — Deep Brainstorm 设计文档

> **日期**：2026-05-21
> **方法**：Deep Brainstorm（6 scout + 定向反证 + 3 轮演化）
> **调研范围**：V8 堆快照 · 游戏引擎资产流式加载 · 生物休眠与快速激活 · 嵌入式 RTOS 启动 · 进程 fork 预热 · 替代运行时

---

## 背景

Rivet 启动占用 ~135MB RSS / 548ms。内存分解：

| 组件 | RSS (MB) | 可延迟 |
|------|----------|--------|
| Node.js 裸机 | ~40 | 不可压缩 |
| Ink + React | ~52 | 启动必须 |
| MCP SDK | ~24 | ✓ |
| better-sqlite3 | ~6 | ✓ |
| turndown | ~2 | ✓ |
| Rivet 业务代码 | ~11 | 部分 |

## Scout 调研汇总

### Scout 1: V8 Heap Snapshots
- Electron 实验：81% require() 缩减（215ms→41ms）
- **限制**：Native addon（better-sqlite3）、Ink（触碰 process/stdout）、MCP SDK（net/http）大部分不可快照化
- **结论**：低 ROI，不适合 Rivet 的依赖组合

### Scout 2: 游戏引擎资产流式加载
- **Stub-and-Swap**（Unreal LOD）：启动时加载轻量 Proxy stub，首次使用时替换为真实模块
- **Demand-Paged Bundles**（id Software 虚拟纹理）：page table + 按需读取 bundle 片段
- **Command Subgraph Bootstrap**（UE5 World Partition）：构建期计算每个入口点的最小依赖子图

### Scout 3: 生物休眠与快速激活
- **Spore Boot**（芽孢两阶段）：Stage I 结构恢复（<50ms），Stage II 后台代谢恢复
- **Embryo Kernel**（种子预成型）：最小入口只包含路由逻辑，延迟加载完整功能
- **Vitrified Config**（水熊虫玻璃化）：退出时序列化配置，启动时 JSON.parse 恢复

### Scout 4: 嵌入式 RTOS 启动
- **XIP → 动态 import**：冷模块不进入 V8 heap，按需加载
- **三级 Boot**：Stage 1(TUI ~5MB) → Stage 2(config/auth) → Stage 3(agent)
- **Hot/Cold 分区 + 构建时 lint**：CI 禁止 hot 模块静态 import cold 模块
- **Buffer 预分配**：减少 GC 压力

### Scout 5: 进程 fork 预热
- **Chrome Zygote**：fork 前初始化，COW 共享内存（~8MB + 60ms 节省）
- **Daemon + Unix Socket**：130μs IPC 往返，消灭冷启动
- **关键风险**：fork() 必须在 libuv 线程池启动前，macOS Mach port 不兼容

### Scout 6: 替代运行时
- **Bun**：内存数据矛盾（有报告 -55%，也有 +75%），Ink 未验证
- **node --jitless**：边际收益，零风险
- **Deno/Hermes/GraalJS**：均不适用
- **结论**：无可靠 step-function 改进

### Scout 7: 定向反证（最高价值）
1. **App.tsx 是单体**：40+ import 耦合 TUI 和 agent，无法简单拆分 Stage 1/2
2. **AgentLoop 构造器有 15+ 副作用初始化**：Proxy stub 无法拦截构造器
3. **分级加载破坏 prefix cache**：PromptEngine/ToolRegistry 延迟加载会导致 toolsSha256 不同 → 首轮 cache miss
4. **骨架加载 >100ms 不如诚实等待**：响应但不可用的 TUI 是"恐怖谷"
5. **Hot/Cold 边界在快速演化代码库中不稳定**

## 三轮演化

### 第一轮：变异（4 方案）

| 方案 | 生态位 | 核心 |
|------|--------|------|
| V1 外科手术式延迟加载 | 最低风险 | 改 3 个 import，省 32MB |
| V2 双进程分离 | 进程隔离 | TUI 进程 + Agent 进程 |
| V3 Daemon 持久化 | 消灭启动 | 常驻进程 + 薄客户端 |
| V4 构建期依赖图手术 | 编译优化 | tsup 多入口 + 子图分析 |

### 第二轮：选择

- **V2 灭绝**：worker_threads 不共享 V8 heap，双进程内存叠加（60+80=140MB），比单进程更差
- **V3 灭绝**：与用户核心诉求"占内存"矛盾，135MB 变为永久常驻
- **V1 存活**：因果链最硬、成本最低、风险最小
- **V4 存活**：与代码演化共进，但需验证入口子图差异

### 第三轮：适应

**收敛洞察**：Rivet 的内存问题不是"太多模块"而是"太早加载"。

**最终方案**：V1 作为立即执行的基础（Phase 1），V4 的 treeshake 作为构建优化（Phase 2），从 V2/V3 回收组件延迟加载和 config 缓存特征。

## 最终方案

见实施计划：`docs/superpowers/plans/2026-05-21-startup-memory-optimization.md`

Phase 1（30 分钟）：MCP SDK + better-sqlite3 + turndown 延迟加载 → -32MB RSS
Phase 2（1 小时）：tsup treeshake → bundle 减小
Phase 3（验证）：回归测试确认 RSS < 115MB

## 风险与应对

| 风险 | 应对 |
|------|------|
| MCP 首次连接延迟 | MCP 已在 useEffect 中异步初始化，加一层 import() 不改变时序 |
| SessionRegistry 异步化破坏启动流程 | create() 工厂模式，调用方加 await |
| htmlToMarkdown 变异步影响下游 | execute() 已是 async，加 await 透明 |
| Prefix cache 受影响 | PromptEngine/ToolRegistry 保持静态加载，不触碰 |

## 碎片池

完整碎片持久化到 `docs/superpowers/specs/2026-05-21-startup-memory-fragments.json`
