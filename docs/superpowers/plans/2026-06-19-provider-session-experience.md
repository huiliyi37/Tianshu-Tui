# Provider 与会话体验优化

> 2026-06-19 · P0–P6 全部交付

## 目标

统一 provider 注册体系，补齐桌面端 provider 管理 UI 与会话交互能力，使 TUI 和 Desktop 在多模型/多 provider 场景下体验对齐。

## 交付清单

### P0: Provider Registry 统一

**问题**: `PROVIDER_PRESETS`、`WELL_KNOWN_DEFAULTS`、`PROVIDER_REGISTRY`、`PROFILES` 四套表之间存在漂移——`mimo-api` 和 `claude` 在部分表中缺失，运行时走 fallback 默认值。

**修复**:
- `provider.ts`: 补齐 `mimo-api` 的 `WELL_KNOWN_DEFAULTS`（supportsThinking、thinkingFormat、prefixCacheStrategy）
- `provider-registry.ts`: 新增 `mimo-api` 和 `claude` 的 `PROVIDER_REGISTRY` 条目
- `provider-profile.ts`: 新增 `mimo-api`（exact-prefix cache）和 `kimi`（none cache）的 `PROFILES`
- `provider-registry.test.ts`: 3 个跨表一致性守护测试，杜绝未来漂移

### P1: Desktop Settings Provider 页

**新增**:
- `server/config-routes.ts`: GET/POST/DELETE provider + set API key + set default 共 5 个路由
- `runtime/client.ts`: 5 个前端 API 函数
- `components/ProviderSettings.tsx`: 完整 CRUD UI（已配置 provider 列表 + 未配置 preset 卡片 + API key 输入）
- `surfaces/SettingsSurface.tsx`: 嵌入 ProviderSettings 组件
- `styles.css`: provider 设置区域样式

### P2: 运行中模型切换

**改进**:
- `components/PlusMenu.tsx`: model apply 时检查 `sessionRunning`，先 abort 再 switch（对齐 TUI 行为），避免 409 静默失败
- `components/Composer.tsx`: 传递 `sessionRunning={busy}` 到 PlusMenu
- `surfaces/ThreadView.tsx`: 线程头新增 `model-chip` 显示当前模型名

### P3: Desktop 命令面板扩展

**改进**:
- `surfaces/ThreadView.tsx`: slash 命令从 7 条扩到 20 条，新增 `/plan`、`/team`、`/interview`、`/compact`、`/memory`、`/context`、`/verify`、`/mission`、`/debug cache`、`/constellation`、`/dream`、`/sensorium`、`/review`——均为 prompt-based，无需新增后端路由

### P4: TUI First-run 引导

**改进**:
- `main.ts`: `bootstrapInteractiveSession` 调用包裹 try/catch；检测到 API key 缺失时自动启动 `provider-wizard` 交互引导，完成后重试启动，避免直接 crash

### P5: 归档会话恢复 + 会话搜索

**新增**:
- `session-manager.ts`: `listAllSessions()` 方法（含归档会话）
- `session-routes.ts`: `GET /sessions?includeArchived=true` 支持
- `runtime/client.ts`: `listAllSessions()` 前端函数
- `surfaces/ProjectSidebar.tsx`: 底部「显示归档会话」按钮 + 归档列表 + 恢复按钮
- 侧边栏已有的 filter input 支持标题/ID/phase 搜索（P0 前已存在）

### P6: Provider Fallback Chain

**新增**:
- `api/fallback-client.ts`: `FallbackStreamClient`——primary client 抛出可恢复错误（rate_limit / server_error / overloaded / timeout / connection_error / stream_error）后，依次尝试 `fallback` 列表的 provider；auth_error / client_error 不触发 fallback
- `agent/create-agent-config.ts`: `buildFallbackChain()` 根据 `provider.fallback` 构建包装层；`allProviders` 透传到 `AgentConfigInput`
- `bootstrap.ts`、`serve.ts`、`main.ts`: 所有调用点传入 `allProviders`
- `api/__tests__/fallback-client.test.ts`: 7 个测试覆盖成功直通、server error fallback、auth 不 fallback、多级链顺序、全部失败、abort 传播、委托方法

## 配置示例

```yaml
provider:
  default: deepseek
  providers:
    deepseek:
      name: deepseek
      baseUrl: https://api.deepseek.com/v1
      apiKeyEnv: DEEPSEEK_API_KEY
      fallback: [mimo-api]   # P6: 当 deepseek 不可用时自动尝试 mimo-api
      models:
        - id: deepseek-r1
          contextWindow: 1000000
          maxTokens: 65536
    mimo-api:
      name: mimo-api
      baseUrl: https://api.mimo.com/v1
      apiKeyEnv: MIMO_API_KEY
      models:
        - id: mimo-pro
          contextWindow: 256000
          maxTokens: 32768
```

## 测试验证

- typecheck 零错误
- provider-registry: 36 tests pass（含 3 个跨表一致性守护）
- provider-profile: 全绿
- fallback-client: 7 tests pass
- create-agent-config: 9 tests pass
- session-routes: 37 tests pass

## 遗留项

- 归档列表当前是按需加载（点击按钮），可考虑改为 tab 切换或虚拟滚动
- Fallback 发生时无用户侧通知（onFallback 回调未接入 toast/advisory bus）
- Desktop slash 命令未做 fuzzy autocomplete（当前是精确前缀匹配）
