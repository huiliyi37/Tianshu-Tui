# 死代码清理 + 类型逃逸修复

## 范围

处理上一轮核实确认的 5 项死代码 + 4 处类型逃逸。不碰 `impact-hint.ts`（活跃使用）和 `goal-tracker.ts` `deactivate()`（有调用方）。

## 任务

### T1 — 删除 `src/agent/plan-executor.ts` 死文件

0 外部引用。删除整个文件及其测试 `src/agent/__tests__/plan-executor.test.ts`（如存在）。

**文件**: `src/agent/plan-executor.ts`

### T2 — 删除 `engine.ts` 三个 noop 字段

- `setBehaviorMirror`（L707）— `@deprecated` + `/* noop */`
- `setStrategyShift`（L710）— `@deprecated` + `/* noop */`
- `setImpactHint`（L718）— `/* noop */`

删除这三个方法定义，同时更新测试 stub 中出现的 mock 调用（`setStrategyShift: () => {}` 等）。

**文件**: `src/prompt/engine.ts`、`src/agent/__tests__/tool-pipeline.test.ts`、`src/agent/__tests__/tool-execution-abort.test.ts`

### T3 — 删除 `seed-capsule-store.ts` 两个 deprecated 函数

- `loadTianxuanCapsule`（L211）— `@deprecated`，0 外部引用
- `renderCapsuleBlock`（L221）— `@deprecated`，0 外部引用

同时删除测试文件中对这两个函数的引用和测试用例。

**文件**: `src/agent/seed-capsule-store.ts`、`src/agent/__tests__/seed-capsule-store.test.ts`

### T4 — 修复类型逃逸 `as any`

在以下 4 个文件中消除 `as any` 桥接：

| 位置 | 当前 | 修复方向 |
|------|------|---------|
| `loop-factory.ts:428` | `signal as any` | 对齐 `injectSignal` 参数类型 |
| `loop-factory.ts:509,612` | `telemetryWriter as any` | 声明 `write` 方法签名或使用交集类型 |
| `turn-orchestrator.ts:594,655,688` | `} as any)` | 声明正确的 telemetry entry 接口 |
| `p3-integration.ts:186` | `planCache as any` | 在 PlanCache 类型上暴露 `entries` 属性 |

**文件**: `src/agent/loop-factory.ts`、`src/agent/turn-orchestrator.ts`、`src/agent/p3-integration.ts`

## 验证

- `npx tsc --noEmit` 零错误
- `npm exec -- tsx --test src/agent/__tests__/tool-pipeline.test.ts`
- `npm exec -- tsx --test src/agent/__tests__/tool-execution-abort.test.ts`
- `npm exec -- tsx --test src/agent/__tests__/seed-capsule-store.test.ts`
