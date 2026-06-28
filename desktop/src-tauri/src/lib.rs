mod pty;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::Rng;
use serde::Serialize;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

/// Live coordinates of the rivet sidecar, handed to the frontend so it can talk
/// to 127.0.0.1:<port> with the per-launch Bearer token.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub port: u16,
    pub token: String,
    /// Which Node binary is hosting the sidecar: "bundled", "env", "system".
    /// Serialized as `nodeSource` for the TS frontend (see runtime/client.ts).
    pub node_source: String,
}

struct Sidecar {
    info: RuntimeInfo,
    child: Mutex<Option<Child>>,
}

#[tauri::command]
fn runtime_info(state: State<Sidecar>) -> RuntimeInfo {
    state.info.clone()
}

/// Ask the OS for a free localhost port by binding to :0, then release it.
fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(3100)
}

fn random_token() -> String {
    let mut rng = rand::thread_rng();
    (0..48)
        .map(|_| {
            let n: u8 = rng.gen_range(0..62);
            match n {
                0..=9 => (b'0' + n) as char,
                10..=35 => (b'a' + (n - 10)) as char,
                _ => (b'A' + (n - 36)) as char,
            }
        })
        .collect()
}

/// Resolve the resource directory, falling back to the exe directory on raw
/// exe (uninstalled) Windows where `app.path().resource_dir()` returns a
/// truncated path like `D:\`. In that case we use `current_exe().parent()` —
/// the folder where the raw .exe lives — because the bundled `node-runtime/`
/// and `rivet-runtime/` directories are siblings of the exe.
fn resource_dir_fallback(app: &tauri::App) -> PathBuf {
    match app.path().resource_dir() {
        Ok(p) if !p.as_os_str().is_empty() => {
            // Raw exe on Windows often returns just the drive root (e.g. "D:" or "D:\").
            // A valid resource dir should contain subdirs — just the drive letter is a
            // known Tauri quirk for unbundled exes.
            if cfg!(target_os = "windows") {
                let s = p.to_string_lossy();
                // Drive letter only (e.g. "D:" or "D:\") — too shallow to be real.
                if s.len() <= 3 {
                    // Fall through to exe-relative fallback
                } else {
                    return strip_verbatim_prefix(p);
                }
            } else {
                return p;
            }
        }
        _ => { /* resource_dir failed — fall through */ }
    }
    // Fallback: exe directory (works for raw/uninstalled exes).
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| strip_verbatim_prefix(p.to_path_buf())))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// On Windows, `current_exe()` and some APIs return "verbatim" (extended-length)
/// paths prefixed with `\\?\` (e.g. `\\?\D:\foo\bar`). That prefix is valid for
/// the Win32 API but Node.js's `realpathSync` doesn't understand it and fails
/// with `EISDIR: lstat '<drive>:'`, killing the sidecar. Strip the prefix so
/// the spawned `node` process receives an ordinary path. No-op off Windows.
#[cfg(target_os = "windows")]
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    use std::path::Component;

    let mut comps = p.components();
    match comps.next() {
        Some(Component::Prefix(pref)) => {
            // `\\?\D:\...` parses as Prefix::VerbatimDisk — reconstruct without the verbatim wrapper.
            if let Some(disk) = pref.as_os_str().to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
                let mut rebuilt = PathBuf::from(disk);
                for c in comps {
                    rebuilt.push(c.as_os_str());
                }
                rebuilt
            } else {
                p
            }
        }
        _ => p,
    }
}

#[cfg(not(target_os = "windows"))]
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    p
}

/// Resolve the bundled Node.js binary shipped as a Tauri resource.
///
/// Resource layout after fetch-node-runtime runs:
///   Resources/node-runtime/darwin-arm64/node
///   Resources/node-runtime/darwin-x64/node
///   Resources/node-runtime/win-x64/node.exe
///   Resources/node-runtime/linux-arm64/node
///   Resources/node-runtime/linux-x64/node
fn bundled_node_path(app: &tauri::App) -> Option<PathBuf> {
    let res = resource_dir_fallback(app);
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let node_os = match os {
        "macos" => "darwin",
        "windows" => "win",
        "linux" => "linux",
        _ => return None,
    };
    let node_arch = match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return None,
    };
    let ext = if os == "windows" { ".exe" } else { "" };
    let path = res
        .join("node-runtime")
        .join(format!("{}-{}", node_os, node_arch))
        .join(format!("node{}", ext));
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Fallback Node lookup when no bundled binary is available.
///
/// A bundled `.app` launched from Finder/Dock inherits a minimal PATH that
/// usually lacks Homebrew/nvm dirs, so a bare `node` lookup fails. We probe the
/// common install locations before falling back to PATH resolution.
fn detect_system_node() -> String {
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    "node".to_string()
}

/// Pick the Node.js command to host the sidecar.
///
/// Priority:
///   1. `RIVET_SIDECAR_CMD` environment override (power users / CI).
///   2. Bundled Node resource (production, no system Node required).
///   3. Common system install locations + PATH fallback.
fn resolve_node_cmd(app: &tauri::App) -> (String, &'static str) {
    if let Ok(cmd) = std::env::var("RIVET_SIDECAR_CMD") {
        return (cmd, "env");
    }
    if let Some(bundled) = bundled_node_path(app) {
        return (bundled.to_string_lossy().to_string(), "bundled");
    }
    (detect_system_node(), "system")
}

/// Resolve the rivet runtime entry point.
///
/// Resolution order (fail-soft, packaged → dev):
///   1. `RIVET_SIDECAR_ENTRY` env override (CI / power users).
///   2. Bundled resource `rivet-runtime/main.js` (production `.app`/installer).
///      The whole tsup `dist/` is shipped via `bundle.resources` in
///      tauri.conf.json and copied into the platform resource dir.
///   3. Repo `dist/main.js` two levels up from `desktop/src-tauri` (dev mode).
fn sidecar_entry(app: &tauri::App) -> PathBuf {
    if let Ok(p) = std::env::var("RIVET_SIDECAR_ENTRY") {
        return PathBuf::from(p);
    }
    let res = resource_dir_fallback(app);
    let bundled = res.join("rivet-runtime").join("main.js");
    if bundled.exists() {
        return bundled;
    }
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // desktop/src-tauri -> desktop -> repo root
    dir.pop();
    dir.pop();
    dir.join("dist").join("main.js")
}



/// Verify the port is actually OUR rivet sidecar (correct token), not merely
/// "something is listening". A bare TCP connect can succeed against an unrelated
/// process that grabbed the recycled port, or before the HTTP server is wired,
/// leaving the UI talking to a black hole. We send an authed `GET /health` and
/// accept only a 200 status line.
fn http_health_ok(port: u16, token: &str) -> bool {
    let mut stream = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

fn wait_until_ready(port: u16, token: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if http_health_ok(port, token) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn spawn_sidecar(app: &tauri::App) -> (RuntimeInfo, Option<Child>) {
    let port = pick_free_port();
    let token = random_token();
    let (node, node_source) = resolve_node_cmd(app);
    let entry = sidecar_entry(app);

    // Report spawn failures instead of swallowing them with `.ok()`: a missing
    // node / bad entry path otherwise leaves the UI with a valid-looking handle
    // pointing at nothing, surfacing only as opaque fetch failures later.
    let child = match Command::new(&node)
        .arg(&entry)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .env("RIVET_SERVER_TOKEN", &token)
        .spawn()
    {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!(
                "[rivet] failed to spawn sidecar (node='{}', source='{}', entry='{}'): {}",
                node, node_source, entry.display(), e
            );
            None
        }
    };

    if child.is_some() && !wait_until_ready(port, &token, Duration::from_secs(15)) {
        eprintln!(
            "[rivet] sidecar spawned but did not pass /health on port {port} within timeout"
        );
    }

    (
        RuntimeInfo {
            port,
            token,
            node_source: node_source.to_string(),
        },
        child,
    )
}

/// Kill the sidecar child if still tracked. Idempotent (take() empties the slot)
/// so calling from both WindowEvent::Destroyed and RunEvent::Exit is safe.
fn kill_sidecar(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<Sidecar>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let tray_icon_bytes = include_bytes!("../icons/32x32.png");

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill
        ])
        .setup(|app| {
            let (info, child) = spawn_sidecar(app);
            app.manage(Sidecar {
                info,
                child: Mutex::new(child),
            });

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window_vibrancy::apply_vibrancy(
                    &window,
                    window_vibrancy::NSVisualEffectMaterial::HudWindow,
                    None,
                    None,
                );
            }

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window_vibrancy::apply_mica(&window, None);
            }

            // ── 系统托盘（L1 #7）──
            let show = MenuItemBuilder::with_id("show", "显示天枢").build(app)?;
            let hide = MenuItemBuilder::with_id("hide", "隐藏天枢").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出天枢").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show)
                .item(&hide)
                .separator()
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(Image::from_bytes(tray_icon_bytes)?)
                .tooltip("天枢 · Tianshu")
                .menu(&tray_menu)
                .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    let id = event.id().as_ref();
                    if let Some(w) = app.get_webview_window("main") {
                        match id {
                            "show" => {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            "hide" => {
                                let _ = w.hide();
                            }
                            _ => {}
                        }
                    }
                    if id == "quit" {
                        kill_sidecar(app);
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event: tauri::tray::TrayIconEvent| {
                    if let TrayIconEvent::Click { button: _, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // 关闭窗口 → 隐藏到托盘，不杀 sidecar
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Destroyed => {
                kill_sidecar(window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_sidecar(app_handle);
            }
        });
}
