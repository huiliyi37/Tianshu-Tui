# 2026-07-14 — 桌面端 401 认证风暴：超时改动漏传 Authorization

日期：2026-07-14（整整一下午）
范围：`desktop/src/runtime/client.ts`（根因）+ 一串症状向提交
状态：根因已修、回归测试已钉；症状向提交可保留（无害），工作区 debug 残留已清

## 现象

桌面端启动后持续报认证错误（401 Unauthorized），无法正常开新线程 / 拉 sessions。
表面看起来像 sidecar 没起来、token 对不上、Rust↔Node 握手坏了——一整下午都在那条线上打转。

## 事故起点（引入回归的提交）

`10162a64`（14:50）`fix(desktop): add 15s default timeout to rivetFetch`

本意正确：sidecar 卡住时 `fetch` 永不返回，UI 卡在「添加中…」。给 `rivetFetch` 加了
默认 15s `AbortController` 超时。

重构时把：

```ts
res = await fetch(url, { ...init, headers })
```

改成了：

```ts
const mergedInit = { ...init }          // 只展开了 init
mergedInit.signal = ac.signal
res = await fetch(url, mergedInit)      // headers 被丢掉
```

`headers` 里刚设好的 `Authorization: Bearer <token>` **构造了但从未传给 fetch**。
从此桌面端每一个 API 请求（`/sessions`、`/tasks`、`/environment`…）都以无 Bearer
身份打到 sidecar → 全局鉴权中间件一律 401。

`/health` 最初也要鉴权，所以连健康探针一起红；UI 表现为「sidecar 未启动 / 正在重连」
或认证失败，极易误判成进程/端口/token 问题。

## 一下午的症状向提交链（按时间）

| 时间 | 提交 | 在治什么 | 评价 |
|------|------|----------|------|
| 14:50 | `10162a64` | 加超时 | **引入根因**（漏传 headers） |
| 14:57 | `c3757edb` | `ready===false` → `ready!==true`，fatal banner | 症状：invoke 失败时的 banner 文案 |
| 15:19 | `6115b1f7` | fnm Node 路径探测 | 独立真问题（Dock 启动无 PATH），与 401 无关 |
| 16:15 | `e13babec` | `/health` 免鉴权 | 绕开了「健康探针也 401」——根因仍在 |
| 16:17 | `46ca51ce` | `/health` 用 `startsWith` | 上一条的正确补丁 |
| 16:24 | `f51ba5d1` | mount 时 `clearRuntimeCache()` | 治 HMR 脏 token——有道理，但不是主因 |
| 未提交 | 大量 `/tmp` 日志、`console.log`、lib.rs eprintln | 取证 | 必要，但事后要清 |

旁路修复里，`/health` 免鉴权与 mount 清 cache **可以保留**（冷启动窗口、Vite HMR
脏缓存都是真实场景）。它们不是根治，却是合理的防御纵深。

## 处置方法（系统排查，非猜）

### 1. 先读证据，不先改代码

- `git log -- desktop/` + `git diff`：锁定今天下午改动面
- `/tmp/rivet-runtime-info.log`、`/tmp/rivet-server-requests.log`：Rust 侧 token
  与请求侧 Bearer 前缀曾对齐（说明「token 错乱」不是主故事）
- 对照 HEAD 与 parent 的 `rivetFetch`：**一行 diff 暴露 headers 丢失**

### 2. 用 git blame / show 钉死引入点

```bash
git show 10162a64 -- desktop/src/runtime/client.ts
# - res = await fetch(..., { ...init, headers })
# + res = await fetch(..., mergedInit)   # mergedInit 无 headers
```

「改 timeout 时顺手改了 fetch 参数结构」——经典的**不相关重构引入回归**。

### 3. 最小修复 + 回归测试钉住

修复（一行）：

```ts
const mergedInit: RequestInit = { ...init, headers }
```

回归测试（`client.test.ts`）：stub `fetch`，断言 `init.headers` 含
`Authorization: Bearer …`。注释写明对应提交 `10162a64`，防止下次 timeout/信号
合并再漏。

### 4. 清理，不把 debug 当交付

撤回工作区里的 `/tmp` 写文件、`console.log` 洪水、lib.rs 诊断 eprintln。
取证用过的探针可以进正式可开关诊断，但不应以半成品状态留在主干路径。

## 根因 vs 假说对照（学习用）

| 假说 | 为什么像真的 | 为什么不是根因 | 证据 |
|------|--------------|----------------|------|
| sidecar 没 spawn / Node 找不到 | `ready=false`、banner 红 | 日志里服务已在听、且有请求到达 | `rivet-server-requests.log` 持续有 GET |
| token 过期 / HMR 脏缓存 | 重启后偶发好、清 cache 像有用 | 无 Bearer 时任何 token 都没用 | HEAD 的 fetch 根本不带 headers |
| 鉴权中间件太严 | `/health` 也 401 | 放开 health 后 sessions 仍 401 | health bypass 后错误迁到业务路由 |
| Rust↔前端 runtime_info IPC 坏了 | invoke 失败会走空 token fallback | 成功路径下 token 长度/前缀正常 | `runtime-info.log` 48 字符 token |

**判断口诀**：请求日志里若出现 `auth=NONE` 或鉴权失败且 `got_len=0`，优先查
**客户端有没有把 header 送出去**，再查 token 是否匹配。

## 复盘要点（可复用）

1. **重构 fetch/init 时，headers / signal / body 必须显式合并进最终 init。**
   展开 `{ ...init }` 再改 `signal`，很容易忘掉旁边刚构造的 `headers` 变量。
2. **「加超时」是无关重构高危区。** 行为目标（AbortController）与传输契约
   （Authorization）正交——改 A 时碰 B，必须有断言钉住 B。
3. **401 先分「没带证」vs「证不对」。** 缺 Bearer 与错 Bearer 的处置完全不同；
   前者看客户端组装，后者才看 sidecar 环境变量 / 缓存。
4. **症状修复可以保留，但不要当成结案。** `/health` 免鉴权、清 cache、fatal banner
   都改善了体验，却让「好像越修越复杂」；结案标准是：用生产序列写红→绿回归。
5. **取证要可丢弃。** `/tmp` 日志、eprintln 是 Phase 1 工具；根因落地后清理，
   避免下一次启动被诊断噪声淹没。
6. **系统排查顺序**：读错信息 → 对最近 diff → 边界日志（谁发了什么）→ 单点假设 →
   最小验证。不要在 sidecar / PATH / 鉴权策略三条线同时开枪。

## 验证

- `npm exec -- tsx --test desktop/src/runtime/__tests__/client.test.ts` → 21/21 绿
- 人工：重启桌面端后不再刷 401，可开新线程（用户确认 19:38）

## 相关文件

- 根因/修复：`desktop/src/runtime/client.ts`（`rivetFetch`）
- 回归：`desktop/src/runtime/__tests__/client.test.ts`
- 旁路（可留）：`src/server/index.ts`（`/health` bypass）、`desktop/src/App.tsx`（mount 清 cache）
