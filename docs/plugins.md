# Tianshu 插件系统

> 按需安装、独立依赖、会话启动时动态加载的插件市场。

## 概览

插件是 Tianshu 的扩展形态之一（与 MCP 并行）。每个插件是一个独立的 npm 包，通过
声明式 manifest 注册工具到 agent 的工具列表。

**与 Skill 的区别**：Skill 是纯提示词注入，不能引入二进制依赖。插件是完整的 Node.js
模块，可以依赖任意 npm 包（exceljs、pdfkit、pptxgenjs 等）。

**与 MCP 的区别**：MCP 通过子进程通信，插件同进程运行。插件有更低的延迟，但需要
更严格的安全约束。

## 快速开始

创建一个最小插件：

```bash
mkdir my-plugin && cd my-plugin
npm init -y
```

**package.json** — 在 `tianshu` 字段声明 manifest：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "module",
  "tianshu": {
    "name": "my-plugin",
    "version": "1.0.0",
    "description": "我的第一个插件",
    "entry": "index.js",
    "tools": [
      { "name": "hello", "description": "打个招呼" }
    ],
    "permissions": { "fs": false, "net": false, "shell": false }
  }
}
```

**index.js** — 导出 `tools` 数组：

```js
export const tools = [
  {
    definition: {
      name: 'hello',
      description: '打个招呼',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要问候的名字' }
        }
      }
    },
    execute: async (params) => {
      return { content: `Hello, ${params.name || 'World'}!` }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
]
```

安装：

```
/plugin install ./my-plugin
```

重启会话后生效。

## Manifest 规范

Manifest 定义在 `package.json` 的 `tianshu` 字段中（或独立的 `tianshu-plugin.json`）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 唯一插件 ID，npm 包名风格 |
| `version` | string | ✅ | 语义化版本 |
| `description` | string | ✅ | 简短描述（市场展示） |
| `entry` | string | ✅ | 入口文件相对路径（编译后的 JS） |
| `tools` | ToolDescriptor[] | ✅ | 工具声明列表（用于市场预览和冲突检测） |
| `permissions` | Permissions | ✅ | 申请的权限声明 |
| `skills` | string[] | ❌ | 捆绑 skill 目录（相对路径，每项含 `SKILL.md`） |
| `minCoreVersion` | string | ❌ | 最低核心版本要求（v1 仅记录，不强制） |

### ToolDescriptor

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 工具名（全局唯一，不能与内置/其他插件冲突） |
| `description` | string | ✅ | 一句话描述 |

### Permissions

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `fs` | boolean | false | 读写文件系统 |
| `net` | boolean | false | 网络请求 |
| `shell` | boolean | false | 执行 shell 命令 |

权限声明在安装时展示给用户。`fs` 权限的工具会自动获得内核级路径安全守卫。

### Skill 捆绑（工具 + 方法论）

插件 manifest 可选 `skills` 字段，指向插件包内的 skill 目录（Claude/agentskills 格式：`skills/foo/SKILL.md`）。会话启动时 loader 在工具注册成功后加载这些 skill 到 `skillRegistry`（`source: 'plugin'`），discovery block 与 `/skill` 命令即可见。

| 冲突类型 | 行为 |
|----------|------|
| 工具名 vs 已有 registry | **拒绝整个插件** |
| skill 名 vs 已有 skillRegistry | **跳过该 skill + warning**，插件工具仍加载 |

路径逃逸（`skills: ["../outside"]`）与 entry 同等拒绝加载该 skill 条目。变更插件 skill 需重启会话（与工具相同的前缀缓存纪律）。

示例：`tianshu-design` 插件捆绑 `design-prototype` skill，提供 Codex Product Design 式的前端原型工作流提示词。

## Tool 接口

插件工具的 `execute` 函数签名：

```ts
async (params): Promise<ToolResult>
```

- `params` — **扁平的模型参数对象**，字段由 `input_schema` 定义（如 `params.file_path`）。
  内核加载器在注册阶段包装每个插件工具：管线内部的 `ToolCallParams`（参数嵌套在
  `input` 字段）由 wrapper 抽取展平后再传给插件，插件作者无需关心管线内部结构。
- 返回 `{ content: string, isError?: boolean, rawPath?: string }`
- `rawPath` 用于文件产出，会触发 artifact 持久化和下载入口

路径参数命名约定（内核守卫自动拦截并替换）：

| 参数名 | 模式 | 说明 |
|--------|------|------|
| `file_path` | read | 读取路径 |
| `reference_path` / `actual_path` | read | diff 参考图 / 实现截图 |
| `destination_path` / `output_path` | write | 写入路径 |
| `path` / `input_path` | read | 通用路径 |

路径参数在校验通过后会被**替换为规范化的绝对路径**（以会话 cwd 为锚），插件内部
不要再用 `process.cwd()` 解析相对路径——server 多会话模式下两者不一致。

## 安装与生命周期

### 安装位置

```
~/.rivet/plugins/<name>/
  ├── package.json
  ├── index.js          (entry)
  └── node_modules/     (dependencies)
```

### 安装流程

1. 本地路径源：复制源目录 → `npm install --ignore-scripts --omit=dev`
2. Manifest 校验 → 记录版本
3. 工具在下个会话启动时注册（**不在会话中途改工具清单**，保护前缀缓存）

### 启停

```
/plugin enable <name>     # 启用（下会话生效）
/plugin disable <name>    # 停用（下会话生效）
/plugin remove <name>     # 删除
```

## 安全模型

### 内核级路径守卫

**所有插件工具**的文件路径参数在 `execute` 执行前自动通过 `validatePathSafe`：

1. **敏感文件拦截** — 拒绝读取 `.env`、`credentials*`、`*private*key*`、`*token*` 等
2. **路径逃逸检查** — `../../etc/passwd` 被 `resolve` 后检查是否在工作区或授权目录内
3. **读写授权** — 写操作需要工作区内或显式 write grant；读操作需要 read grant
4. **跨平台路径翻译** — Windows Git Bash 前缀自动翻译

插件作者无需手动调用 `validatePathSafe`——内核 wrapper 在注册阶段自动包装。

### 同进程约束（Known Limitations）

v1 版本插件与核心同进程运行，存在以下已知局限：

- **无进程级沙箱** — 恶意插件可以读取进程内存、访问环境变量。安装即信任。
- **安全依赖安装确认** — TUI 路径（`/plugin install`）展示 permissions 声明，用户显式确认后才执行。REST 路径（`POST /plugins/install`）仅 Bearer 门，需调用方传 `confirm: true` 表明已获用户许可；桌面 UI 落地前，直接调 REST 属于无确认通道，调用方承担确认责任。
- **install 后门防护** — `npm install` 强制 `--ignore-scripts`，禁用 postinstall 任意代码。
- **entry 路径逃逸防护** — `entry: "../../evil.js"` 在 `resolve` 后被拒绝。

未来版本计划：进程级沙箱（Worker thread + `node:vm`）、签名验证体系。

### 安装安全

- 安装确认：TUI `/plugin install` 展示 manifest + permissions，用户确认后执行。REST `POST /plugins/install` 要求 `confirm: true` 参数，调用方应先展示权限声明再传参。
- `npm install --ignore-scripts --omit=dev` — 不执行任意 postinstall 脚本
- 锁版本：记录安装时解析的确切版本号
- 安装失败自动清理残留目录

## 冲突检测

- 插件工具名与内置工具同名 → 拒绝整个插件，报错列出冲突项
- 插件间工具名冲突 → 后加载者拒绝
- 新建插件用新工具名，不与 HTML 降级版工具重名（如 `pdf_create` vs `create_pdf`）

## 让位（Suppress）

当 office 插件启用时，对应的 HTML 降级工具自动从注册表移除：

| 插件 | 移除的内置工具 |
|------|---------------|
| `office-pdf` | `create_pdf` |
| `office-excel` | `create_spreadsheet` |
| `office-ppt` | `create_presentation` |

CSV/TSV/TXT/MD 等真格式选项保留不动。

##  CLI 参考

```
/plugin list                          # 列出已安装插件
/plugin info <name>                   # 查看插件详情
/plugin install <local-path>          # 从本地路径安装
/plugin remove <name>                 # 删除插件
/plugin enable <name>                 # 启用（下会话生效）
/plugin disable <name>                # 停用（下会话生效）
```
