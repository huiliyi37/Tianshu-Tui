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

/// 默认 shell：尊重用户 $SHELL / %COMSPEC%，否则退回平台常规值。
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
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

    let mut cmd = CommandBuilder::new(shell.unwrap_or_else(default_shell));
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
