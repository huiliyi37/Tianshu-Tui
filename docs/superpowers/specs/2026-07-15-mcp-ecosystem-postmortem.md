# MCP 生态对标增强 — 事后分析

> 2026-07-15 · 天枢/天权域 · 4 波 22 文件 +1123/-94 · 64 测试绿

## 缺陷清单

### W1 — Transport Factory (ba1aac9b)

| # | 类别 | 描述 | 根因 |
|---|------|------|------|
| 1 | 类型 | `TransportFactoryResult` vs `TransportResult` 导入名不匹配 | 接口更名后未更新消费方 |
| 2 | 类型 | `DEFAULT_MCP_TIMEOUT_MS` 在 transport-factory 未定义 | 常量从 manager 迁出但未在 factory 中定义 |
| 3 | 类型 | `timeoutMs` required 但调用方不传 | TransportFactoryOptions 标记错误 |
| 4 | 类型 | `onclose` 类型缺失，manager 赋值时 TS2551 | TransportResult.transport 类型未扩展 |
| 5 | 运行时 | reconnect timer 未保存，shutdownServer 时可能重连泄漏 | 遗漏 timer handle 管理 |
| 6 | 文档 | `_connectAndDiscover` 重试注释过时 | 重构后未同步注释 |

### W2 — OAuth Connector (1d1ab945)

| # | 类别 | 描述 | 根因 |
|---|------|------|------|
| 1 | 运行时 | `tokenStore(serverId).delete()` — TokenStore 无此方法 | 未读 TokenStore 的 API（实际是 `clear()`） |
| 2 | 数据 | `loadMcpOAuthToken` 返回空 provider/scopes | TokenData 不存元数据，未设计伴生存储 |
| 3 | 架构 | OAuth token 未接到 transport — 端到端未通 | `_connectServer` 只传静态 cfg.headers，未读 cfg.auth |
| 4 | 设计 | `startMcpOAuth` 同步阻塞 REST 路由 | 未分离 authUrl 返回和 callback 处理 |
| 5 | 鲁棒 | provider 大小写敏感 | 未做 toLowerCase() 兜底 |

### W3 — Tool Toggle (3b4d1bf2)

| # | 类别 | 描述 | 根因 |
|---|------|------|------|
| 1 | 类型 | schema `.default([])` 导致测试类型推断失败 | zod default 影响的类型传播 |

### W4 — Log Viewer (ca8660cf)

| # | 类别 | 描述 | 根因 |
|---|------|------|------|
| 1 | 运行时 | `/mcp logs` 导入不存在的 `./engine/app.js` ctx | 从其他上下文错误复制导入路径 |
| 2 | 类型 | `entries.map(e => ...)` — `e` 隐式 any | 未标注回调参数类型 |

### 跨 Wave 缺陷

| # | 类别 | 描述 | 根因 |
|---|------|------|------|
| 1 | 类型 | `ConnectedServer` 加 `transportType` 后 13 处测试 mock 过期 | 接口变更后未 grep 搜索所有消费方 |
| 2 | 构建 | `getStates()` 重复定义 (hash_edit 插入 bug) | 编辑工具锚定偏移 |
| 3 | 构建 | write_file 内容被截断后用 placeholder 重试 | 工具输出格式误认为输入格式 |

---

## 系统性根因

### 主因：`tsc` 假绿灯

**证据**：在 `transport-factory.ts` 末尾追加 `const _x: number = 'string'`（类型错误），`npx tsc --noEmit` 仍然 exit 0。`tsc --listFiles` 不包含 `src/mcp/` 下的文件。

**机制**：`tsconfig.json` 使用 `moduleResolution: "bundler"`。该模式在特定条件下会跳过类型检查某些文件——尤其是通过 `import type` 间接引用的模块。本项目 `src/mcp/` 的消费者（`server/serve-agent.ts`、`tui/cockpit/state.ts`）均使用 `import type { McpManager }`，导致整个模块链未被 tsc 跟踪。

**影响面**：所有类型错误、接口不匹配、缺失属性——本该在编辑后 10 秒内被拦截的 15+ 个错误——全部漏到运行时和人工审查。每次我跑 `tsc --noEmit` 看到 "✓ typecheck passed" 就以为安全，实际上 tsc 根本没看这些文件。

### 次因

| 因 | 症状 | 频率 |
|----|------|------|
| 接口变更后未全链路 grep | 测试 mock 过期、类型断裂 | 6 次 |
| 未读 API 就调用 | `delete()` vs `clear()` | 1 次 |
| hash_edit 锚定偏移 | 代码重复/错位 | 1 次 |
| write_file placeholder 误用 | 文件写入失败/乱码 | 2 次 |
| 跨上下文复制代码 | 不存在的导入路径 | 1 次 |

---

## 修补方向

### 立即可做（工具链层）

1. **修 tsconfig** — 从 `moduleResolution: "bundler"` 切到 `"node16"` 或 `"nodenext"`。该变更影响面大（所有 `.js` 后缀导入需适配），但这是让 tsc 真正工作的前提。若短期不能切，至少要加一个 **pre-commit 独立 typecheck**：用 `tsc --noEmit --project tsconfig.strict.json`（单独的 tsconfig，`moduleResolution: "node16"`，只检查 `src/` 排除测试，作为快速门禁），或启用 `tsup` 构建时的类型检查（当前 build 警告重复 `getStates` 就是在构建阶段而非 typecheck 阶段发现的）。

2. **测试文件纳入类型检查** — 当前测试通过 `tsx` 直接运行，不经 tsc。可考虑用 `tsc --noEmit --project tsconfig.tests.json` 在 CI 中独立检查测试文件。

### 可加的事后防线

3. **接口变更 checklist** — 每次改 `interface` / `type` 后，grep 项目所有引用处（`lsp_find_references` 或 `grep`），确认消费方已更新。记录为 memory claim。

4. **依赖库 API 先读后调** — 调用外部 API（TokenStore、SDK transport）前，`grep` 确认方法签名（`clear` vs `delete`）。这次文件已在本项目内，不是外部库——更不应该跳过。

5. **编辑后自验证** — 编辑完成后立即运行受影响的测试文件（`run_tests(filter="xxx.test.ts")`），不等整波结束。W1-W4 的模式是整波写完才跑测试，中间积累的错误靠后续审查发现。

### 不修（已知限制）

6. `moduleResolution: "bundler"` 是 tsup/esbuild 生态的标准选择，本项目使用 tsup 构建，切换到 `node16` 可能破坏构建流程。需要评估兼容性后再决定。

7. hash_edit 锚定偏移是工具的固有边界——连续编辑同一文件时行号会偏移。规避方式是：连续 2 次编辑同一文件后，用 `read_file` 刷新状态再编辑。
