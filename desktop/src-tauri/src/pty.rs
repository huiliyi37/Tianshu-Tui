//! 集成终端 PTY — 用 portable-pty 托管真实 shell 子进程。
//!
//! Tauri 的 shell plugin 只能跑「一次性命令」，无法承载交互式 TTY（行编辑、
//! 光标控制、彩色输出、`vim`/`top` 等全屏程序）。这里用 wezterm 的
//! `portable-pty` 开真实 PTY，前端用 xterm.js 渲染。
//!
//! 数据流：
//!   前端 crypto.randomUUID() 生成 id → 先 listen('pty://output') → `pty_spawn(id, …)`
//!   reader 线程把 PTY 输出 base64 编码后 `emit("pty://output", {id, data})`
//!   前端 onData → `pty_write(id, data)`；ResizeObserver → `pty_resize(id, cols, rows)`
//!   组件卸载 / shell 退出 → `pty_kill(id)`
//!
//! id 由前端生成并在 spawn 前注册监听，彻底消除「shell 首屏 prompt 早于
//! 监听注册」的竞态。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// 一个存活的 PTY 会话：写端（喂键盘输入）、master（resize）、child（kill）。
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Tauri managed state：id → 会话。用 Mutex 保证 Send+Sync 供命令跨线程访问。
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    /// base64(原始字节)。终端输出可能在多字节 UTF-8 边界被切断，base64
    /// 保证字节无损传输，由 xterm 的流式解码器在前端拼接。
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

/// Windows：定位 Git Bash（与 agent bash 工具 `src/platform.ts::resolveGitBashPath`
/// 同一优先级链：env 覆盖 → 从 `where git` 推导 → 常见安装位置）。
/// 刻意不搜 PATH 上的裸 `bash.exe` —— 那可能是 WSL 的 System32 bash。
#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    if let Ok(p) = std::env::var("RIVET_GIT_BASH_PATH") {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    // git.exe 通常在 <root>\cmd\ 或 <root>\bin\；bash.exe 在 <root>\bin\。
    if let Ok(out) = std::process::Command::new("where").arg("git").output() {
        if out.status.success() {
            if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let git = std::path::Path::new(first.trim());
                if let Some(root) = git.parent().and_then(|p| p.parent()) {
                    let bash = root.join("bin").join("bash.exe");
                    if bash.exists() {
                        return Some(bash.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    let mut candidates = vec![
        std::path::PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        std::path::PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
    ];
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        if !la.is_empty() {
            candidates.push(
                std::path::Path::new(&la)
                    .join("Programs")
                    .join("Git")
                    .join("bin")
                    .join("bash.exe"),
            );
        }
    }
    candidates
        .into_iter()
        .find(|c| c.exists())
        .map(|c| c.to_string_lossy().to_string())
}

/// 默认 shell。Windows 与 agent bash 工具对齐：Git Bash 优先（除非
/// RIVET_USE_POWERSHELL 强制），否则 %COMSPEC%；Unix 尊重 $SHELL。
fn default_shell() -> String {
    #[cfg(windows)]
    {
        let force_pwsh = std::env::var("RIVET_USE_POWERSHELL")
            .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        if !force_pwsh {
            if let Some(bash) = find_git_bash() {
                return bash;
            }
        }
        let raw = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string());
        resolve_shell_path(&raw)
    }
    #[cfg(not(windows))]
    {
        let raw = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        resolve_shell_path(&raw)
    }
}

/// 按 shell 类型注入启动参数——目前只用于 Windows 编码修正：
/// PowerShell 5.x 默认控制台编码是 GBK/OEM，agent 侧 `bash.ts` 已注入
/// UTF-8，PTY 这边对齐，否则集成终端中文乱码。非 Windows shell 名字
/// 不会命中这些后缀，无需平台门控。
fn shell_startup_args(shell: &str) -> Vec<String> {
    let lower = shell.to_ascii_lowercase();
    if lower.ends_with("powershell.exe") || lower.ends_with("pwsh.exe") {
        vec![
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8"
                .to_string(),
        ]
    } else if lower.ends_with("cmd.exe") {
        vec!["/K".to_string(), "chcp 65001 >nul".to_string()]
    } else {
        Vec::new()
    }
}

/// 把 shell 名解析为绝对路径。PATH 受限时 portable-pty 找不到 `powershell.exe`
/// 这种非绝对路径，因此我们在常见位置和 PATH 里主动搜索。
fn resolve_shell_path(shell: &str) -> String {
    // 已经是绝对路径或显式相对路径：直接复用。
    if shell.contains(std::path::MAIN_SEPARATOR) {
        return shell.to_string();
    }

    #[cfg(windows)]
    {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
        let candidates = [
            format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", windir),
            format!("{}\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe", windir),
            format!("{}\\System32\\cmd.exe", windir),
            format!("{}\\SysWOW64\\cmd.exe", windir),
            format!("{}\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe", windir),
        ];
        for c in &candidates {
            if std::path::Path::new(c).exists() {
                return c.clone();
            }
        }
    }

    // 在 PATH 中搜索。
    let path_var = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.split(sep) {
        let candidate = std::path::Path::new(dir).join(shell);
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = candidate.with_extension(ext);
                if with_ext.exists() {
                    return with_ext.to_string_lossy().to_string();
                }
            }
        }
    }

    // 找不到也返回原名，让 spawn 失败时给出原始错误信息。
    shell.to_string()
}

/// 开一个新 PTY 并 spawn shell。`id` 由前端提供（见模块注释的竞态消除）。
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = shell
        .map(|s| resolve_shell_path(&s))
        .unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    for arg in shell_startup_args(&shell) {
        cmd.arg(arg);
    }
    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    // xterm.js 通告自己是 xterm-256color；让 shell 启用全彩与正确的 termcap。
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;
    // slave 端句柄在 spawn 后立即释放，否则读端永远等不到 EOF。
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    // reader 线程：阻塞读 PTY，base64 后推给前端；读到 0 或出错即退出并发 exit。
    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if app_out
                        .emit(
                            "pty://output",
                            PtyOutput {
                                id: id_out.clone(),
                                data,
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        // Shell exited (EOF or read error) — auto-clean the session from the
        // HashMap so master/writer/child handles are dropped. Without this, a
        // session whose shell exits naturally leaks forever if the frontend
        // never calls pty_kill (e.g. crash, tab close race).
        if let Some(mgr) = app_out.try_state::<PtyManager>() {
            if let Ok(mut sessions) = mgr.sessions.lock() {
                let removed = sessions.remove(&id_out);
                if let Some(mut s) = removed {
                    let _ = s.child.kill();
                }
            }
        }
        let _ = app_out.emit("pty://exit", PtyExit { id: id_out });
    });

    state
        .sessions
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .insert(
            id,
            PtySession {
                writer,
                master: pair.master,
                child,
            },
        );

    Ok(())
}

/// 把前端键盘输入写进 PTY。未知 id 静默忽略（会话可能已退出）。
#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "pty state poisoned".to_string())?;
    if let Some(s) = sessions.get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("pty write failed: {e}"))?;
        s.writer.flush().map_err(|e| format!("pty flush failed: {e}"))?;
    }
    Ok(())
}

/// 窗口缩放时同步 PTY 行列，让全屏程序（vim/top）正确重排。
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "pty state poisoned".to_string())?;
    if let Some(s) = sessions.get(&id) {
        s.master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize failed: {e}"))?;
    }
    Ok(())
}

/// 杀掉 PTY 会话并从表中移除。幂等。
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "pty state poisoned".to_string())?;
    if let Some(mut s) = sessions.remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}
