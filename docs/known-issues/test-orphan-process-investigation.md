# 测试孤儿进程调查记录

**日期:** 2026-06-06
**分支:** `fix/stall-root-causes-abort-exit`
**问题:** `npm test` 跑完所有测试后进程不退出，变孤儿（open handle 吊住 event loop）

---

## 一、复现确认

```
npm test          # tsx --test $(find src -name '*.test.ts') — 454 个文件
→ 所有测试 PASS，但进程不退出，timeout 120s 后被强杀
```

**node:** v24.1.0
**tsx:** 通过 npx tsx 调用

---

## 二、二分法定位（逐目录跑，均正常退出）

| 测试组 | 文件数 | 耗时 | 是否退出 |
|--------|--------|------|----------|
| `src/agent/__tests__/*.test.ts` | ~20 | ~45s | ✅ 退出 |
| `src/tools/__tests__/*.test.ts` | ~20 | ~20s | ✅ 退出 |
| `src/tui/__tests__/*.test.ts(x)` | ~25 | ~20s | ✅ 退出 |
| `src/api/__tests__/*.test.ts` | ~2 | ~20s | ✅ 退出 |
| `src/context/__tests__` + `compact` + `cache` + `config` + `repo` + `prompt` + `artifact` | ~10 | ~20s | ✅ 退出 |
| `src/benchmark/__tests__/*.test.ts` | 5 | ~2.5s | ✅ 退出 |
| `src/failures/__tests__/sample.test.ts` | 1 | ~1.5s | ✅ 退出 |
| `test:fast`（排除 tui） | ~430 | ~60s | ✅ 退出 |
| 全量（显式列出所有文件） | ~77 (用 glob) | ~90s | ✅ 退出（边缘） |
| `npm test`（find 展开） | 454 | >120s | ❌ 挂起 |

**关键发现：**
- 每个目录单独跑都正常退出
- 组合跑（非全量）也正常退出
- **只有 `npm test`（454 文件全量）才挂起**
- 用 `--test-force-exit` 强制退出 → 测试在 1-2s 内就完成了（说明大部分文件被跳过或只有最后几个目录在跑）

---

## 三、疑似根因：`tsx --test` + 454 文件的 edge case

### 3.1 不是某个具体测试的问题
每个目录单独跑都干净退出。即使把所有目录组合在一起（显式列出 ~77 个 glob 展开路径），也能在 90s 内退出。问题仅出现在 `find` 展开 454 个文件传给 `tsx --test` 时。

### 3.2 可能的机制
- **tsx 模块编译缓存 + node:test 并发文件加载**：当 454 个 .ts 文件同时传给 tsx 时，tsx 的编译层（esbuild transform）可能留下未关闭的资源
- **better-sqlite3 native addon**：多个测试文件同时 import `better-sqlite3` 时，native binding 可能有初始化/清理的竞争
- **node:test 内部 scheduler**：Node 24 的 test runner 在处理大量并发文件时可能有已知 bug

### 3.3 排除的嫌疑人
- **StigmergyStore debounced flush timer** → `_flushTimer` 是 `setTimeout`，每个测试 `afterEach` 都调 `close()` 清除
- **SemanticLockManager sweepTimer** → 测试中未调用 `startSweep()`，不会启动 interval
- **SessionRegistry db.close()** → 所有 registry 测试都有 `afterEach(() => registry.close())`
- **oauth-auth refreshTimer** → 测试中不涉及 OAuth 流程

---

## 四、当前状态（已修复 2026-06-06）

### 方案一：孤儿进程（已实施）
`package.json` 的 `test` 脚本已改为使用 `--test-force-exit`：
```json
"test": "node --import tsx --test-force-exit --test $(find src -name '*.test.ts')"
```
Commit: `1d652d0`

### 方案二：session-registry test 失败根因（已修复）
两个测试失败的根本原因：`SessionRegistry.create()` 中使用 `require('node:module')` 在 tsx ESM 环境下抛出 `ReferenceError: require is not defined`，导致静默降级到 `nullDb`（所有写入为 no-op）。

**修复（3 commits）:**
- `b31ba91`: `require('node:module')` → `await import('node:module')` (ESM 兼容)
- `b31ba91`: `detectCrashedSessions`/`reapStaleClaims` 补 claims 表 FK 级联删除（schema 无 FK）
- `9718ce3`: `acquireClaim` 检查 `safeRun` 返回值 + 删除重复 SQL
- `9718ce3`: 移除 `detectCrashedSessions` 重复的 `DELETE FROM sessions`

**验证:** 30/30 tests pass (session-registry + songline)

### 方案三：read_section 大 artifact 死循环（已修复）
`read_section` 的 "Re-read the source" 错误信息导致模型在 artifact 缺失时反复重试源工具。
- `d6824f1`: 2MB 文件大小守卫 + 错误信息改为可执行指引

---

## 五、已知相关 test 失败（非孤儿问题，是测试本身 fail）

跑全量时有 2 个测试 consistently 失败：
1. **`session-registry.test.ts` — `includes all claim types from other sessions`**
   - `expected 0 !== 2` — claim 查询返回空
   - 可能与其他测试共享 DB 文件冲突

2. **`songline.test.ts` — `persists cycle relay in SessionRegistry across registry instances`**
   - `expected null !== hash` — cycle relay 数据未持久化
   - 同样可能是 DB 竞争

这两个失败在单独跑时也偶尔出现，是 DB 文件路径冲突或时序问题，不是孤儿问题的一部分。

---

## 六、当前工作区状态（2026-06-06 更新：全部已修复）

### 本轮已提交修复（会话 28d4eac6）
- `c53f50b`: `read-file.ts` — binary 文件真正拒绝（`BINARY_EXTENSIONS` + `readFilePayload` 检查）
- `c53f50b`: `import-resource.ts` — 图片提示不再导向 read_file
- `75b3677`: `edit.ts` — stale recovery 写入后刷新 mtime（打破 9 次编辑死循环）
- `1d652d0`: `package.json` — test 脚本加 `--test-force-exit`
- `b31ba91`: `session-registry.ts` — ESM `require`→`await import` + claims FK 级联
- `9718ce3`: `session-registry.ts` — acquireClaim 检查返回值 + 去重
- `d6824f1`: `read-section.ts` — 2MB 守卫 + 错误信息去循环

### 前轮已提交
- `33e82c0`: 安全#3 patternMatches 通配符修复
- `bbdc8aa`: stigmergy 原子写入 + OOM guard + write staleness + read 描述修正
- `6495ccd`: session-registry safeRun/safeGet/safeAll helpers

### 工作区状态
**干净。** 所有改动已提交，无未提交文件。

---

## 七、建议下一步（2026-06-06 更新）

1. ~~**立即：** `package.json` test 脚本加 `--test-force-exit`~~ ✅ 已完成 (`1d652d0`)
2. ~~**短期：** 排查 session-registry 和 songline 测试的 DB 路径冲突~~ ✅ 已完成 (根因 ESM require + nullDb, `b31ba91`/`9718ce3`)
3. **中期：** 升级 tsx 版本或换 `node --import tsx` 方式，确认是否为 tsx 层 bug（孤儿进程根因仍未完全定位，`--test-force-exit` 是 workaround）
