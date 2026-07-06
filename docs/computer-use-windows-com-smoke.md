# Computer Use — IUIAutomation COM 路径 Windows 真机冒烟清单

> 适用版本：`windows-uia-com.ts` 引入的 UIA3 COM 原生路径（2026-07-07）。
> **vtable 转写的正确性只能在真机验证** —— ComImport 槽序照 Win7 SDK
> `UIAutomationClient.h` 逐一转写，任何槽位错位都会表现为调错方法 / 访问冲突 /
> 返回垃圾数据。本清单即该轮工作的验收标准：全部通过才视为 COM 路径可用；
> 任何一项崩溃或行为异常 → 记录现象，用 `RIVET_CU_COM=0` 回退，回传日志。

## 背景

| | managed（现状回退路径） | COM（新路径） |
|---|---|---|
| 客户端 | .NET `System.Windows.Automation` | 原生 `IUIAutomation`（UIAutomationCore） |
| Chromium 网页树 | ❌ 只有 MSAA 桥接的残缺内容 | ✅ 连接即触发完整无障碍树 |
| 树遍历 | PS 解释器逐节点函数调用 | C# 循环 + `FindAllBuildCache` 每父一次 |
| JSON | `ConvertTo-Json`（单元素解包 quirk） | C# 手工序列化 |

路径选择：会话内首个 UIA 动作前跑一次 probe（编译 prelude + 实例化
CUIAutomation8/CUIAutomation + 读 RootElement.Name）。probe 失败 → 整个会话走
managed，行为与本轮之前完全一致。`RIVET_CU_COM=0` 直接禁用 COM。

## 冒烟步骤

每步在 Rivet 会话里通过 `computer_use` 工具执行。先决条件：Windows 10/11，
PowerShell 5.1（系统自带），目标应用未以管理员运行。

### 0. probe 是否命中 COM

- [ ] 任意 UIA 动作（如 `list_apps`）后，检查会话内是否只发生一次 probe。
  快速验证可直接在 PowerShell 里粘贴 prelude 后跑 `[RivetUia]::Probe()`，
  期望输出 `com-ok:<桌面名>`。
- [ ] 输出以 `com-ok:` 开头 → COM 生效；抛错 → 记录完整错误文本
  （Add-Type 编译错误 = C# 语法/兼容性问题；`COMException` = CLSID/接口问题）。

### 1. 记事本基线（vtable 正确性的第一道验证）

- [ ] `launch_app` notepad → 窗口出现并前台
- [ ] `snapshot` notepad → 树含 `Window`/`Edit`/`MenuBar` 等角色、标题正确、
  截图正常；**任何乱码角色名 / 空树 / 崩溃 = vtable 槽位错位，立即回退**
- [ ] 对比耗时：`RIVET_CU_COM=0` 下同一 `snapshot` 的耗时（期望 COM 明显更快，
  记录两组数字）
- [ ] `click` 菜单项 → InvokePattern 快路径生效
- [ ] `type` + `key`（ctrl+a、ctrl+c）→ 输入合成正常（走 RivetInput，与 COM 无关，
  验证 ResolveHwnd 给的焦点正确）

### 2. stale 自愈语义

- [ ] snapshot 后手动改变 UI（关掉一个面板），用旧 ref `click` →
  错误消息以 `stale snapshot -` 开头且工具层自动 re-snapshot 重试
  （与 managed 路径措辞逐字一致）

### 3. Chrome 网页树（本轮的能力差核心）

- [ ] 打开 Chrome 任意网页 → `snapshot` chrome → 树里能看到**网页内容**
  （链接/按钮/文本，而不只是浏览器 chrome 外壳）
- [ ] 若首次 snapshot 网页树为空：等 2-3 秒重试一次（Chromium 检测到 UIA
  客户端后才开始构建完整树）；仍为空则记录 Chrome 版本
- [ ] 对照：`RIVET_CU_COM=0` 时同一页面的树（期望明显残缺）——这组对比数据
  是本轮收益的直接证据

### 4. Calculator（UWP / ApplicationFrameHost）

- [ ] `list_apps` → Calculator 以窗口标题出现
- [ ] `snapshot` Calculator → 树正常（UWP 窗口经 UIA Name 回退解析）
- [ ] `click` 数字按钮 → InvokePattern 生效，结果区更新

### 5. set_value / menu_select

- [ ] 对 Edit 控件 `set_value` → 文本直写成功；对只读控件 → 错误措辞为
  `element does not accept direct value writes - click it and use type/paste_text instead`
- [ ] `menu_select` notepad ["File","Save As…"]（按系统语言用本地化菜单名）→
  逐级展开并触发；错误路径列出可用项

### 6. 回退演练

- [ ] 设 `RIVET_CU_COM=0` 重启会话 → 所有动作走 managed 路径且行为正常
  （日志中不出现 `RivetUia`）
- [ ] （可选）模拟 probe 失败：临时改坏 CLSID → 会话自动落回 managed，
  动作不受影响

## 已知边界（真机确认时留意）

- 提权（管理员）进程的窗口无法被非提权的 PowerShell 自动化——两条路径同样受限
- `RivetUiaRect` 结构体按值返回依赖 CLR 的 hidden-return-buffer 约定，
  x64 已知安全；若在 ARM64 Windows 上跑，`get_CachedBoundingRectangle`
  是最先怀疑对象
- CUIAutomation8 CLSID 在 Win8+ 注册；Win7 落回 CUIAutomation（无 provider
  隔离超时，个别挂死的应用可能拖慢 snapshot）

## 结果记录

| 项 | 结果 | 备注（耗时/错误文本） |
|---|---|---|
| probe | | |
| 记事本 snapshot（COM vs managed 耗时） | | |
| stale 自愈 | | |
| Chrome 网页树 | | |
| Calculator UWP | | |
| set_value / menu_select | | |
| RIVET_CU_COM=0 回退 | | |
