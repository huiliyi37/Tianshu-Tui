# 任务：修复 read_file 的 artifact 摘要导致 agent 感知断裂

## 状态更新（2026-05-25）

已解决：`afcff8c fix: read_file returns full code in artifact mode`。

当前 `src/tools/read-file.ts` 在 artifactStore 存在时仍会保存 artifact，但返回给模型的 `content` 已改为 `payload.modelContent + structural outline + trailing [artifact:ID]`，不再只返回结构摘要。后续 `e2616be` 又统一了 artifact marker 必须位于 content 末尾的约定，便于 prune/stale-round 保留恢复入口。

## 背景

你在实施 star-signature（思路 E）时遇到了"卡住"——读 tool-pipeline.ts 只看到函数签名，看不到函数体。你归因为"read_file 过滤层检测到 tool_result 字符串"。

**实际原因不是字符串过滤。** 代码中没有任何地方检测 `tool_result`/`tool_use_id` 来决定是否过滤内容。

## 真正的原因

`src/tools/read-file.ts` line 159-173：

```typescript
if (params.artifactStore) {
  const { summary, sections } = summarizeFileContent(payload.rawContent, payload.canonicalPath)
  const artifactId = await params.artifactStore.save({ ... })
  return {
    content: `[artifact:${artifactId}] ${summary}\nUse read_section(...)`,  // ← 模型只看到这个
    rawContent: payload.modelContent,  // ← 这个不进 token 流
    ...
  }
}
```

当 `artifactStore` 启用时，模型看到的 `content` 是 **summary**（由 `summarizeJsTs()` 生成——只提取 export/function/class 签名）。原始代码被存到磁盘 artifact，模型需要再调 `read_section` 分段读取。

`summarizeJsTs()`（`src/artifact/summarize.ts` line 37-100）只提取结构：imports、exports、function 名、class 名。**函数体从不出现在 summary 中。**

这就是你看到"只有函数签名，函数体空白"的原因。

## 问题本质

这个设计的初衷是节省 context window——大文件不全量灌入 token 流。但它造成了一个严重副作用：

**agent 需要修改文件时，必须先看到文件内容才能构造正确的 `edit_file` 的 `old_string`。** 如果 `read_file` 只返回 summary，agent 要额外调 1-3 次 `read_section` 才能看到目标代码段。这增加了：
- 工具调用次数（延迟 + token 成本）
- 认知负担（"我在哪一段？"）
- 出错概率（行号对不上、section 边界切断了关键上下文）

你的复盘说"这让 agent 变得不敢操作、谨慎迟疑"——这正是问题。

## 修复方向

你的建议是对的：**`read_file` 应该永远返回原始内容给模型。** 

具体来说：当 `artifactStore` 存在时，`read_file` 返回给模型的 `content` 应该是 `payload.modelContent`（已经有 8000 字符截断保护），而不是 summary reference。

artifact 仍然可以存（给 UI 和后续 read_section 用），但**模型的 token 流应该直接看到代码**。

## 约束

1. `modelContent` 已经有 8000 字符截断（head 4000 + tail 2000）——这是 context window 保护，保留它
2. artifact 存储可以保留（UI 需要、read_section 需要）——只是不再用 summary 替代 content
3. 不要破坏 `read_section` 的功能——它仍然是"读超过 8000 字符的大文件特定段"的手段
4. 测试：确保 `read_file` 返回的 `content` 包含实际代码，不是 `[artifact:xxx]` 引用

## 相关文件

- `src/tools/read-file.ts` — 主要改动点（line 159-173 的 if 分支）
- `src/artifact/summarize.ts` — 不需要改，但理解它帮助理解为什么 summary 不够
- `src/tools/read-section.ts` — 不需要改
- `src/agent/tool-pipeline.ts` — 不需要改（artifactIntercept 已经 bypass read_file）

## 验证

改完后用 `read_file` 读 `src/agent/tool-pipeline.ts`（offset=300, limit=50），应该能看到函数体代码，不是 `[artifact:xxx] summary`。
