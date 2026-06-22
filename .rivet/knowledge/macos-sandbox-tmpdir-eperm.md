# macOS 沙箱 EPERM on mkdtemp — 测试临时目录权限问题

> 状态：已知长期问题，待后续处理
> 首次记录：2026-06-22
> 影响：沙箱环境下 150+ 测试文件的 `mkdtempSync` 调用失败

## 根因

macOS 应用容器（如 rivet 作为桌面应用运行时）将 `$TMPDIR`（`/var/folders/.../T/`）标记为只读。Node.js 的 `os.tmpdir()` 返回这个路径，`fs.mkdtempSync()` 尝试在里面创建临时目录时被 EPERM 拒绝。

```
Error: EPERM: operation not permitted, mkdtemp '/var/folders/41/.../T/volatile-knowledge-XXXXXX'
```

## 影响面

- **150+ 测试文件** 使用 `mkdtempSync`（`grep -rl 'mkdtempSync' src/ --include='*.test.ts'`）
- 正常终端 / CI 环境：`/var/folders/.../T/` 可写，不触发
- 沙箱容器（rivet 桌面应用内运行测试）：全部 EPERM
- 已修复：`src/prompt/__tests__/volatile.test.ts`（`sandboxTmpDir()` 探测回退）

## 临时修复（已落地）

`volatile.test.ts` 里的 `sandboxTmpDir()` 函数：
1. 先探测 `os.tmpdir()` 是否可写（`mkdtempSync` probe）
2. 不可写时回退到项目内 `.test-tmp/` 目录

## 长期方案（待实施）

提取共享测试 helper `src/test-helpers/sandbox-tmpdir.ts`，导出 `sandboxTmpDir()` 供所有 150+ 测试文件复用。模式与 `volatile.test.ts` 里的实现一致，只是提取到共享模块。

改动量：新建 1 个文件 + 修改 150+ 测试文件的 import（将 `tmpdir()` 替换为 `sandboxTmpDir()`）。建议用脚本批量替换。

## 相关 commit

- `423828df` — volatile.test.ts 的 sandboxTmpDir fallback（单文件修复）
