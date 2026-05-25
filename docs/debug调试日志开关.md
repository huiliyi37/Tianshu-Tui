# Debug 调试日志开关

## 说明

控制 TUI 启动时的调试日志输出。默认关闭，需要调试时手动启用。

受影响的日志：
- `[token-gate]` — token 预算和上下文窗口检查
- `[persist]` — 消息持久化记录
- `[artifact-intercept-skip]` — artifact 拦截跳过记录

## 启用调试日志

```bash
# 方式 1：环境变量
RIVET_DEBUG=1 node dist/main.js

# 方式 2：环境变量（true）
RIVET_DEBUG=true node dist/main.js

# 方式 3：npm 脚本中
RIVET_DEBUG=1 npm run dev
```

## 关闭调试日志

```bash
# 默认行为，无需设置
node dist/main.js

# 或显式关闭
RIVET_DEBUG=0 node dist/main.js
```

## 相关文件

- `src/utils/debug.ts` — debug 工具模块
- `src/agent/loop.ts` — token-gate 和 persist 日志
- `src/agent/tool-pipeline.ts` — artifact-intercept 日志

## 添加新的调试日志

```typescript
import { debugLog } from '../utils/debug.js'

// 替换 console.warn
debugLog('[your-tag] message', data)
```