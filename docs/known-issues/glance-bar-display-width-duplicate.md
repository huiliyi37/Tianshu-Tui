# GlanceBar 重复渲染 — display-width 度量错误（已修复）

**状态:** ✅ 已修复
**修复日期:** 2026-06-11(t9-ui-refactor 分支)
**涉及文件:** `src/tui/format/glance-bar.ts`、`src/tui/engine/live-engine.ts`(机理)

## 症状

GlanceBar 状态行(`⚙ 天枢 (branch) ┃ · idle ┃ model ctx% ◧ x/y ┃ … elapsed`)在
scrollback 里留下一份**陈旧副本**(顶部那份还显示切换前的旧模型名),底部 live 区
另有一份在实时更新 → 看起来整条 chrome 重复。

## 根因

`glance-bar.ts` 的 `stripAnsiLen()` 用 `.length`(JS code units)度量宽度,而非
display width。CJK(`天枢`)/全角符号每字符 `.length=1` 但终端渲染占 **2 列**。

后果:padding/截断按 code-unit 欠估 → 状态行被撑到 `width+1`(实测 80 列终端上
`stringWidth=81`,CJK 域名时高达 92)→ 落入**末列自动换行临界** → 终端把一行
换成两行,而 `LiveEngine.rowsForLine()`(用 `stringWidth`)与终端实际换行错位
→ `clear()/clearForCommit()` 的 `moveToTop` 上移行数不足 → 欠擦 → chrome 顶部
残留行被后续 commit 永久顶进 scrollback。

## 修复

`stripAnsiLen()` 改用 `string-width` 度量 display width:

```ts
function stripAnsiLen(s: string): number {
  return stringWidth(s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}
```

修复后状态行严格 ≤ `width-1`(实测降回 79/80),永不触发末列换行。

## 不变量(防回归)

**底部 chrome 的每一行 display width 必须 ≤ 终端宽度-1**,否则 LiveEngine 的
增量擦除行数计算会与终端实际换行错位,产生 ghost / 重复。回归测试见
`src/tui/__tests__/format-glance.test.ts` 的 "status line display-width never
exceeds terminal width" 与 "wide CJK domain names" 两条。

> 残留风险:个别 ambiguous-width 字形(`⚙ ◐ ◧`)在某些终端字体渲染为 2 列而
> `string-width` 计 1 列。当前 chrome 留了 1 列安全边距吸收;若未来再现局部
> ghost,优先排查这类字形,而非加 guard。
