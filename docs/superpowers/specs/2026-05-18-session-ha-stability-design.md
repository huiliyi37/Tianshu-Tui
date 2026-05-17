# 终端会话高可用与高稳定性 — 深度头脑风暴设计文档

## 背景

Rivet 作为长时间运行的终端 AI coding agent（会话常超过 1 小时），面临三类稳定性威胁：
1. **进程级崩溃** — OOM-killer、SIGKILL、Node.js 未捕获异常导致进程终止
2. **数据级损坏** — JSONL 写入过程中断导致半行 JSON、compact 过程中崩溃导致日志不可恢复
3. **子系统级静默故障** — MCP 子进程崩溃但主进程无感知、磁盘满导致 session 写入静默失败

当前已有的容错机制（JSONL 追加日志、原子写入、recovery-trigger 四分类器、compaction circuit breaker）覆盖了大部分正常路径，但缺少三个关键能力：
- **自动恢复入口** — 用户必须手动 `/resume`
- **数据完整性验证** — 半行 JSON 无法区分"损坏"和"不完整"
- **运行时健康检测** — 子系统故障只能等用户触发时才暴露

## 调研来源

三个随机方向的并行调研（故意避开终端/Agent 直接领域，寻找跨界借鉴）：

### Scout 1：分布式数据库 WAL 与崩溃恢复

调研了 SQLite WAL、PostgreSQL checkpoint、Redis RDB+AOF、RocksDB 的 WAL 实现。

**关键发现：**
- PostgreSQL 的 **fuzzy checkpoint** 概念：标记安全点而不阻塞操作，崩溃后从最近 checkpoint 开始 replay
- RocksDB 的 **双 MemTable** 模式：当前写表 + 不可变表，flush 期间不阻塞写入
- Redis 的 **混合持久化**：RDB 全量快照 + AOF 增量命令，恢复时先加载快照再重放少量增量
- SQLite WAL 的 **帧校验和链**：每帧包含前一帧的校验和，可精确定位损坏位置

**对 Rivet 的诊断：** 现有 JSONL 追加日志是 WAL 的简化版，但缺少校验和验证和 fuzzy checkpoint 标记。`compact()` 操作在原地重写日志，如果过程中崩溃，原始日志已被覆盖。

### Scout 2：游戏/实时系统状态快照与确定性重放

调研了游戏引擎快照（Unity/Unreal/ECS）、MOBA/FPS 断线重连、硬件看门狗、WebRTC ICE restart。

**关键发现：**
- 游戏引擎的 **双轨快照策略**：全量快照（每 N 帧）+ 增量日志，恢复时加载快照 + 重放少量增量
- FPS 的 **TimeWarp 算法**：回滚到服务器确认点 → 重放本地输入 → 恢复到当前状态
- 级联看门狗的 **软→硬两级恢复**：WD#1 触发 NMI（记录诊断信息），WD#2 触发硬复位
- WebRTC 的 **宽限期模式**：断开后不立即失败，而是进入 7 秒"重连中"状态，显示进度给用户

**对 Rivet 的诊断：** 现有的 `loadRecoverableMessages()` 是 TimeWarp 的简化版（快照回退），但缺少"重放增量"的第二步。MCP 子进程崩溃没有"宽限期"概念，直接标记为不可用。

### Scout 3：航天/安全关键系统容错

调研了 SpaceX Dragon 三模冗余、NASA FDIR、MQTT LWT 遗嘱消息、ARINC 653 分区调度、混沌工程。

**关键发现：**
- MQTT 的 **遗嘱消息 (LWT)**：客户端启动时注册"遗嘱"，异常断开后 broker 发布遗嘱触发恢复
- NASA FDIR 的 **分层检测**：物理层 → 功能层 → 系统层，每层独立隔离和恢复
- 医疗设备的 **降级运行模式**：非关键故障时自动进入受限功能模式，维持核心能力
- 幂等执行的实践：每个关键操作附带 idempotency key，重试时直接返回缓存结果

**对 Rivet 的诊断：** 缺少 LWT 式的"异常退出检测"——进程被 SIGKILL 后没有留下任何标记，下次启动时不知道上次是正常退出还是异常终止。各子系统（MCP、API、持久化）的健康检测是分散的，没有统一的降级策略。

## 三轮思考过程

### 第一轮：变异

```
生态位: 终端 AI coding agent / 长时间会话(1h+) / 单机 Node.js / 不可靠网络
选择压力: 用户投入的上下文不丢失 + 崩溃后秒级恢复 + 运行时无声故障可检测

方案:
  V1(主流): WAL 加固 — JSONL 加校验和 + fuzzy checkpoint + group commit fsync
  V2(邻近): 遗嘱恢复 — 进程退出注册 LWT，启动时自动恢复会话
  V3(空位): 心跳防线 — 独立心跳检测各子系统健康，触发分层降级
  V4(突变): 混沌原生 — 故障注入做内置命令(/chaos)，经常失败保持韧性

创始假设: 「会话 HA = 数据不丢」— 实际上更高维度是"用户感知不到故障"
适应度函数: 硬约束=不引入新运行时依赖 / 加分=复用现有模块 / 减分=大范围重构
```

### 第二轮：选择

```
因果测试:
  V1: 通过 — 校验和检测损坏 → fuzzy checkpoint 定位恢复点
  V2: 通过 — LWT 检测异常退出 → 自动恢复 → 无需手动 /resume
  V3: 通过但链长 — 心跳检测 → 降级 → 但心跳本身有假阳性
  V4: 通过但非 HA — 故障注入是测试手段不是 HA 机制

成本测试:
  V1: 中 — 2-3 天，修改 session-persist + 新增 checksum
  V2: 小 — ~1 天，PID 文件 + alive 标记 + 启动检查
  V3: 大 — 5+ 天，HealthController 架构变更
  V4: 中 — 3-4 天，但可渐进积累

灭绝:
  V3 — 架构变更太大，与"不大范围重构"硬约束冲突
    回收: "分层健康检测"和"MCP 时间片预算"融入 Phase 3 可选扩展
  V4 — 是测试工具不是 HA 机制
    回收: "故障目录"融入 V1 的验证测试

存活: V1(WAL 加固) / V2(遗嘱恢复)
最强竞争者: V2 — 代码代价最小(~1天)，用户感知最强(异常退出自动恢复)
新发现: V1 和 V2 共享同一个恢复路径(loadRecoverableMessages)，是互补而非互斥
```

### 第三轮：适应

```
套路清除: 航天的"三模冗余投票"不适用(成本远超收益)
扩展适应: recovery-trigger.ts 的 4 个 classifier → LWT 恢复的自动决策器
收敛验证: V1 和 V2 收敛到"复用 loadRecoverableMessages"——V2 不需要新恢复算法
```

## 最终方案：两层会话高可用

### Layer 1：LWT 遗嘱恢复（Phase 1）

**核心思想**（来自 MQTT LWT + NASA 重启恢复）：
- 进程启动时创建 alive 标记（原子写入）
- SIGTERM/SIGINT 处理器清除标记 + 保存 session（已有）
- SIGKILL/OOM 等不可捕获信号无法清除标记 → 这正是我们需要的信号
- 下次启动时：标记未清除 = 异常退出 → 自动恢复

**恢复流程**：
```
启动 → 检查 alive 标记
  ├─ 标记不存在或已清除 → 正常启动
  └─ 标记未清除 → 异常退出
       → 调用 classifyRecoveryTrigger() 判断策略
       → 扫描最近会话的 lastModified
       → loadRecoverableMessages() 恢复
       → 显示 "🔄 检测到上次异常退出，已自动恢复会话 (N turns)"
```

### Layer 2：WAL 校验和加固（Phase 2）

**核心思想**（来自 SQLite WAL 帧校验和 + PostgreSQL fuzzy checkpoint）：

**2a. 行级校验和**
```json
{"type":"message","role":"user","content":"hello"}|a1b2c3d4
```
- 每行 JSON 后追加 `|CRC32`
- 加载时验证：校验和不匹配 → 该行视为"不完整写入"，停止回放
- 向后兼容：无 `|` 后缀的行视为旧格式，尝试正常解析

**2b. Fuzzy Checkpoint 标记**
```json
{"type":"compact_start","turn":42,"messageCount":86}
{"type":"compact_end","turn":42,"messageCount":45}
```
- compact 开始前写 `compact_start`，成功后写 `compact_end`
- 恢复时：如果有 `compact_start` 但无对应 `compact_end` → compact 中途崩溃 → 从 `compact_start` 之前的快照恢复

**2c. 写入分级 fsync**
| 数据类型 | fsync 策略 | 理由 |
|---------|-----------|------|
| 用户消息 | 立即 fsync | 会话完整性关键 |
| Claim 事件 | 立即 fsync | 决策记录不可丢 |
| Tool result | 批量 fsync（每 500ms） | 可重新执行 |
| Thinking delta | 不 fsync | 可再生成 |
| Compact 边界 | 原子写 + fsync | 新文件必须存活 |

### 扩展适配：recovery-trigger.ts 复用

现有的 4 个 classifier 直接用于 LWT 恢复时的决策：

```typescript
const inputs = {
  interrupt: { interruptCountThisTurn: 0, hasPendingTools: pendingTools.length > 0, turn },
  doomLoop: { doomLoopLevel: 'none', recentFingerprints: [], uniqueFingerprintCount: 0 },
  thrashing: { compactionTurns: [], currentTurn: turn, consecutiveCompactFailures: 0,
               estimatedTokens, contextWindow, lastCompactFailed: false },
  integrity: { orphanToolUseCount, orphanToolResultCount, wasRepaired, syntheticResultsInserted, messageCount },
}
const trigger = classifyRecoveryTrigger(inputs)
```

恢复策略由 trigger.severity 和 trigger.suggestedActions 决定，而非硬编码。

## 风险与应对

| 风险 | 应对 |
|------|------|
| CRC32 性能开销 | 微不足道——JSONL 每行通常 <1KB，CRC32 计算耗时 <1μs |
| alive 标记在 Windows 上行为不同 | 用 `writeFileAtomicSync` 保证一致性，跨平台测试 |
| 旧格式 JSONL 无校验和 | 向后兼容：无 `|` 后缀的行视为旧格式，尝试正常解析 |
| LWT 恢复在多 tab 场景冲突 | PID 文件包含 PID，只恢复当前进程的标记 |
| compact_start/end 之间的日志被部分覆盖 | 原子写入保证新文件完整后才删除旧文件 |

## 不做的事

- **不做三模冗余** — 终端应用不需要 x3 成本
- **不做跨机器会话迁移** — 需要 shared storage，超出当前范围
- **不做心跳子系统** — Phase 3 可选，当前聚焦数据完整性和自动恢复
- **不做故障注入命令** — 可作为后续独立功能
- **不引入新依赖** — 用 Node.js 内置 crypto.createHash('crc32') 或手写 CRC32

## 下一步

Phase 1（LWT 自动恢复）→ Phase 2（WAL 校验和加固）→ 可选 Phase 3（分层健康检测）
