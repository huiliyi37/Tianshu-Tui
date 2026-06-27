# 桌面端图片上传 — 端到端 vision 消息支持

# 桌面端图片上传 — 端到端 vision 消息支持

## 1. 问题

桌面端 Composer 只能发送纯文本。用户遇到 UI bug、设计稿、报错截图等需要图片描述的问题时无法有效沟通。需要支持在桌面端上传图片（粘贴/拖放/选择文件），图片以 OpenAI vision 格式（base64 data URL）随消息发送给 LLM。

## 2. 当前数据流

```
Composer.tsx (onSubmit: text string)
  → queries.ts useSendPrompt({ id, prompt: string })
    → client.ts sendPrompt(id, prompt: string) → POST /sessions/:id/prompt { prompt }
      → session-routes.ts → manager.run(id, prompt: string)
        → session-manager.ts → agent.run(prompt: string, callbacks)
          → loop.ts run(userInput: string) → session.addUserMessage(userInput: string)
            → context.ts addUserMessage(content: string) → { role: 'user', content: string }
```

## 3. 根因：content 类型是纯 string

`OaiUserMessage.content: string`（`src/api/oai-types.ts:21`），从 UI 到 API 全链路只支持文本。OpenAI vision 格式需要 content 为数组：
```json
{ "role": "user", "content": [
  { "type": "text", "text": "..." },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]}
```

## 4. 方案：images 作为独立参数，在最窄点构造

**核心策略**：不把 `OaiUserMessage.content` 改成 `string | ContentPart[]` union（那会波及几十个 compaction/estimation/persistence 文件），而是让 `images` 作为独立参数穿透各层，只在 `SessionContext.addUserMessage` 这一个最窄点构造多模态 content。

### 类型定义

```typescript
// src/api/oai-types.ts — 新增
export interface OaiImagePart {
  type: 'image_url'
  image_url: { url: string }  // data:image/xxx;base64,...
}
export interface OaiTextPart {
  type: 'text'
  text: string
}
export type OaiContentPart = OaiTextPart | OaiImagePart

// OaiUserMessage.content 改为支持数组
export interface OaiUserMessage {
  role: 'user'
  content: string | OaiContentPart[]
}
```

### 4.1 后端改动（src/）

| 文件 | 当前 | 改后 | 安全性 |
|------|------|------|--------|
| `src/api/oai-types.ts` | `OaiUserMessage.content: string` | `string \| OaiContentPart[]` + 新增 part 类型 | 向后兼容：string 仍合法 |
| `src/agent/context.ts:90` | `addUserMessage(content: string)` | `addUserMessage(content: string, images?: string[])` — 有图时构造 `[{type:'text',text},...images.map(url=>({type:'image_url',image_url:{url}}))]` | 无图时行为不变 |
| `src/compact/micro.ts:51` | `estimateOaiMessageTokens` 假设 content 是 string | `else` 分支：检查 `Array.isArray(msg.content)` → 拼接文本 + 每图固定 765 tokens | 纯文本消息不受影响 |
| `src/agent/loop.ts:1295` | `run(userInput: string, callbacks)` | `run(userInput: string, callbacks, images?: string[])` → 传给 `addUserMessage` | 无图时完全不变 |
| `src/agent/loop.ts:1486` | `this.session.addUserMessage(userInput)` | `this.session.addUserMessage(userInput, images)` | 同上 |
| `src/server/session-manager.ts` ManagedAgent | `run(prompt: string, callbacks)` | `run(prompt: string, callbacks, images?: string[])` | 接口可选参数 |
| `src/server/session-manager.ts:run()` | `run(id, prompt: string)` | `run(id, prompt: string, images?: string[])` → 传给 `agent.run` | 无图不变 |
| `src/server/session-manager.ts` user event | `append(session, 'user', { text: prompt })` | `append(session, 'user', { text: prompt, imageCount: images?.length })` | 仅增字段 |
| `src/server/session-routes.ts` prompt route | 只校验 `data.prompt` | 额外校验 `data.images?: string[]`（每项须 `data:image/` 开头），传给 `manager.run` | 安全校验：拒绝非 data URL |

### 4.2 前端改动（desktop/src/）

| 文件 | 当前 | 改后 |
|------|------|------|
| `runtime/client.ts` | `sendPrompt(id, prompt: string)` | `sendPrompt(id, prompt: string, images?: string[])` → body 加 `images` |
| `state/queries.ts` | `useSendPrompt({ id, prompt })` | `useSendPrompt({ id, prompt, images? })` |
| `components/Composer.tsx` | textarea only | + 图片粘贴(Ctrl+V)、拖放(drop)、文件选择按钮(hidden input[type=file]) + 缩略图预览 + 删除按钮 |
| `state/event-reducer.ts` | user block 只有 text | user block 增 `imageCount?` 字段，渲染时显示 `[📷 N 张图片]` |
| `surfaces/ThreadView.tsx` | 渲染 user text | 若 imageCount > 0，追加图片指示器 |

### 4.3 图片格式约束

- 前端将 File 转为 base64 data URL（`FileReader.readAsDataURL`）
- 限制：单张 ≤ 5MB（超过前端压缩或拒绝），最多 4 张
- 仅接受 `image/png`, `image/jpeg`, `image/webp`, `image/gif`
- 后端路由校验每项 `images` 必须以 `data:image/` 开头（防注入）

## 5. 实施顺序（5 个独立可提交单元）

### Task 1: 类型层 — OAI types + token estimation
- `src/api/oai-types.ts`: 新增 `OaiContentPart` 类型，改 `OaiUserMessage.content`
- `src/compact/micro.ts`: `estimateOaiMessageTokens` 处理 array content
- 验证：`npx tsc --noEmit` + 相关测试

### Task 2: Agent 层 — context + loop
- `src/agent/context.ts`: `addUserMessage(content, images?)`
- `src/agent/loop.ts`: `run(userInput, callbacks, images?)` → 传透
- 验证：`npx tsc --noEmit` + context/loop 测试

### Task 3: Server 层 — manager + routes
- `src/server/session-manager.ts`: `run(id, prompt, images?)` + ManagedAgent 接口 + user event
- `src/server/session-routes.ts`: prompt 路由接受 images + 安全校验
- 验证：`npx tsc --noEmit` + session-routes 测试

### Task 4: 桌面前端 — client + queries + event-reducer
- `desktop/src/runtime/client.ts`: `sendPrompt(id, prompt, images?)`
- `desktop/src/state/queries.ts`: 穿透 images
- `desktop/src/state/event-reducer.ts`: user block 增加 imageCount
- `desktop/src/surfaces/ThreadView.tsx`: 渲染图片指示器
- 验证：`npx tsc --noEmit`

### Task 5: 桌面 UI — Composer 图片交互
- `desktop/src/components/Composer.tsx`: 粘贴/拖放/选择 + 预览 + 删除
- `desktop/src/styles.css`: 图片预览样式
- 验证：手动测试（粘贴图片、拖放、选择文件、删除、发送）

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| compaction 不认识 array content → 崩溃 | Task 1 中先修 token estimation；compaction 层（microCompactOai/semanticPrune）只处理 tool/assistant content（string），user content 只做 token 计数，不走 `.startsWith()` / `.includes()` 字符串方法 |
| base64 图片过大撑爆请求体 | 前端限制 5MB/张 + 最多 4 张；后端路由可选校验总大小 |
| rewind/rewind-points 假设 content 是 string | `listRewindPoints` 已有 `typeof m.content === 'string'` 守卫（`session-manager.ts` 第 ~400 行），array content 会被跳过——可接受（图片消息不太需要 rewind） |
| DeepSeek/GLM 不支持 vision → API 报错 | 这是 provider 能力问题，不在本 plan scope。用户若模型不支持会收到 API error，不影响系统稳定性 |
| Tauri capabilities 需要文件系统权限 | 本方案用浏览器 File API + FileReader + 剪贴板 API，不需要 Tauri 文件系统插件 |

## 7. 验证计划

1. **TypeScript**：每个 Task 后 `npx tsc --noEmit`
2. **单元测试**：
   - `context.ts`: addUserMessage 带 images → message content 是 array、token estimation 正确
   - `micro.ts`: estimateOaiMessageTokens 对 array content 返回合理值
   - `session-routes.ts`: prompt 路由正确解析 images + 拒绝非 data URL
3. **手动桌面测试**：粘贴截图 → 预览 → 发送 → 确认消息历史显示图片标记 → 确认 LLM 回复引用了图片内容
