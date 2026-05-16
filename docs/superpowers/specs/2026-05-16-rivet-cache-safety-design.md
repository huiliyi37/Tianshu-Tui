# Rivet Cache Safety 背景与风险说明

## 背景

Rivet 的核心性能目标之一是让 DeepSeek V4 / OpenAI-compatible provider 的 prefix cache 尽可能稳定命中。当前代码围绕这个目标已经引入了几类缓存：

1. **Provider prefix cache 友好的 prompt 结构**：`PromptEngine` 固定 system prompt 和工具定义，通过 `buildRequest()` 在用户消息前插入 `<context>`。
2. **Speculative prewarm 文件缓存**：`AgentLoop` 在模型输出文本流中识别文件路径，提前读取小文件并放入 `PrewarmCache`，后续 `read_file` 工具命中时直接返回。
3. **Volatile context 辅助缓存**：`.rivet.md` 和 git status 有短 TTL 缓存，减少每 turn 的本地读取成本。
4. **Session memory / task progress / tool history 动态上下文**：这些内容会注入到最新请求，让模型保留任务状态。

这些缓存各自目标合理，但当前边界混在一起：安全边界、正确性边界、prefix cache 边界没有完全分层。结果是：为了命中缓存而绕过了本应统一执行的文件读取规则；为了注入动态上下文而让 prefix drift 不容易被 fingerprint 发现。

## 当前风险

### 风险 1：prewarm 可绕过 `read_file` 的路径与 gitignore 校验

`src/agent/loop.ts` 的 `maybePrewarm()` 直接执行 `readFileSync(join(this.cwd, intent.value))`，而正常 `read_file` 工具会经过 `src/tools/read-file.ts` 的：

- `validatePath()`：禁止路径逃逸项目目录。
- `GitignoreFilter`：禁止读取 `.env`、`node_modules`、构建产物等 gitignored / 默认忽略文件。
- `truncateContent()`：限制模型拿到的内容大小。
- `persistRawOutput()`：保留可审计 raw output。

当前 prewarm cache 命中时，`AgentLoop` 会直接返回缓存内容，不再执行 `READ_FILE_TOOL.execute()`。这意味着 cache hit 可以绕过上述规则。

攻击/误触发形态：模型输出类似 `src/../../outside.md` 的路径，`intent-extractor` 识别为 `src/...md` 文件意图，`join(cwd, intent.value)` 可能解析到项目外。即使真实 `read_file` 会拒绝该路径，prewarm 已经先读过并缓存。

### 风险 2：prewarm key 未规范化，导致 stale cache

prewarm 写入时使用 intent 中的相对路径，例如：

```ts
this.prewarm.set('src/a.ts', content)
```

但 `edit_file` / `write_file` 通常用绝对路径调用，失效时执行：

```ts
this.prewarm.invalidate('/Users/.../src/a.ts')
```

两个 key 不相等，导致写入后缓存未失效。后续 `read_file` 可能返回旧内容，模型会基于旧文件继续推理。

### 风险 3：prewarm 返回内容不等价于 `read_file`

当前 prewarm 存的是原始文件内容。正常 `read_file` 会：

- 支持 `offset` / `limit`。
- 对模型内容做 8000 字符 head/tail 截断。
- 给 TUI 返回 line-numbered `uiContent`。
- 写 raw output 并返回 `rawPath`。

cache hit 直接返回原始 string，会导致 token 突增、UI raw output 缺失、offset/limit 行为错误。

### 风险 4：volatile cache 没有按 cwd 隔离

`src/prompt/volatile.ts` 的 `.rivet.md` cache 是模块级单值；`src/prompt/volatile-git.ts` 的 git status cache 也是模块级单值。当前主 TUI 大多单 cwd，所以短期不明显。但一旦同进程内存在多个 cwd（worker、worktree、未来多项目），A 项目的 `.rivet.md` 或 git status 可能出现在 B 项目 prompt 中。

### 风险 5：prefix fingerprint 不覆盖 stable volatile context

`PromptEngine` 的 fingerprint 只覆盖 system prompt 和 tool definitions。实际请求中还有 frozen volatile block，里面可能包含 cwd、session memory、git status、`.rivet.md`。这些内容变化时，实际 provider cache prefix 已经漂移，但 `checkDrift()` 仍可能返回 null。

## 修复目标

1. **缓存不得绕过安全边界**：prewarm 只能复用与 `read_file` 完全相同的路径校验和 gitignore 过滤。
2. **缓存 key 必须 canonical**：set/get/invalidate 全部使用规范化绝对路径。
3. **cache hit 行为不得改变工具语义**：不支持 offset/limit 的 cache hit；大文件和 gitignored 文件不进入 prewarm。
4. **volatile 本地缓存按 cwd 隔离**：`.rivet.md` 与 git status 缓存必须用 cwd 分桶。
5. **prompt cache 边界可观测**：fingerprint 能反映 stable prompt prefix 的真实组成，动态上下文明确只放在最新 turn。

## 非目标

- 不重写整个 PromptEngine。
- 不引入 provider 级缓存 API 或 cache_control 语义。
- 不改变 `read_file` 的用户可见功能。
- 不在此轮实现完整多项目 workspace 管理。

## 验收标准

- `src/../../outside.md` 不会被 prewarm 读取，也不会通过 cache hit 返回。
- `.env`、`node_modules`、`dist` 等 ignored 文件不会进入 prewarm。
- 编辑/写入文件后，对应 prewarm cache 被正确失效。
- `read_file` 带 `offset` 或 `limit` 时不会使用 full-file prewarm cache。
- `.rivet.md` 和 git status cache 在不同 cwd 之间不串值。
- `PromptEngine.checkDrift()` 能发现 stable volatile block 的变化。
- `npm run typecheck`、`npm test`、`npm run build` 全部通过。
