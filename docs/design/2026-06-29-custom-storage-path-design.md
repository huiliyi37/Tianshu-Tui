# 自定义运行数据存储路径设计

> 目标：让 Windows/macOS/Linux 用户能把天枢的运行数据（会话日志、配置、记忆、checkpoint 等）放到自己指定的位置，尤其解决“程序装在 D 盘，数据却默认进 C 盘 AppData”的问题。

---

## 1. 现状与痛点

### 1.1 当前数据分布

| 数据类型 | 默认位置 | 现有覆盖手段 |
|---|---|---|
| CLI/TUI 会话日志 | `~/.rivet/sessions/<project-slug>/` | `RIVET_SESSION_DIR` |
| 桌面端 sidecar 会话 | `~/.rivet/desktop/sessions/` | `RIVET_DESKTOP_SESSION_DIR` |
| 用户全局配置 | `~/.rivet/config.json` | `RIVET_CONFIG_PATH` |
| 跨会话记忆 / 观察 | `~/.rivet/memory/<hash>/` | 无 |
| path-grants | `~/.rivet/path-grants-<slug>.json` | 无 |
| checkpoint | `~/.rivet/checkpoint-<slug>.json` | 无 |
| sidecar 默认 cwd | `~` | `RIVET_DEFAULT_CWD` |

> 代码入口：
> - `src/agent/session-persist.ts::dataHome()` 决定 Windows 取 `LOCALAPPDATA`，其余取 `os.homedir()`。
> - `src/agent/session-persist.ts::getSessionDir(cwd)` 决定会话根目录。
> - `src/config/manager.ts::getUserConfigPath()` 决定全局配置路径。
> - `src/server/serve.ts::FileSessionPersistence` 决定桌面端 sidecar 会话路径。

### 1.2 主要痛点

1. **没有统一根目录概念**：每个模块各自拼 `~/.rivet/xxx`，改路径要改多处。
2. **Windows D 盘用户数据仍落 C 盘**：即使程序安装在 `D:\Tianshu`，运行数据还是会进 `C:\Users\<user>\AppData\Local\.rivet`。
3. **只有环境变量入口**：普通桌面用户不会手动设置 `RIVET_SESSION_DIR`。
4. **首次启动无引导**：用户装好软件后不知道数据会占用 C 盘，等到 C 盘满了才想迁，迁移成本高。

---

## 2. 设计目标

1. **统一数据根目录**：引入一个 `RIVET_HOME`，所有运行数据默认挂在它下面。
2. **UI 可配置**：桌面端支持首次启动选路径，设置页支持后期修改。
3. **便携模式友好**：绿色版/非系统安装目录运行时，可自动把数据放在安装目录旁。
4. **向后兼容**：不设置自定义路径时，行为和现在完全一致。
5. **迁移可选**：改路径时，用户可选择是否把旧数据搬过去，而不是强制搬或强制丢。

---

## 3. 非目标

- 不迁移项目内 `.rivet/` 目录（项目级 artifacts、知识库等仍保留在项目内）。
- 不改变会话目录内部的 `<project-slug>/<session-id>` 结构。
- 不把用户配置格式从 JSON 改成 TOML/YAML。

---

## 4. 方案概述

采用 **三层机制**：

1. **全局根目录 `RIVET_HOME`**：Node 运行时统一入口。
2. **桌面端启动器配置**：Tauri Rust 层在启动 sidecar 前决定并注入 `RIVET_HOME`。
3. **按项目覆盖 `sessionDir`**：`.rivet-config.json` 可选覆盖单个项目的会话目录。

### 4.1 路径解析优先级（从高到低）

```text
1. 环境变量 RIVET_HOME                    # 最高优先级，给高级用户 / CI
2. 桌面启动器 launcher.json 中的 rivetHome  # 桌面端用户通过 UI 设置
3. 默认值                                  # 当前行为
   - Windows: %LOCALAPPDATA%\.rivet
   - macOS/Linux: ~/.rivet
```

> 单一会话仍允许 `RIVET_SESSION_DIR` 覆盖，但只影响会话目录，不影响配置/记忆/checkpoint 等。

### 4.2 默认目录推导

| 场景 | 推导规则 |
|---|---|
| 普通安装版（Windows Program Files / macOS .app / Linux /usr） | `%LOCALAPPDATA%\.rivet` 或 `~/.rivet` |
| 便携版 / 非系统目录（exe 不在常见系统目录） | `<exeDir>\TianshuData` 或 `<exeDir>/tianshu-data` |
| 用户手动指定 | 用户所选目录，目录下自动创建 `.rivet/` 子树 |

---

## 5. Node 运行时改造

### 5.1 新增 `src/config/paths.ts`

集中所有 `.rivet` 相关路径计算：

```ts
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function rivetHome(): string {
  if (process.env.RIVET_HOME) return process.env.RIVET_HOME
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '.rivet')
  }
  return join(homedir(), '.rivet')
}

export function userConfigPath(): string {
  return process.env.RIVET_CONFIG_PATH ?? join(rivetHome(), 'config.json')
}

export function sessionsDir(cwd?: string): string {
  if (process.env.RIVET_SESSION_DIR) return process.env.RIVET_SESSION_DIR
  if (cwd) return join(rivetHome(), 'sessions', projectSlug(cwd))
  return join(rivetHome(), 'sessions')
}

export function desktopDir(): string {
  return process.env.RIVET_DESKTOP_DIR ?? join(rivetHome(), 'desktop')
}

export function desktopSessionsDir(): string {
  return process.env.RIVET_DESKTOP_SESSION_DIR ?? join(desktopDir(), 'sessions')
}

export function memoryDir(hash: string): string { return join(rivetHome(), 'memory', hash) }
export function checkpointPath(slug: string): string { return join(rivetHome(), `checkpoint-${slug}.json`) }
export function pathGrantsPath(slug: string): string { return join(rivetHome(), `path-grants-${slug}.json`) }
export function lastSessionPointerDir(): string { return join(rivetHome(), 'last-session') }
export function stateDir(): string { return join(rivetHome(), 'state') }
export function historyPath(): string { return join(rivetHome(), 'history.json') }
export function updateCheckPath(): string { return join(rivetHome(), 'update-check.json') }
export function exportsDir(): string { return join(rivetHome(), 'exports') }
export function subagentsDir(): string { return join(rivetHome(), 'subagents') }
export function workflowsDir(): string { return join(rivetHome(), 'workflows') }
export function planTemplatesDir(): string { return join(rivetHome(), 'plan-templates') }
```

### 5.2 替换散落的路径拼接

需要把以下文件里的 `join(homedir(), '.rivet', ...)`、`join(dataHome(), '.rivet', ...)`、`process.env.RIVET_SESSION_DIR` 等统一改为从 `paths.ts` 读取：

- `src/agent/session-persist.ts` — `dataHome()`、`getSessionDir()`
- `src/config/manager.ts` — `getUserConfigPath()`
- `src/server/serve.ts` — `FileSessionPersistence` 基目录
- `src/agent/checkpoint.ts` — checkpoint 文件
- `src/tools/path-grants.ts` — path-grants 文件
- `src/memory/unified-memory.ts` / `observation-store.ts` — memory 目录
- `src/bootstrap.ts` — `lastSessionPointerFile()`、worker session cleanup

### 5.3 配置 Schema 扩展（可选）

按项目覆盖会话目录时，在 `src/config/schema.ts` 顶层加：

```ts
sessionDir: z.string().optional()
```

用于 `.rivet-config.json` 里声明“本项目会话数据放在哪里”。

**注意**：全局 `rivetHome` 不进入 `~/.rivet/config.json` 的 schema。因为配置文件本身就在要被迁移的目录里，容易形成鸡生蛋问题。全局 `rivetHome` 由 `RIVET_HOME` 环境变量或桌面启动器配置承载。

### 5.4 环境变量路径下的配置 fallback 警告

当用户通过 `RIVET_HOME` 环境变量（而非桌面 UI）切换数据目录时，`userConfigPath()` 会直接读新路径下的 `config.json`。如果新路径下没有配置文件（用户未执行数据迁移），所有 provider 配置、API key、审批模式等会**静默丢失**——用户看到的现象是“启动后所有 provider 都没了”。

需要在 `paths.ts` 的 `userConfigPath()` 中加一层 fallback 检查：

```ts
function defaultRivetHome(): string {
  // 与 rivetHome() 相同，但不读取 RIVET_HOME，用于定位“旧默认路径”
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '.rivet')
  }
  return join(homedir(), '.rivet')
}

export function userConfigPath(): string {
  const fromEnv = process.env.RIVET_CONFIG_PATH
  if (fromEnv) return fromEnv

  const home = rivetHome()
  const candidate = join(home, 'config.json')

  // RIVET_HOME 切换到了非默认路径，但新位置没有 config.json
  // → 检查旧默认位置是否有配置，如果有则警告用户
  if (process.env.RIVET_HOME && !existsSync(candidate)) {
    const legacyPath = join(defaultRivetHome(), 'config.json')
    if (existsSync(legacyPath)) {
      process.stderr.write(
        `[rivet] RIVET_HOME 指向 ${home}，但该路径下没有 config.json。\n` +
        `  旧配置仍在 ${legacyPath}。\n` +
        `  如需迁移数据，请使用桌面端设置页的"更改位置"功能，或手动复制配置文件。\n`
      )
    }
  }
  return candidate
}
```

> 注意：这里的 `existsSync` 是同步 IO，但在启动路径（`loadConfig()`）中本来就同步读文件，不引入额外成本。警告只输出到 stderr，不阻塞启动——用户至少知道发生了什么。

---

## 6. 桌面端启动器配置

### 6.1 配置文件位置

由 Tauri 的 `app.path().app_config_dir()` 决定：

- Windows: `%APPDATA%\Tianshu-Tui\launcher.json`
- macOS: `~/Library/Application Support/com.tianshu.app/launcher.json`
- Linux: `~/.config/Tianshu-Tui/launcher.json`

这个目录和天枢运行数据目录解耦，专门用来存“天枢的数据应该放哪”。

### 6.2 文件内容

```json
{
  "rivetHome": "D:\\TianshuData\\.rivet",
  "source": "user-selected",
  "updatedAt": "2026-06-29T12:00:00.000Z"
}
```

`source` 字段用于区分：
- `default`：用户未指定，使用默认。
- `portable-detected`：启动器检测到便携场景自动选择。
- `user-selected`：用户通过 UI 手动选择。

### 6.3 Rust 启动流程

修改 `desktop/src-tauri/src/lib.rs` 中 `spawn_sidecar`：

1. 调用 `resolve_rivet_home(app)` 读取 launcher.json 并推导默认路径。
2. 在 `cmd` 里注入 `.env("RIVET_HOME", &rivet_home)`。
3. 把当前 `RIVET_HOME` 也返回给前端，方便设置页展示。

```rust
fn resolve_rivet_home(app: &tauri::App) -> PathBuf {
    let default = default_rivet_home(app);
    let launcher_path = app.path().app_config_dir().ok().map(|d| d.join("launcher.json"));
    if let Some(path) = launcher_path {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<LauncherConfig>(&raw) {
                if !cfg.rivet_home.is_empty() {
                    return PathBuf::from(cfg.rivet_home);
                }
            }
        }
    }
    default
}

fn default_rivet_home(app: &tauri::App) -> PathBuf {
    // 便携检测：如果 exe 不在常见系统目录，就用 exe 旁的数据目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if is_portable_location(parent) {
                return parent.join("TianshuData").join(".rivet");
            }
        }
    }
    // 否则走系统默认
    if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default())
            .join(".rivet")
    } else {
        app.path().home_dir()
            .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()))
            .join(".rivet")
    }
}

use known_folders::{get_known_folder_path, KnownFolder};

fn is_portable_location(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy().to_lowercase();

    // macOS 系统安装目录
    if cfg!(target_os = "macos") && s.starts_with("/applications/") {
        return false;
    }

    // Linux 系统安装目录
    if cfg!(target_os = "linux") && (s.starts_with("/usr/") || s.starts_with("/opt/")) {
        return false;
    }

    // Windows：用 known-folders crate 获取 Program Files / Windows 等真实系统路径做前缀匹配
    if cfg!(target_os = "windows") {
        let system_folders = [
            KnownFolder::ProgramFiles,
            KnownFolder::ProgramFilesX86,
            KnownFolder::ProgramFilesCommon,
            KnownFolder::Windows,
        ];
        for folder in system_folders {
            if let Ok(folder) = get_known_folder_path(folder) {
                if p.starts_with(&folder) {
                    return false;
                }
            }
        }
    }

    true
}
```

> 注意：Windows 路径需要去掉 `\\?\` 前缀再传给 Node，已有 `strip_verbatim_prefix` 可用。
>
> `Cargo.toml` 需要新增依赖：`known-folders = "1.1"`（用于准确判断 Windows 系统安装目录）。

---

## 7. 桌面端 UI

### 7.1 首次启动强制引导

在应用首次启动且无 `launcher.json` 时，**强制弹出**「数据存储位置」引导弹窗，用户必须做出选择：

- **使用默认位置**（显示具体路径，例如 `C:\Users\<user>\AppData\Local\.rivet`）
- **放到安装目录旁**（仅当检测到便携场景时显示）
- **自定义位置…**（唤起系统文件夹选择器）

规则：

- 弹窗为模态，不可通过右上角关闭按钮跳过；点击关闭按钮视为选择「使用默认位置」。
- 用户做出任意选择后，立即写入 `launcher.json`（`source` 记录为 `default` / `portable-detected` / `user-selected`），后续启动不再弹出此引导。
- 若用户选择非默认路径，默认勾选「迁移现有数据」，然后提示重启应用生效。
- 设置菜单中保留「存储位置」入口，用户可随时修改。

### 7.2 设置页

在 `SettingsSurface` 增加「存储」区域：

- 当前路径显示（只读文本框）。
- 「更改位置…」按钮：调用 Tauri dialog open 选目录。
- 迁移选项：
  - 复选框「将现有数据移动到新位置」，**默认勾选**。
  - 若勾选，后台递归复制旧目录内容；完成后提示重启。
  - 若不勾选，仅后续新数据进新目录，旧数据保留在原处。
- 「恢复默认」按钮：清空 `launcher.json` 里的 `rivetHome`。

### 7.3 路径变更生效机制

`RIVET_HOME` 在 sidecar 启动时确定，运行中不可变。因此：

- UI 改路径后必须重启 sidecar（或整个应用）。
- 设置页点击“应用”后，写入 launcher.json，然后调用 `restartApp()`（已有 `App.tsx` 中的 relaunch 逻辑）。

---

## 8. 数据迁移

### 8.1 迁移流程

1. UI 选择新目录 `NEW_HOME`。
2. 询问是否迁移旧数据，**默认勾选「迁移」**：
   - 旧数据在 `OLD_HOME/.rivet/`。
   - 迁移 = 递归复制 `OLD_HOME/.rivet/*` → `NEW_HOME/.rivet/`（合并，不覆盖同名文件）。
3. 复制完成后写入 `launcher.json`。
4. 提示用户重启。
5. 重启后，旧目录保留，用户可手动删除。

### 8.2 风险与兜底

- 迁移失败时不写 `launcher.json`，保持原路径可用。
- 大日志文件复制可能耗时，UI 显示进度条或至少“迁移中，请勿关闭”。
- 不迁移项目内 `.rivet/` 目录。

---

## 9. 向后兼容

- 未设置 `RIVET_HOME` 且未设置 launcher.json 时，所有路径和今天完全一致。
- 旧环境变量 `RIVET_SESSION_DIR`、`RIVET_DESKTOP_SESSION_DIR`、`RIVET_CONFIG_PATH` 仍然有效，且优先级高于 `RIVET_HOME` 的对应子路径。
- 已存在的 `~/.rivet/config.json` 不需要任何修改。

---

## 10. 安全与权限

- 自定义路径必须落在用户有写权限的位置；UI 选择目录时可用 Tauri dialog 自带的权限检查。
- **禁止网络路径**：
  - Windows：拒绝 UNC 路径（`\\server\share`）和远程驱动器（通过 `GetDriveTypeW` 判断 `DRIVE_REMOTE`）。
  - macOS/Linux：拒绝 `/Volumes/`（网络卷）和以 `//` 开头的路径。
- 不要把数据根目录设到安装目录内部（便携模式除外），避免安装/卸载程序误删会话数据。
- 路径中禁止 `\n`、控制字符等；`rivetHome()` 返回路径后由 `mkdirSync(..., { recursive: true })` 创建，失败时给出中文错误提示。

---

## 11. 实施步骤（建议顺序）

### Phase 1：Node 运行时统一路径（最小可用）

1. 新建 `src/config/paths.ts`，实现 `rivetHome()`、`userConfigPath()`、`sessionsDir()`、`desktopSessionsDir()` 等。
2. 替换 `src/agent/session-persist.ts`、`src/config/manager.ts`、`src/server/serve.ts` 中的路径计算。
3. 替换 `src/agent/checkpoint.ts`、`src/tools/path-grants.ts`、`src/memory/*`、`src/bootstrap.ts` 中的路径计算。
4. 加单测：验证 `RIVET_HOME` 覆盖、Windows `LOCALAPPDATA` 回退、默认路径不变。
5. 跑 root typecheck + 相关测试。

### Phase 2：Rust 启动器支持 `RIVET_HOME`

1. 在 `desktop/src-tauri/src/lib.rs` 加 `resolve_rivet_home()` 和便携检测。
2. `spawn_sidecar` 注入 `RIVET_HOME`；`RuntimeInfo` 增加 `rivetHome` 字段返回前端。
3. 跑桌面端 typecheck / cargo check。

### Phase 3：桌面端 UI

1. 新增 `SettingsSurface`「存储位置」区块。
2. 新增首次启动引导卡片（可复用设置页逻辑）。
3. 实现迁移助手（复制旧数据 + 重启）。
4. 加桌面端 E2E 或至少手动测试路径变更流程。

### Phase 4：按项目覆盖（可选增强）

1. `src/config/schema.ts` 加 `sessionDir?: string`。
2. `paths.ts` 的 `sessionsDir(cwd)` 读取项目配置里的 `sessionDir`。
3. 文档说明 `.rivet-config.json` 用法。

---

## 12. 需要改动的文件清单

| 文件 | 改动 |
|---|---|
| `src/config/paths.ts` | 新增，统一路径入口 |
| `src/agent/session-persist.ts` | `dataHome()` / `getSessionDir()` 改用 `paths.ts` |
| `src/config/manager.ts` | `getUserConfigPath()` 改用 `paths.ts` |
| `src/server/serve.ts` | `FileSessionPersistence` 基目录改用 `paths.ts` |
| `src/agent/checkpoint.ts` | checkpoint 路径改用 `paths.ts` |
| `src/tools/path-grants.ts` | path-grants 路径改用 `paths.ts` |
| `src/memory/unified-memory.ts` | memory 路径改用 `paths.ts` |
| `src/memory/observation-store.ts` | observation 路径改用 `paths.ts` |
| `src/bootstrap.ts` | last-session / worker cleanup 改用 `paths.ts` |
| `src/tui/history.ts` | 命令行历史 `HISTORY_PATH` 改用 `paths.ts` |
| `src/tui/updater.ts` | 更新检查缓存路径改用 `paths.ts` |
| `src/tui/slash-commands.ts` | claims export 目录改用 `paths.ts` |
| `src/agent/coordinator.ts` | subagents 目录改用 `paths.ts` |
| `src/agent/workflow-runner.ts` | workflows 目录改用 `paths.ts` |
| `src/agent/plan-templates.ts` | plan-templates 目录改用 `paths.ts` |
| `src/agent/worker-session-persist.ts` | worker subagent 会话路径改用 `paths.ts` |
| `src/config/schema.ts` | 可选加 `sessionDir` |
| 对应上述模块的 `__tests__/*.test.ts` | 测试里的硬编码 `join(homedir(), '.rivet', ...)` 同步改用 `paths.ts` |
| `desktop/src-tauri/src/lib.rs` | 加 launcher 读取、便携检测、注入 `RIVET_HOME` |
| `desktop/src/runtime/types.ts` | `RuntimeInfo` 增加 `rivetHome` |
| `desktop/src/surfaces/SettingsSurface.tsx` | 加存储位置设置 |
| `desktop/src/components/FirstRunStorageDialog.tsx` | 新增首次启动引导（可选） |
| `desktop/src/lib/persist.ts` | 可选：持久化首次启动是否完成 |
| `AGENTS.md` / `README.md` | 更新运行数据路径说明 |

> **注意**：上述遗漏的 6 个源文件（`history.ts`、`updater.ts`、`slash-commands.ts`、`coordinator.ts`、`workflow-runner.ts`、`plan-templates.ts`）如果不纳入 Phase 1 改造，`RIVET_HOME` 改路径后这些目录仍留在旧位置，形成“半迁移”状态（会话数据到了新路径，但历史、更新缓存、subagents 等还在 C 盘）。对应的测试文件也需同步更新 `join(homedir(), '.rivet', ...)` → `paths.ts`。同时，Phase 1 的 grep 扫描需覆盖 `join(homedir(), '.rivet'` 全量命中（当前 15 处源文件 + 对应测试文件），避免手工列出遗漏。

---

## 13. 已决策事项

1. **便携检测**：使用 `known-folders` crate，通过 Windows 已知系统目录前缀匹配判断，不再用字符串 heuristics。
2. **首次启动引导**：**强制弹窗**，用户必须做出选择；写入 `launcher.json` 后不再弹出。
3. **迁移数据**：修改路径时，**默认勾选**「将现有数据移动到新位置」。
4. **网络路径**：**直接禁止**；Windows 拒绝 UNC 路径和远程驱动器，macOS/Linux 拒绝 `/Volumes/` 和 `//` 开头路径。

---

## 14. 总结

引入 `RIVET_HOME` 作为统一数据根目录，由桌面端启动器配置驱动，既解决了 Windows D 盘用户的需求，也保留了环境变量覆盖的灵活性。先完成 Node 侧路径统一和 Rust 启动器注入，再补 UI 引导与迁移，是最小风险的分阶段实施方案。
