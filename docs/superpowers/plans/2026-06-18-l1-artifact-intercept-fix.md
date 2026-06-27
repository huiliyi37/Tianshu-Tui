# L1 artifact 拦截边界重划 + 修二次落盘 bug 实现计划

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现（计划阶段不派子代理）。
> 步骤使用复选框（`- [ ]`）语法跟踪进度。
> 背景与设计依据见 `.rivet/plans/工具输出落盘治理-L1拦截边界重划-修二次落盘bug-删死参数.md`（Phase 1）。

**目标：** 让 `artifactIntercept`（L1）只拦截没有 L0 内部 wrap 的工具；有 L0 的（read_file/read_section/grep/bash）一律豁免，从而消灭 grep/bash 大输出的"L0+L1 二次落盘" bug，并清除恒死的 3x 阈值分支与 `find_files`/`search` 死条目。

**架构：**
- 单一判定 `L0_WRAPPED_TOOLS` set 取代分散的 `READ_TOOLS`/`isReadTool`/字面量早退。有 L0 的工具直接早退。
- 复用已存在的 `extractTrailingArtifactId`（`tool-result-tiering.ts:40`，`/\[artifact:…]\s*$/` 末尾锚定）替换错误的 `startsWith('[artifact:')` 检测——这是 bug 根因（L0 把标记放末尾，旧检测看开头）。
- 删除被 floor 架空的 `base*3` 分支（对 1M/200K read 工具恒为死代码）及随之 unused 的 `READ_TOOLS`/`isReadTool`/`isBashReadOnly`。

**技术栈：** TypeScript strict / node:test + node:assert/strict / 真实 `ArtifactStore`（非 mock）。

---

## 调研背书（删除/修改操作）

- `READ_TOOLS`（`tool-pipeline.ts:256-265`）：仅 `isReadTool`(327) 引用，无外部/测试引用（grep 全库确认）。含 `find_files`/`search` 死条目——`src/tools` 无 `name:'find_files'|'search'` 注册（grep 确认）。可整体删除。
- `isReadTool`（327）：仅 338 的 3x 分支使用。删 3x 后 unused → 删除。
- `isBashReadOnly`（268-271）：仅 327 使用。随 `isReadTool` 删除而 unused → 删除。
- `base*3` 分支（338-340）：紧随的 floor（351-354）`Math.max(threshold, getToolArtifactThreshold(tool,w))` 在 1M/200K 恒 ≥ 7500，使 3x 死代码；仅测试环境（无 contextWindow→跳过 floor）让 3x 生效。删除后，glob/repo_map/inspect_project 仍由 floor（multiplier 0.5）正确拦截，能力不丢。
- grep/bash 早退安全性：grep（`grep.ts:90,130`）、bash（`bash.ts:199-200,232`，对**所有**命令、不分读写）均有 L0 wrap 且标记在末尾，并各有 post-mortem 背书（wrap 已 wrap 内容会让模型以为被截断→写 /tmp 逃逸 / read_section 递归）。L1 豁免它们不丢 wrap 能力（L0 已覆盖所有需 wrap 体积）。
- `extractTrailingArtifactId`：已 export，`tool-pipeline.ts` 尚未 import → 需新增 import。
- 现有测试 `intercepts large non-read tool output`（test:1105，用 `run_tests`）与 `does NOT intercept read_file output`（test:1152）：修复后行为不变（run_tests 不在豁免集→仍 save；read_file 在豁免集→仍早退）。✓

---

## 任务

### 任务 1：写失败的二次落盘回归测试

- [ ] 修改 `src/agent/__tests__/tool-pipeline.test.ts`（在 `describe('artifactIntercept in tool pipeline')` 内，紧接 test:1150 之后追加）

**目标：** 复现 bug——grep 返回已带末尾 `[artifact:]` 的 L0 输出时，L1 不应二次 save。当前实现会二次 save（红）。

**实现：**
```typescript
  it('does NOT re-wrap grep output already carrying a trailing artifact ref (L0→L1 double-save)', async () => {
    setup()
    try {
      // Simulate an L0-wrapped grep result: large inline body + trailing [artifact:] marker.
      const l0Wrapped =
        'G'.repeat(10000) +
        '\n\nmatches summary\nUse read_section(artifactId="preexisting-l0", section="L1-L200") to expand.\n[artifact:preexisting-l0]'
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: l0Wrapped, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-grep-double', name: 'grep', input: { pattern: 'x' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // L1 must NOT create a new artifact for an already-wrapped result.
      assert.equal(store.list().length, 0,
        'L1 must not double-save a grep result that already carries a trailing artifact ref')
      // The original L0 artifact ref must survive untouched.
      assert.ok(content.includes('[artifact:preexisting-l0]'),
        'original L0 artifact ref must survive')
    } finally {
      cleanup()
    }
  })
```

**验证：**
```bash
npm exec -- tsx --test src/agent/__tests__/tool-pipeline.test.ts  # 期望：新测试 FAIL（store.list().length === 1，二次落盘）
```

### 任务 2：重划 L1 拦截边界，修 bug

- [ ] 修改 `src/agent/tool-pipeline.ts`（import、删 `READ_TOOLS`/`isReadTool`/`isBashReadOnly`、重写 `artifactIntercept` 早退与检测）

**目标：** 有 L0 的工具 L1 早退；末尾检测取代 startsWith；删死参数。任务 1 测试转绿。

**实现：**

1) 新增 import（与现有 `getToolArtifactThreshold` import 同区，`tool-pipeline.ts:37` 附近）：
```typescript
import { extractTrailingArtifactId } from './tool-result-tiering.js'
```

2) 删除 `READ_TOOLS` 定义（`tool-pipeline.ts:252-265`，含注释块），替换为：
```typescript
/** Tools that perform their own L0 artifact wrapping (inside the tool impl) and
 *  emit a trailing [artifact:id] marker. L1 must NOT re-wrap their output:
 *  - read_file / read_section: content the model explicitly requested; re-wrap
 *    triggers a read_section recovery loop (post-mortem 2026-05-25).
 *  - grep / bash: L0 wraps at its own threshold with a trailing marker; the old
 *    startsWith('[artifact:') check missed the trailing marker and re-saved the
 *    already-truncated string (L0→L1 double-save bug). */
const L0_WRAPPED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'bash',
])
```

3) 删除 `isBashReadOnly` 函数（`tool-pipeline.ts:267-271`）。

4) 重写 `artifactIntercept` 顶部（替换当前 325-340 的 `if (!artifactStore)`、`isReadTool`、read_file/read_section 早退、3x 分支）：
```typescript
  if (!artifactStore) return content

  // Tools with their own L0 wrapping must not be re-intercepted here.
  if (L0_WRAPPED_TOOLS.has(toolName)) return content
  // Belt-and-suspenders: never re-wrap content that already ends in an artifact
  // ref (covers any future L0-wrapping tool not yet listed above). Uses the
  // shared trailing-marker convention, not startsWith — the marker is at the END.
  if (extractTrailingArtifactId(content)) return content

  let threshold = thresholdOverride ?? (isError ? ARTIFACT_ERROR_THRESHOLD : ARTIFACT_INTERCEPT_THRESHOLD)
```

5) 删除旧的开头检测行 `if (content.startsWith('[artifact:')) return content`（原 `tool-pipeline.ts:370`）——已被步骤 4 的 `extractTrailingArtifactId` 前置取代。

保留不动：floor 段（原 351-354）、budget scaling 段（原 357-364）、`content.length <= threshold` 段、save 段。

**验证：**
```bash
npx tsc --noEmit  # 期望：无 unused（READ_TOOLS/isReadTool/isBashReadOnly 已删）、无类型错误
npm exec -- tsx --test src/agent/__tests__/tool-pipeline.test.ts  # 期望：全部通过（含任务1新测试）
```
若有断言 grep/bash 经 L1 save 的旧测试转红：按新语义更新（grep/bash 现由 L0 处理，L1 豁免）。

**提交：**
```bash
git add src/agent/tool-pipeline.ts src/agent/__tests__/tool-pipeline.test.ts
git commit -m "$(cat <<'EOF'
fix(pipeline): L1 只拦无 L0 的工具 — 修 grep/bash 二次落盘 bug

L0 把 [artifact:] 标记放末尾，旧 startsWith 检测看开头漏判，导致已落盘
内容被 L1 二次 save。改用 extractTrailingArtifactId 末尾检测 + L0_WRAPPED_TOOLS
早退；删除被 floor 架空的 3x 死分支及 READ_TOOLS/isReadTool/isBashReadOnly。
EOF
)"
```

### 任务 3：清理死 import

- [ ] 修改 `src/tools/bash.ts:10`（删 `import { pruneThresholds }`，确认无调用）
- [ ] 修改 `src/tools/read-file.ts:11`（删 `pruneThresholds` import，仅注释引用）

**目标：** 移除审计确认的死 import（scout 已证 bash.ts/read-file.ts 不调用 `pruneThresholds`）。

**实现：** 删除两文件中的 `pruneThresholds` import 项；若该 import 行还引入其他在用符号，仅从解构中移除 `pruneThresholds`。

**验证：**
```bash
npx tsc --noEmit  # 期望：无 unused import、无报错
npm exec -- tsx --test src/tools/__tests__/artifact-threshold.test.ts  # 期望：通过（未受影响）
```

**提交：**
```bash
git add src/tools/bash.ts src/tools/read-file.ts
git commit -m "chore(tools): 删除 bash/read-file 中死 import pruneThresholds（任务 3/3）"
```

### 任务 4：全量回归与交付

- [ ] 运行受影响域的测试套件

**目标：** 确认改动未破坏 read_section 取回链、worker per-session 隔离及压缩相关测试。

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/tool-pipeline.test.ts
npm exec -- tsx --test src/tools/__tests__/artifact-threshold.test.ts
npm exec -- tsx --test src/tools/__tests__/read-section.test.ts  # 取回链未破坏（若存在该文件）
npm test  # 全量，期望与基线一致（无新增失败）
```
**退出条件（设计文档）：** 若 read_section 取回链或 worker 隔离测试转红 → 回退任务 2，重新评估 L0 边界。

---

## 自检

1. **规格覆盖**：Phase 1 五项动作 → 任务 2（L1 豁免/末尾检测/删 3x/删 READ_TOOLS+死条目）+ 任务 3（死 import）+ 任务 1（回归测试）。✓
2. **占位符扫描**：无 TODO/TBD/待定；测试与编辑均为具体代码。✓
3. **类型一致性**：`L0_WRAPPED_TOOLS: ReadonlySet<string>`、`extractTrailingArtifactId(content: string): string | undefined`、`executeToolUse(toolUse, deps, callbacks, turn, isFinal)` 跨任务一致。✓
4. **调研背书**：所有删除（READ_TOOLS/isReadTool/isBashReadOnly/3x/死 import）均有 grep 调用者证据与存在原因，见上「调研背书」节。✓
