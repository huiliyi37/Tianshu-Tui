# Windows 安装指南

## 前置条件

### 1. Node.js 24+
下载：https://nodejs.org/
验证：
```powershell
node --version  # 应显示 v24.x.x
```

### 2. Git for Windows
下载：https://git-scm.com/download/win
验证：
```powershell
git --version
```

### 3. ⚠️ Windows Build Tools（关键！）

`better-sqlite3` 需要原生 C++ 编译。必须安装：

**方法 A：自动安装（推荐）**
```powershell
# 以管理员身份运行 PowerShell
npm install -g windows-build-tools
```
这会安装 Python + Visual Studio Build Tools。大约需要 10-20 分钟。

**方法 B：手动安装**
1. 安装 Visual Studio Build Tools：
   - 下载：https://visualstudio.microsoft.com/visual-cpp-build-tools/
   - 安装时选择"Desktop development with C++"
2. 安装 Python 3.x：
   - 下载：https://www.python.org/downloads/
   - 安装时勾选"Add Python to PATH"

验证：
```powershell
python --version
node -e "console.log(process.config.variables.node_use_openssl)"
```

### 4. ripgrep（可选但推荐）

grep 工具依赖 ripgrep。安装方法：

**方法 A：winget（Windows 10 1809+）**
```powershell
winget install BurntSushi.ripgrep.MSVC
```

**方法 B：scoop**
```powershell
scoop install ripgrep
```

**方法 C：手动下载**
从 https://github.com/BurntSushi/ripgrep/releases 下载 Windows 版本，
解压后将 `rg.exe` 放到 PATH 目录中。

验证：
```powershell
rg --version
```

如果不安装 ripgrep，grep 工具会自动降级为 Node.js 原生实现（稍慢但可用）。

---

## 安装步骤

```powershell
# 1. 克隆仓库
git clone <your-repo-url>
cd opencode-tui

# 2. 切换到 Windows 兼容分支
git checkout feat/windows-compat

# 3. 安装依赖（这一步会编译 better-sqlite3）
npm install

# 如果 better-sqlite3 编译失败，重试：
npm install --build-from-source

# 4. 构建
npm run build

# 5. 验证
node dist/main.js --help
```

---

## 已知限制

### 1. Shell 命令语法
bash 工具现在使用 `cmd.exe /c` 执行命令。以下语法差异需要注意：

| Unix | Windows CMD |
|------|-------------|
| `&&` | `&&`（可用） |
| `\|` | `\|`（可用） |
| `2>&1` | `2>&1`（可用） |
| `$(command)` | 不可用，用 `` `command` `` |
| `/dev/null` | `NUL` |
| `~` | `%USERPROFILE%` |

天枢的 prompt 已经提示模型使用跨平台命令，但用户手动输入的命令需要注意。

### 2. 路径分隔符
代码内部使用 Node.js 的 `path.join()` / `path.resolve()`，会自动处理 `\` vs `/`。
但用户在 bash 工具中手动输入路径时，建议使用 `/`（Windows CMD 也支持）。

### 3. 进程终止
Windows 上使用 `taskkill` 代替 POSIX 信号。行为基本一致，但极端情况下：
- Windows 不支持 `SIGKILL` 的语义（总是强制终止）
- 进程组终止依赖 `taskkill /T`

### 4. 终端渲染
Ink 6 TUI 在以下终端中测试过：
- ✅ Windows Terminal（推荐）
- ✅ PowerShell 7+
- ⚠️ CMD（基本可用，颜色支持有限）
- ❌ 旧版 PowerShell 5（不推荐）

---

## 验证安装

```powershell
# 运行测试
npm test

# 启动
node dist/main.js

# 或全局安装后直接使用
npm install -g .
tianshu
```

---

## 常见问题

### Q: `npm install` 报错 `node-gyp` 相关
A: 确保已安装 Windows Build Tools（见前置条件 3）

### Q: `rg` 命令找不到
A: 安装 ripgrep（见前置条件 4），或忽略——grep 工具会自动降级

### Q: 终端显示乱码
A: 使用 Windows Terminal，设置默认编码为 UTF-8：
```powershell
chcp 65001
```

### Q: 权限错误
A: 以管理员身份运行 PowerShell，或设置执行策略：
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
