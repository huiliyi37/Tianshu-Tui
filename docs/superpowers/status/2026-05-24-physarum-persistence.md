# 2026-05-24 工作记录：Physarum 持久化 → MeridianDb

**时间：** 2026-05-24  
**分支：** feat/tianshu-sycophancy-trap-2.5  
**状态：** ✅ 完成

---

## 任务概述

将 PhysarumEngine 的拓扑状态从纯内存模式升级为 SQLite 持久化，通过 MeridianDb 实现跨会话边权积累。

## 完成内容

### 1. MeridianDb Schema 扩展

新增 `physarum_edges` 表：
- `file_a`, `file_b` — 规范化边端点（PRIMARY KEY）
- `weight`, `flow`, `consolidated`, `activation_count`, `last_activated_turn`, `direction`

### 2. 持久化 API

| 方法 | 位置 | 职责 |
|---|---|---|
| `MeridianDb.savePhysarumEdges()` | meridian-db.ts | 事务性批量写入（DELETE + INSERT） |
| `MeridianDb.loadPhysarumEdges()` | meridian-db.ts | 全量加载为 PhysarumEdgeState[] |
| `PhysarumEngine.save()` | physarum-engine.ts | 将内存边序列化到 DB |
| `PhysarumEngine.loadFromDb()` | physarum-engine.ts | 从 DB 恢复内存图 |
| `MeridianIndexer.getDb()` | meridian-indexer.ts | 暴露 DB 实例给 loop |
| `ImmuneHook.getPhysarum()` | immune-hook.ts | 暴露引擎给 loop |

### 3. Loop 集成

- **初始化时**：从 MeridianDb 加载已有边（`physarum.loadFromDb()`）
- **会话结束时**：在 `runPostSession()` 中调用 `physarum.save()` 持久化

### 4. 防御性设计

- `save()/loadFromDb()` 内置 `if (!this.db?.savePhysarumEdges) return` 守卫，兼容 null db（测试环境）
- loop 中 `try { ... } catch { /* non-critical */ }` 包裹，不阻塞主流程
- 事务写入保证原子性

## 测试结果

| 测试文件 | 通过 |
|---|---|
| meridian-db.test.ts | 8/8 ✅ |
| physarum-engine.test.ts | 8/8 ✅ |
| immune-hook.test.ts | 12/12 ✅ |
| immune-system.test.ts | 9/9 ✅ |
| loop.test.ts | 27/27 ✅ |
| **总计** | **64/64** ✅ |

TypeScript 类型检查：✅ 0 errors

## 数据流

```
Session Start → loop constructor
  → meridianIndexer.getDb() → PhysarumEngine(db)
  → physarum.loadFromDb() ← SQLite physarum_edges

Tool Execution
  → ImmuneHook.run() → physarum.recordFlow() → edges evolve in-memory

Session End → runPostSession()
  → immuneHook.getPhysarum().save()
  → MeridianDb.savePhysarumEdges() → SQLite
```

## 影响的文件

- `src/repo/meridian-db.ts` — schema + save/load methods
- `src/repo/physarum-engine.ts` — save/loadFromDb
- `src/repo/meridian-indexer.ts` — getDb() accessor
- `src/agent/immune-hook.ts` — getPhysarum() accessor
- `src/agent/loop.ts` — 初始化 + 会话结束持久化
- `src/repo/__tests__/meridian-db.test.ts` — 2 new tests
- `src/repo/__tests__/physarum-engine.test.ts` — 1 new test
