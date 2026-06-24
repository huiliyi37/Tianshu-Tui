# Overlay Deactivate Ghost Rendering — 诊断与修复记录

> 反复出现的 bug：domain/model/theme picker 切换后输入框 ghost / 消失 / 跑到屏幕顶部。

## 问题三态

| 症状 | 根因 | 修复 commit |
|------|------|------------|
| Ghost rendering（旧帧残留） | picker Enter 里先 deactivate 再 exec，exec 的 forceRedraw 画第二帧叠在 deactivate 的帧上 | `314c54f2` / `bb6a9329`：exec-before-deactivate |
| 输入框消失 | deactivateOverlay 用 renderLive() 走 append 路径，但 lastDisplayRows=0 + hasRendered=false 时光标位置不可靠 | `a169152b` / `c8acfec9`：deactivate 后全屏擦除 |
| 输入框跑到屏幕顶部 | deactivateOverlay 用 `\x1B[999A`（cursorUp 999）回顶 + 全屏擦除，renderLive 从顶部 append | `e6ba2a27`：改为 `\r\x1B[0J`（行首+擦到行尾），不回顶 |

## 正确的 deactivateOverlay 实现

```typescript
deactivateOverlay(): void {
  this.overlay.deactivate()       // 退出 alt screen，恢复主屏
  this.stdout.write('\r\x1B[0J')  // 清当前行残留（光标在 scrollback 末尾）
  this.live.reset()               // hasRendered=false, lastDisplayRows=0
  this.renderLive()               // append 新帧在正确位置
}
```

## 为什么这样工作

1. `activateOverlay` 进 overlay 前调用 `live.clear()`：擦除旧 live region，光标定位到 scrollback 末尾，`lastDisplayRows=0`
2. Overlay 使用 alt screen（`\x1B[?1049h`），主屏内容冻结
3. `overlay.deactivate()` 退出 alt screen（`\x1B[?1049l`），主屏恢复，光标回到步骤 1 的位置（scrollback 末尾）
4. `\r\x1B[0J` 清除当前行可能的残留字符（某些终端 alt screen 退出后当前行有杂散字符）
5. `live.reset()` 确保 render 走 append 路径（不从 lineCache diff）
6. `renderLive()` 在当前光标位置（scrollback 末尾 = 屏幕底部）append live region

## picker Enter 的正确顺序

```typescript
// domain/model/theme picker Return handler
if (key.name === 'return') {
  const entry = /* ... */
  if (entry && this.overlayController.getDomainPickerExec()) {
    this.overlayController.getDomainPickerExec()?.(entry.key)  // 先 exec
  }
  this.deactivateOverlay()  // 后 deactivate
  return true
}
```

exec 先运行（在 alt screen 还激活时，状态更新 + forceRedraw 画在 alt screen 上不影响主屏），然后 deactivateOverlay 最后运行（退出 alt screen → 擦除 → 干净 append）。

## 测试

`src/tui/engine/__tests__/overlay-deactivate-regression.test.ts` 锁定五种场景：
- deactivate 后只有一个输入框（无 ghost）
- 不使用 cursorUp(999)（不会跑到顶部）
- deactivate 后输入提示符 `〉` 存在（不消失）
- 连续 3 次 activate/deactivate 不累积 ghost
- 双重 deactivate 不崩溃

## 历史修复序列

- `314c54f2` — swap exec/deactivate order
- `c8acfec9` — erase full screen on overlay deactivate
- `a169152b` — forceRedraw on overlay deactivate
- `bb6a9329` — restore exec-before-deactivate（314c54f2 的回归修复）
- `03f73669` — restore full-screen erase（c8acfec9 的回归修复）
- `e6ba2a27` — fix cursor positioning（03f73669 的 cursorUp(999) 问题修复）

## 规则

**改 deactivateOverlay 或 picker Enter handler 前，必须跑 `overlay-deactivate-regression.test.ts`。**
