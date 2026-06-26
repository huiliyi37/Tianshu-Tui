# TODO: CCR router rewire for tianxuan

**来源 commit**: `099706a1` (refactor(capsule): restore originals + split adapted variants)
**提交时间**: 2026-06-XX
**状态**: 待处理（一行代码改动 + 测试更新）

## 情况说明

`docs/seed-capsule-tianxuan.md` 已恢复为 `828961ae` 原版（无 `<principle>` 标签、无 gist 属性）。
原 CCR Phase 2 接入的 X1–X4 principle 结构迁到新文件 `docs/seed-capsule-tianxuan-ccr.md`，
star 字段为 `天璇·CCR`（避免与原版在 `getCapsuleByStar` 里撞名）。

## 影响范围

`src/agent/hooks/cognitive-capsule-router.ts:selectP3Principle` 当前硬编码查询 `'天璇'`：

```ts
const tianxuanPool = getPoolFn('天璇').pool
const x3 = tianxuanPool.find(p => p.key === 'X3')
```

恢复原版后，该查询命中不带 `<principle>` 标签的原版，X3 提取失败，路由器静默 fallback 到
hardcoded `P3_PHASIC_OVERRIDE`——CCR 对天璇的动态原则池注入能力暂时失效（不破功能，但失去
新版"按星域动态挑 X3"的好处）。

## 修复路径

把路由器里的 `'天璇'` 改为 `'天璇·CCR'`，让动态池查询指向改造版文件。

**改动范围**（建议）:
- `src/agent/hooks/cognitive-capsule-router.ts`: `getPoolFn('天璇')` → `getPoolFn('天璇·CCR')`
- `src/agent/__tests__/cognitive-capsule-router.test.ts`: 同步更新 mock/store fixture
- 运行 `npx tsc --noEmit` 验证类型 + `npm exec -- tsx --test src/agent/__tests__/cognitive-capsule-router.test.ts` 验证路由

## 验证标准

修复后，commit message 应包含：
- typecheck 0 error
- cognitive-capsule-router.test.ts 全绿（含 phasic<-0.3 路由到 X3 的现有测试）
- 一条 RED→GREEN 证明：临时改回 `'天璇'`，相关测试应该红

## 关联文件

- 原版: `docs/seed-capsule-tianxuan.md` (14 行 / 358 字节，与 828961ae byte-identical)
- 改造版: `docs/seed-capsule-tianxuan-ccr.md` (22 行 / 818 字节，带 X1-X4 principle)
- 路由器: `src/agent/hooks/cognitive-capsule-router.ts:selectP3Principle`
- 测试: `src/agent/__tests__/cognitive-capsule-router.test.ts`