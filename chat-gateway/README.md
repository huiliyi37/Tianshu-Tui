# 天枢 Chat Gateway

让天枢（Tianshu）通过微信、飞书接收消息并执行 Agent 任务的独立网关。

## 架构

```
微信 / 飞书
   │ webhook
   ▼
tianshu-chat-gateway（公网 HTTPS）
   │ HTTP+SSE / Bearer token
   ▼
rivet serve（127.0.0.1）
   │
RuntimeSessionManager → AgentLoop → tools/MCP/LSP
```

Gateway 本身不运行 Agent，只是把 IM 消息转成对 `rivet serve` 的 API 调用，并复用天枢的 session、记忆和工具链。

## 快速开始

### 1. 启动 rivet serve

```bash
rivet serve
```

默认监听 `http://127.0.0.1:41421`。可在 `.rivet-config.json` 或启动参数中修改端口。

### 2. 配置 gateway

创建 `~/.rivet/chat-gateway.json`：

```json
{
  "publicUrl": "https://your-gateway.example.com",
  "rivet": {
    "baseUrl": "http://127.0.0.1:41421",
    "token": "your-rivet-sidecar-token",
    "cwd": "/path/to/your/project"
  },
  "security": {
    "allowlist": ["feishu:ou_xxx", "wechat:openid_xxx"]
  },
  "feishu": {
    "enabled": true,
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "encryptKey": "xxx",
    "verificationToken": "xxx"
  },
  "wechat": {
    "enabled": true,
    "appId": "wx_xxx",
    "appSecret": "xxx",
    "token": "your-wechat-token",
    "kind": "official"
  }
}
```

### 个人微信（experimental）

```json
{
  "wechat": {
    "enabled": true,
    "kind": "personal",
    "groupTriggerPrefix": "@天枢 ",
    "puppet": "wechaty-puppet-wechat4u"
  }
}
```

启动后会打印二维码链接，用微信扫码登录。群聊里只有被 @ 或消息以 `@天枢 ` 开头才会触发。

或用环境变量（见 `.env.example`）。

### 3. 运行 gateway

```bash
cd chat-gateway
npm install
npm run dev
```

### 4. 配置 IM 平台 webhook

- **飞书**：事件订阅 URL 填 `https://<gateway>/webhook/feishu`，订阅 `im.message.receive_v1`。
- **微信公众号**：服务器 URL 填 `https://<gateway>/webhook/wechat`，令牌填配置中的 `token`。

## 安全

- 默认 `approvalMode: manual`，写文件 / bash / git 等操作需要确认。
- 危险操作会通过 IM 发送确认链接，点击后 gateway 回调 `rivet serve` 的 intervention 接口。
- 仅响应 `security.allowlist` 中的发送者。
- 不支持通过聊天端设置 `dangerously-skip-permissions`。

## 限制

- 支持微信公众号/企业微信官方 webhook。
- **个人微信（experimental）**：通过 Wechaty 接入，默认使用开源的 `wechaty-puppet-wechat4u`（网页协议）。
  - ⚠️ 个人微信号自动化违反微信用户协议，存在封号风险，仅供实验/自托管使用。
  - 网页协议不稳定，很多账号无法登录或几天后被踢下线；可在配置中切换其他 puppet。
- 长回复会自动分块发送。
- 会话绑定按 `platform + conversation + sender` 维度持久化在 SQLite 中。
