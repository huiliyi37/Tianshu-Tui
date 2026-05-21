# Wave 1 任务文档：安装体验

> 任务编号：W1-03
> 优先级：高
> 预估：单 session，1 小时
> 前置依赖：#02 (multi-provider)

## 目标

`npx tianshu` 一步启动。首次运行引导用户完成配置（选择 provider、输入 API key）。5 分钟内完成首次任务。

## 设计

### 首次启动流程

```
$ npx tianshu

  ╭─────────────────────────────────────╮
  │  天枢 — Terminal Coding Agent       │
  │  v3.0.0                             │
  ╰─────────────────────────────────────╯

  首次配置：

  ? 选择 AI 提供商:
    ❯ DeepSeek (推荐 — prefix cache 优化)
      Anthropic (Claude)
      OpenAI (GPT)
      自定义 (OpenAI 兼容 endpoint)

  ? API Key: sk-***************

  ? 测试连接... ✓ 连接成功 (DeepSeek V4, 1M context)

  配置已保存到 ~/.tianshu/config.json
  项目文件: .rivet.md (可自定义项目规则)

  开始使用：直接输入你的任务。
```

### 配置文件

```
~/.tianshu/
├── config.json          全局配置（provider, apiKey, model）
├── sessions/            会话持久化
└── memory/              跨项目记忆
```

### package.json

```json
{
  "name": "tianshu",
  "bin": { "tianshu": "./dist/main.js" },
  "engines": { "node": ">=22" }
}
```

## 实现计划

### Task 1: CLI 入口重构

修改 `src/main.tsx`：
- 检测是否存在 `~/.tianshu/config.json`
- 不存在 → 进入 setup wizard
- 存在 → 正常启动

### Task 2: Setup wizard

创建 `src/config/setup-wizard.tsx`（Ink 组件）：
- Provider 选择（select）
- API key 输入（password input）
- 连接测试（发送一个最小请求验证 key 有效）
- 写入配置文件

### Task 3: 配置路径统一

修改 `src/config/manager.ts`：
- 统一配置目录为 `~/.tianshu/`
- 兼容旧的 `~/.rivet/` 路径（自动迁移）

### Task 4: package.json 发布配置

- `bin` 字段指向 `dist/main.js`
- `files` 字段只包含 `dist/`
- `engines` 限制 Node.js >= 22
- 确认 `tsup.config.ts` 输出正确的 shebang

### Task 5: 测试

- setup wizard 组件测试（模拟用户输入）
- 配置文件读写测试
- 首次启动 → setup → 正常启动的完整流程

## 验证

```bash
npx tsc --noEmit
npm run build
node dist/main.js  # 应进入 setup wizard（删除 config 后）
```

## 不做的事

- 不发布到 npm（等 Wave 1 全部完成后统一发布）
- 不做 auto-update
- 不做 telemetry opt-in（后续迭代）
