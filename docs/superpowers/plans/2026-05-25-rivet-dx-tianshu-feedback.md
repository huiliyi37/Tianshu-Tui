# Rivet TUI DX 改进：天枢反馈三连修 实现计划

## 状态更新（2026-05-25）

已解决并保留为实施记录：

- Task 1：`6589d75 fix(edit): replace_all warns when actual count mismatches expected_count`
- Task 2：`f665f10` / `299f2d1` 已补充 scout vs worker 决策表与 sandbox root cause
- Task 3：`299f2d1` 已补充 phase checkpoint mechanism

该文档是较早的“三连修”计划；后续更大的“四连修”计划仍保留未提交，因为它包含 worker worktree / host sandbox 的进一步 caveat。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复天枢在 2026-05-24 session 中反馈的三个 DX 问题：(1) edit_file replace_all 静默部分成功、(2) scout subagent 无法执行写操作、(3) 长 session 中审查→计划→执行阶段缺乏检查点。

**架构：** 三个独立修复，互不耦合。Task 1 改 edit tool 返回值增加替换计数；Task 2 给 subagent-driven-development 的 worker 增加 worktree 写权限配置；Task 3 在 executing-plans 中添加阶段检查点（plan/execute 分 session 的能力）。

**技术栈：** TypeScript strict, node:test

---

## 1. Scope check

三个问题分属不同子系统：

| 子系统 | 问题 | 影响范围 |
|--------|------|----------|
| A：edit_file tool | `replace_all` 静默部分成功（相同内容不同缩进只替换一处） | `src/tools/edit.ts` |
| B：subagent 写权限 | scout/subagent 能定位代码写好 patch 但无法执行 | `src/agent/collaboration-protocol.ts`, subagent dispatch |
| C：session 检查点 | 审查→计划→执行在同一 session 里太长，缺乏阶段分割 | superpowers skill 层，非 src 代码 |

三个问题独立可交付，合并在一个计划中是因为都源自同一次反馈 session。

---

## 2. File structure

### 修改

| 文件 | 职责 | 变更性质 |
|------|------|----------|
| `src/tools/edit.ts:49-59` | edit_file replace_all 路径 | 增强返回信息 |
| `src/tools/__tests__/edit.test.ts` | edit tool 测试 | 新增测试用例 |

### 不涉及代码变更（流程/文档改进）

| 文件 | 职责 |
|------|------|
| `docs/stars/immune-mistake-redesign.md` 或 subagent 相关文档 | 记录 scout→worker 升级路径 |

---

## 3. Tasks

### Task 1：edit_file replace_all 返回替换计数 + 预期计数参数

**文件：**
- 修改：`src/tools/edit.ts:49-59`
- 测试：`src/tools/__tests__/edit.test.ts`

**问题分析：**

当前 `replace_all` 的行为（`edit.ts:56`）：
```typescript
const newContent = content.replaceAll(oldString, newString)
const occurrences = (content.match(new RegExp(escapeRegExp(oldString), 'g')) || []).length
return { content: `Replaced all ${occurrences} occurrences in ${filePath}` }
```

它已经返回了替换计数——但模型看到"Replaced all 1 occurrences"时不知道这是否符合预期。天枢的问题是：他以为会替换 2 处，实际只替换了 1 处（因为缩进不同），但没有机制让他知道预期不匹配。

**方案：** 在 tool schema 中添加可选参数 `expected_count`。如果提供了 `expected_count` 且实际替换数不匹配，返回 warning（非 error，仍然执行替换但提示模型检查）。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tools/__tests__/edit.test.ts — 新增测试
it('warns when replace_all count mismatches expected_count', async () => {
  const filePath = join(tmpDir, 'mismatch.ts')
  writeFileSync(filePath, '  foo\n    foo\n', 'utf-8')
  // "  foo" (2 spaces) appears once; "  foo" won't match "    foo" (4 spaces)
  const result = await editTool.execute({
    input: { file_path: filePath, old_string: '  foo', new_string: '  bar', replace_all: true, expected_count: 2 },
    cwd: tmpDir,
  })
  assert.ok(result.content.includes('Warning'))
  assert.ok(result.content.includes('expected 2'))
  assert.ok(result.content.includes('replaced 1'))
})

it('no warning when replace_all count matches expected_count', async () => {
  const filePath = join(tmpDir, 'match.ts')
  writeFileSync(filePath, 'foo\nfoo\nfoo\n', 'utf-8')
  const result = await editTool.execute({
    input: { file_path: filePath, old_string: 'foo', new_string: 'bar', replace_all: true, expected_count: 3 },
    cwd: tmpDir,
  })
  assert.ok(!result.content.includes('Warning'))
  assert.ok(result.content.includes('Replaced all 3'))
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/tools/__tests__/edit.test.ts`
预期：新测试 FAIL（`expected_count` 参数不存在）

- [ ] **步骤 3：实现**

修改 `src/tools/edit.ts`：

Schema 中添加参数：
```typescript
expected_count: { type: 'number', description: 'Expected number of replacements. If actual count differs, a warning is returned.' },
```

replace_all 路径修改：
```typescript
if (replaceAll) {
  if (!content.includes(oldString)) {
    return { content: buildNotFoundError(filePath, oldString, content), isError: true }
  }
  const newContent = content.replaceAll(oldString, newString)
  writeFileSync(filePath, newContent, 'utf-8')
  const occurrences = (content.match(new RegExp(escapeRegExp(oldString), 'g')) || []).length
  const expectedCount = params.input.expected_count as number | undefined
  if (expectedCount !== undefined && occurrences !== expectedCount) {
    return { content: `Warning: expected ${expectedCount} replacements but replaced ${occurrences} in ${filePath}. The file has been modified — verify with grep that no instances were missed (different indentation can cause partial matches).` }
  }
  return { content: `Replaced all ${occurrences} occurrences in ${filePath}` }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/tools/__tests__/edit.test.ts`
预期：全部 PASS

- [ ] **步骤 5：类型检查**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 6：Commit**

```bash
git add src/tools/edit.ts src/tools/__tests__/edit.test.ts
git commit -m "fix(edit): replace_all warns when actual count mismatches expected_count"
```

---

### Task 2：记录 scout → worker 升级路径（文档改进）

**背景：** 天枢遇到的"子代理写了 patch 但执行不了"是因为他用的是侦察模式的 subagent（只读），而 Rivet 已有 worktree-based worker 系统（`collaboration-protocol.ts` + `worktree.ts` + `merge-protocol.ts`）支持写操作。

问题不是"系统不支持"，而是 superpowers:subagent-driven-development 技能文档没有明确说明：
- scout（侦察）= 只读，用于定位和分析
- worker（执行）= 有 worktree 隔离，可读写 + commit

**方案：** 这是文档/技能层面的改进，不是代码修复。需要在 subagent-driven-development 技能中明确区分 scout 和 worker 模式，让模型知道什么时候该升级到 worker。

- [ ] **步骤 1：确认 subagent-driven-development 技能文件位置**

运行：`find ~/.claude/skills -name "*subagent*" -o -name "*worker*" | head -5`

- [ ] **步骤 2：在技能文档中添加 scout vs worker 决策树**

在 subagent-driven-development 技能中添加明确的决策指引：

```markdown
## Scout vs Worker 决策

| 场景 | 模式 | 权限 |
|------|------|------|
| 定位代码、grep、分析 | Scout（只读） | read + search |
| 需要编辑文件、执行 patch | Worker（worktree 隔离） | read + write + commit |

当 scout 返回了精确的 patch 方案但无法执行时，应升级为 worker：
1. 用 collaboration-protocol 获取语义锁
2. 在 worktree 中分配 worker
3. Worker 执行 patch + 运行测试
4. merge-protocol 合并回主分支
```

- [ ] **步骤 3：Commit**

```bash
git add <skill-file>
git commit -m "docs(skills): clarify scout vs worker modes in subagent-driven-development"
```

---

### Task 3：executing-plans 阶段检查点（流程改进）

**背景：** 天枢反馈"审查→计划修正→执行在同一会话里有点长"。当前 executing-plans 技能是"一口气执行所有任务"模式。

**方案：** 在 executing-plans 技能中添加"阶段性检查点"概念：

1. 计划中可以标记 `--- checkpoint ---`
2. 执行到检查点时暂停，输出当前进度摘要
3. 用户可以选择"继续"或"开新 session 继续"（带 handoff）

这是技能层面的改进，不涉及 Rivet src 代码。

- [ ] **步骤 1：确认 executing-plans 技能文件位置**

运行：`find ~/.claude/skills -name "*executing*" -o -name "*plan*" | grep -v node_modules | head -10`

- [ ] **步骤 2：在 executing-plans 技能中添加检查点机制**

在技能文档中添加：

```markdown
## 检查点（Checkpoint）

当计划包含多个阶段（如"诊断→修复→验证"），在阶段边界插入检查点：

### 触发条件
- 累计已完成 tasks >= 3 且剩余 tasks >= 2
- 当前 context 使用率 > 60%
- 任务类型从"分析/计划"切换到"实现/执行"

### 检查点动作
1. 输出当前进度摘要（已完成/剩余/发现的问题）
2. 提示用户："已完成阶段 N。继续执行还是开新 session？"
3. 如果开新 session：生成 handoff summary + 指向计划文档的指针
```

- [ ] **步骤 3：Commit**

```bash
git add <skill-file>
git commit -m "docs(skills): add checkpoint mechanism to executing-plans"
```

---

## 4. Verification

| 验证项 | 命令 | 预期结果 |
|--------|------|----------|
| edit tool 测试 | `node --import tsx --test src/tools/__tests__/edit.test.ts` | 全部 pass |
| 类型检查 | `npx tsc --noEmit` | 0 errors |
| 全量测试（Task 1 后） | `node --import tsx --test src/tools/__tests__/edit.test.ts` | 含新用例 pass |

---

## 5. Self-check

1. **Spec coverage:**
   - "replace_all 缩进陷阱" → Task 1（`expected_count` 参数 + warning） ✓
   - "子代理写了 patch 但执行不了" → Task 2（scout vs worker 文档） ✓
   - "审查→计划→执行太长" → Task 3（检查点机制） ✓

2. **Placeholder scan:** 无 TODO/TBD/待定。Task 2 和 Task 3 的技能文件路径需要在执行时确认（`find` 命令）。

3. **Type consistency:**
   - `expected_count` 参数类型为 `number | undefined`，与 schema 中 `type: 'number'` 一致
   - `occurrences` 已有的 `number` 类型与比较逻辑一致

---

## 6. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-25-rivet-dx-tianshu-feedback.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。Task 1 是代码变更，Task 2/3 是文档变更，可并行。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
