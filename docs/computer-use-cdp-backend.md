# Computer Use：CDP 浏览器后端

> 2026-07-07 立项实现。零新依赖：Node 24 内置 `WebSocket` + `fetch`。
> 与 `src/tools/browser-debug/`（Playwright、无头调试）互不干扰。

## 为什么

macOS 真机数据（2026-07-06，AXEnhancedUserInterface 已启用）：Chrome 全量 AX 快照 17–36 秒（Apple Events 逐批走），导航靠 type 地址栏且不可靠。CDP 后端把同样的感知变成单次协议调用：

| 能力 | AX/UIA 原生驱动 | CDP 后端（真机实测） |
|---|---|---|
| Chrome 快照 | 17–36s | **118–287ms**（约 100×） |
| 网页点击 | AXPress，依赖窗口可见 | `Input.dispatchMouseEvent` 受信事件，**窗口被遮挡/后台也能操作** |
| 导航 | type 地址栏（不可靠） | `Page.navigate` 一步到位（真机 2.0s 含加载等待） |
| 页面全文 | 400 节点截断 | `read_page` innerText 全文提取 |
| JS 执行 / 多标签 | 无 | `js_eval` / `tabs`（Runtime.evaluate / Target 域） |
| 截图 | screencapture（需屏幕录制权限） | `Page.captureScreenshot`（免 OS 权限，后台窗口也能截） |

## 架构

```
computer_use tool.ts
 ├─ 浏览器目标 (chrome/chromium/edge/brave) + CDP 会话可建 → cdp/driver.ts CdpDriver
 ├─ 其他应用 / CDP 不可用 / menu_select → macOS AX / Windows UIA 原生驱动
 └─ RIVET_CU_CDP=0 → 全局禁用 CDP（纯原生）

cdp/client.ts   零依赖 CDP 客户端（内置 WebSocket，flat 模式 sessionId 路由，逐请求超时）
cdp/chrome.ts   Chrome 生命周期（发现/专用 profile 启动/attach 优先级/会话级单例）
cdp/driver.ts   CdpDriver：实现 ComputerUseDriver + 浏览器专属动作
```

核心设计：**`CdpDriver` 直接实现现有 `ComputerUseDriver` 接口**。refs 编码为 `path = [frameOrdinal, backendNodeId]`（ordinal 0 = 主 frame，OOPIF 子 frame 依快照序编号），点击前用 `Accessibility.getPartialAXTree` 做 role/name 身份校验，失败措辞与 macOS 驱动**逐字一致**（`stale snapshot — …`）——tool.ts 的 `healStaleRef` 自愈链、feedback 闭环、find/wait_for 零改动继承。

## attach 优先级（cdp/chrome.ts）

1. `RIVET_CU_CDP_URL` 显式端点（用户主动配置；探测失败会继续往下走，不 brick）
2. 专用 profile 的 `DevToolsActivePort` 文件（`~/.rivet/chrome-automation`）
3. 都没有 → 仅 `launch_app` / `navigate` / `tabs new` 允许启动专用实例（其余动作绝不 surprise 弹窗）

**`localhost:9222` 永不自动 attach**：用户自己开着调试端口的 Chrome 带着完整登录态（cookies/session），静默接管等于无审批拿走用户身份。接管唯一入口是显式 `browser_adopt` 动作，且审批为管线级无条件门（YOLO / allow 规则均不可豁免）。

专用实例：`--remote-debugging-port=0 --user-data-dir=~/.rivet/chrome-automation --no-first-run`，**可见窗口**（computer use 用户要看得见）。登录态在专用 profile 里跨会话持久——登录一次长期有效。退出不杀实例。

Chrome 136+ 封死默认 profile 的调试端口，所以不做用户默认 profile 接管；用户自带调试端口的 Chrome 走 `browser_adopt`（恒需审批）。

## 新动作（浏览器目标专属）

| 动作 | 说明 | 审批 |
|---|---|---|
| `navigate(app, url)` | URL / back / forward / reload；**仅 http/https**（file:/javascript:/data:/chrome: 拒绝） | 按 app 授权 |
| `read_page(app)` | innerText 全文（60k 字符上限），绕开 400 节点树上限 | 按 app 授权 |
| `js_eval(app, expression)` | `Runtime.evaluate` | **恒需审批**（管线级无条件门） |
| `tabs(app, tab_op, tab?, url?)` | list / activate / new / close；new 的 url 同 navigate 协议门 | 按 app 授权 |
| `browser_adopt(endpoint)` | 接管用户调试端口 Chrome | **恒需审批**（管线级无条件门） |

「恒需审批」由 `tool-pipeline` 的 `requiresUnconditionalApproval` 硬闸门强制——任何 approvalMode（含 `dangerously-skip-permissions`）、`permissions.allow` 规则、sensorium 自动放行都不能豁免；工具自身的 `requiresApproval()` 只是 manual 模式下的第一层。

其余动作（snapshot/find/wait_for/click/type/set_value/scroll/key/paste_text/focus_app/launch_app）经混合路由自动获得 CDP 加速，模型无感知。`menu_select` 恒走原生驱动（菜单栏是 OS 对象，CDP 看不见）。

## 实现细节

- **快照**：`Accessibility.getFullAXTree`（语义树）+ `DOMSnapshot.captureSnapshot`（布局矩形，按 backendNodeId 关联出 `@(x,y)`），输出与原生驱动逐字同构的 `[ref] role "title" = value @(x,y)` 树。`InlineTextBox`/`LineBreak` 布局碎片恒过滤（真机发现：逐行复读 StaticText 白烧 refs）。树顶 `Page: "title" — url` 头行（对应 macOS 的 `Menu bar:` 定位行）。
- **坐标系**：CSS 视口像素（snapshot pos / click x,y / locate 自洽）。与原生驱动的屏幕坐标不混用——同一 app 的动作要么全走 CDP 要么全走原生。
- **截图**：`Page.captureScreenshot`；vision 降采样用 clip.scale 让 Chrome 直接输出缩放图（跨平台，免 sips）。
- **type**：`Input.insertText` 快路径 + 换行处发真实 Enter 键事件；`paste_text` 直接 insertText（不碰 OS 剪贴板）。
- **set_value**：原型链原生 setter + input/change 事件（React/Vue 受控组件也能感知）；不可写时报错措辞与原生一致。
- **OOPIF**：`Target.setAutoAttach(flatten)` 自动挂跨进程 iframe，树合并（上限 3 个子 frame），输入直接派发到子 frame 会话。
- **JS 对话框**：自动处理（alert/beforeunload → accept，confirm/prompt → dismiss fail-closed），下一次快照头部带一次性说明行。
- **下载**：引导到 `~/.rivet/downloads`（`Browser.setDownloadBehavior`，best-effort）。

## 真机冒烟记录（2026-07-07, macOS）

```
available(launch) → 专用实例冷启动 10.1s（含 Chrome 启动 + DevToolsActivePort 等待；暖 attach <100ms）
navigate example.com        2.0s（含加载等待）
snapshot（含截图+vision）    118ms / 12 refs      ← AX 基线 17–36s
click "Learn more" (ref)    58ms → iana.org 正确跳转
post-click snapshot         287ms
read_page                   3ms / 1279 chars（iana.org 全文）
js_eval navigator.userAgent 2ms
tabs new + list             1.5s（含加载），active 标记正确
snapshot 400-ref 复杂页      146ms（终端前台、Chrome 后台时照常工作 = 遮挡不敏感）
```

## 开关与回退

- `RIVET_CU_CDP=0`：全局禁用，浏览器目标回落原生 AX/UIA（Chrome 也能被 AX 兜底操作，只是慢）。
- CDP 建连失败（无端点且不允许启动）：静默回落原生驱动。
- `RIVET_CU_CDP_URL`：显式端点覆盖（远程调试/容器场景）。

## 不做（记录）

- 不动 browser-debug（Playwright 底座继续服务无头调试场景）
- 不做用户默认 profile 接管（Chrome 136+ 封死；专用 profile 持久登录 + browser_adopt 已覆盖）
- 不做 console/network 日志捕获（browser-debug 已有）
- Linux 平台留作后续单独一轮（CDP 天然跨平台，chrome.ts 已留了 Linux 二进制候选）

## 已知限制

- `read_page` 不等加载：点击后立即读可能拿到空文本——先 `wait_for` 再读（与原生驱动同一纪律）。
- OOPIF 子 frame 无 `@(x,y)` 布局坐标（点击仍准确，走 getContentQuads）；跨 frame drag 坐标系不一致，避免。
- CDP 坐标是视口 CSS 像素，与原生驱动的屏幕像素不同——不要把 CDP 快照的坐标喂给原生驱动（路由保证了这不会发生，但手写坐标时注意）。
