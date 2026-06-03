# import_resource 工具 — 架构设计

> 日期：2026-06-04
> 实现：`6906b21`
> 状态：已实现（本地文件 + GitHub + URL 三种来源）

---

## 1. 问题

Agent 的工具（read_file, grep, glob）只能访问项目目录内的文件。当需要引用外部资源（设计文档、外部项目代码、网络资源）时，用户必须手动复制文件到项目目录。

## 2. 设计：统一导入接口

### 2.1 支持的来源

| 来源 | 识别方式 | 导入方式 |
|------|----------|----------|
| 本地文件/目录 | 绝对路径 `/tmp/spec.pdf` | symlink（junction）或 cp fallback |
| GitHub 仓库 | `github.com/user/repo` | git clone --depth 1 + symlink |
| HTTP/HTTPS URL | `https://...` | curl 下载 |

所有导入的资源存放在 `.rivet/external/` 目录下，其他工具可直接用项目内路径访问。

### 2.2 文件命名规则

```typescript
importTargetName(source: string): string
  // name-hash.ext
  // hash = simpleHash(source).toString(36)
  // 例: opencode-tui-lq7j3k
```

用源路径的 hash 作为去重标识。同一资源重复导入会覆盖（先 rm 再建链接）。

### 2.3 预览机制

导入后自动生成预览：
- 文本文件：前 4000 字符预览 + 总字节数
- 图片文件：提示用 `read_file` 查看
- 目录：文件计数（3 层深度）
- 总是输出项目内相对路径，引导使用 `read_file`/`grep` 访问

### 2.4 GitHub URL 解析

```typescript
parseGitHubUrl(url: string): { owner, repo, subpath?, ref? } | null
```

支持：
- `github.com/user/repo`
- `github.com/user/repo/tree/branch/subpath`
- `github.com/user/repo/blob/commit/path`
- `https://github.com/user/repo.git`
- `ref` 参数覆盖（显式指定分支/tag）

---

## 3. 安全考量

### 3.1 requiresApproval = true

所有 import_resource 调用都需要用户批准。原因：
- 本地文件：访问项目目录外的文件系统
- GitHub：发起 git clone 网络请求
- URL：发起 HTTP 下载请求

### 3.2 isConcurrencySafe = false

导入操作修改 `.rivet/external/` 目录（创建文件/链接/目录），不并发安全。

### 3.3 路径安全

- 本地路径：`resolve()` 规范化后访问，不限制范围（需 approval）
- GitHub：固定 clone 到 `.rivet/external/` 子目录
- URL：curl 下载到 `.rivet/external/`

### 3.4 .gitignore

`.rivet/external/` 已加入 `.gitignore`（commit `6906b21`），导入的资源不会被意外提交。

---

## 4. 调用链

```
agent tool call: import_resource(source, ref?)
  → parseGitHubUrl(source)
    → match: handleGitHubImport(cwd, importDir, gh, ref)
      → git clone --depth 1 (或 git pull --ff-only 已有仓库)
      → 构建预览结果
    → no match, match https?: handleUrlImport(cwd, importDir, url)
      → curl -sL -o targetPath url
      → 构建预览结果
    → no match: handleLocalImport(cwd, importDir, source)
      → symlink (junction) 或 cp fallback
      → 构建预览结果
  → 返回 ToolResult { content, uiContent }
```

---

## 5. 测试覆盖

已有 17 个测试（`src/tools/__tests__/import-resource.test.ts`），覆盖：

- 本地文件导入（symlink）
- 本地目录导入（junction）
- 不存在路径的错误处理
- GitHub URL 解析（各种格式）
- URL 导入（mock curl）
- Tool 元数据（requiresApproval, concurrency, definition name）

---

## 6. 已知限制

| 限制 | 影响 | 后续 |
|------|------|------|
| `execFileSync('curl')` | 同步阻塞，大文件下载会卡住 | 改为异步 fetch + 进度 |
| `execFileSync('git')` | clone 超时 120s，大型仓库可能不够 | 支持 --filter=blob:none |
| 无缓存验证 | 重复导入同一 URL 不检查内容是否变化 | ETag/Last-Modified 检查 |
| simpleHash 冲突 | 理论上不同 source 可能 hash 到同一 name | 概率极低，暂可接受 |
| `.rivet/external/` 无清理 | 导入文件累积 | 可加 TTL 自动清理 |
