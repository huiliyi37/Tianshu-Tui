# T3 · Debug Loop 改进建议

> 日期：2026-05-22
> 触发：WorkspaceGuard 收束过程中 4 轮 debug 循环
> 状态：观察性 brief，非执行计划

## 1. 事实

WorkspaceGuard Step 2（`wouldOverwriteModified`）的实现中，用 `git status --porcelain` 解析本地修改文件。初始解析逻辑 `line.slice(3).trim()` 在 porcelain 格式 ` M src/lib.ts`（空格+M）上失败——`slice(3)` 漏掉了第一个字符。

排查过程：
- 第 1 轮：2 个测试失败（merge modified + stash missing_current）
- 第 2 轮：修了 stash 测试（test setup bug：commit 后 clean tree → `git stash` 无 stash），merge 测试仍失败
- 第 3 轮：加 `assert.fail` 打印 `git status --porcelain` 输出，发现格式是 `" M src/lib.ts"` 不是 `"M src/lib.ts"`
- 第 4 轮：用 `git diff --name-only` + `git diff --cached --name-only` 替代 porcelain 解析，通过

根因：**写解析代码时猜了格式，没有先读 git 实际输出**。

## 2. 模式识别

这个模式在过去出现多次：

| 日期 | 场景 | 根因 |
|------|------|------|
| 05-16 | subagent 执行失败 | 验证反馈不足 + 策略振荡 |
| 05-18 | TUI 2.1 自省 | 上下文压力导致忽略已有代码 |
| 05-22 | WorkspaceGuard debug | 猜测格式而非先读输出 |

共同特征：**在不确定事实的情况下先写代码，用测试来"试"正确性，而不是先观察再实现**。

## 3. 建议

### 3.1 "Read First, Code Second" 规则

当需要解析外部命令输出（git, npm, etc.）时：

```
第 1 步：在测试中先打印实际输出
第 2 步：根据实际输出写解析逻辑
第 3 步：验证
```

而不是：

```
第 1 步：凭经验猜格式
第 2 步：写解析代码
第 3 步：测试失败
第 4 步：加 debug log
第 5 步：修解析
第 6 步：再验证
```

### 3.2 不吞错误原则

`gitLines` 的 `catch { return [] }` 模式在安全守卫中是危险的——git 命令失败时，守卫会静默认为"没有问题"。

建议：
- 区分 "git 成功但输出为空"（合法）和 "git 失败"（应传播）
- 安全守卫类的 helper 应该 throw on error，让调用者决定是否降级
- 或者至少返回 `{ ok: false, reason: string }` 而非空数组

### 3.3 Debug 循环超时机制

建议在 `.rivet.md` 或 playbook 中加一条：

> **同一点失败 3 轮后，停止修改代码，改为打印状态 + 提问。**

不是"更努力地修"，而是"换视角"。具体操作：
1. 停下来读实际输入/输出
2. 用 `assert.fail(JSON.stringify({ actual, expected }))` 打印完整上下文
3. 如果仍然不确定，向用户提问而不是继续猜

### 3.4 测试 helper 也要遵守项目规范

测试里的 `execSync` 不只是风格问题——它在 debug 时隐藏了错误信息（`execSync` 的 stderr 默认不抛出到 console），让排查更难。改为 `execFileP` 后错误信息完整可见。

## 4. 不建议做的事

- ❌ 加自动重试机制（掩盖问题）
- ❌ 加更复杂的 log 系统（增加上下文压力）
- ❌ 在每个 catch 里加 stderr.write（debug 残留）

## 5. 与上位文档的关系

- T2 复盘第 5 条："工具现实优先于注入上下文" → 先读输出再写解析
- T2 复盘第 3 条："执行者与审查者必须切换" → 写代码的是执行者，debug 时应切换为审查者视角
- playbook.jsonl 里的 "策略振荡" lesson → 3 轮失败后应切换策略而非继续同一路径
