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
    /// Whether the sidecar passed `/health` before the UI was handed this info.
    /// When false the spawn failed or never came up — the port/token point at
    /// nothing, so the frontend shows a fatal "failed to start" state instead of
    /// looping forever on transient-reconnect copy.
    pub ready: bool,
}

struct Sidecar {
    info: RuntimeInfo,
    child: Mutex<Option<Child>>,
}

#[tauri::command]
fn runtime_info(state: State<Sidecar>) -> RuntimeInfo {
    state.info.clone()
}

/// Apply or clear the window's translucent backdrop (Windows Mica) to match the
/// frontend glass preference. macOS vibrancy stays applied at setup; this is a
/// no-op there. Called from the glass toggle + on startup so Mica only runs when
/// the user actually wants glass surfaces.
#[tauri::command]
fn set_window_glass(window: tauri::WebviewWindow, enabled: bool) {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let _ = window_vibrancy::apply_mica(&window, None);
        } else {
            let _ = window_vibrancy::clear_mica(&window);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, enabled);
    }
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
#[cfg(not(target_os = "windows"))]
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

/// Windows fallback Node lookup. A GUI-launched app inherits a minimal PATH that
/// rarely includes the Node install dir, so bare `"node"` usually fails. Probe
/// the common install locations and `where.exe` (which respects PATH/PATHEXT)
/// before giving up. Keeps the bundled binary as the primary source upstream.
#[cfg(target_os = "windows")]
fn detect_system_node() -> String {
    use std::path::Path;

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(Path::new(&pf).join("nodejs").join("node.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(Path::new(&pf86).join("nodejs").join("node.exe"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        // nvm-windows symlink target / standalone installs under LocalAppData.
        candidates.push(Path::new(&local).join("Programs").join("nodejs").join("node.exe"));
        // Volta default shim.
        candidates.push(Path::new(&local).join("Volta").join("bin").join("node.exe"));
    }
    for c in &candidates {
        if c.is_file() {
            return c.to_string_lossy().to_string();
        }
    }

    // `where.exe node` — respects PATH + PATHEXT. Suppress the console window it
    // would otherwise flash (CREATE_NO_WINDOW) since the parent is a GUI app.
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut wcmd = Command::new("where");
        wcmd.arg("node").creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = wcmd.output() {
            if out.status.success() {
                if let Ok(s) = String::from_utf8(out.stdout) {
                    if let Some(first) = s.lines().map(str::trim).find(|l| !l.is_empty()) {
                        return first.to_string();
                    }
                }
            }
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
        // An env override may be a verbatim (`\\?\D:\...`) path that Node chokes
        // on; strip it too (no-op for bare commands like "node" and off Windows).
        let resolved = strip_verbatim_prefix(PathBuf::from(cmd))
            .to_string_lossy()
            .to_string();
        return (resolved, "env");
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
        // Strip a verbatim (`\\?\…`) prefix so Node's realpathSync doesn't fail
        // with `EISDIR: lstat '<drive>:'` (no-op for ordinary paths / off Windows).
        return strip_verbatim_prefix(PathBuf::from(p));
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

/// Working directory for the sidecar process.
///
/// The sidecar uses `process.cwd()` as the fallback `defaultCwd` for any session
/// created without an explicit project folder, and as the root for shared
/// `.rivet/` data. Tauri launches us from an arbitrary dir — `desktop/src-tauri`
/// in dev, `/` or the bundle dir in prod — so without anchoring, a cwd-less
/// session dumps `.rivet/artifacts/` into the app's own tree (the source
/// checkout got polluted exactly this way). Pin it to the user's home so the
/// fallback locus is stable and aligns with the global `~/.rivet/` session store.
///
/// Override with `RIVET_DEFAULT_CWD` (CI / power users / tests).
fn sidecar_cwd(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RIVET_DEFAULT_CWD") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    app.path().home_dir().ok()
}

fn spawn_sidecar(app: &tauri::App) -> (RuntimeInfo, Option<Child>) {
    let port = pick_free_port();
    let token = random_token();
    let (node, node_source) = resolve_node_cmd(app);
    let entry = sidecar_entry(app);

    // Report spawn failures instead of swallowing them with `.ok()`: a missing
    // node / bad entry path otherwise leaves the UI with a valid-looking handle
    // pointing at nothing, surfacing only as opaque fetch failures later.
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .env("RIVET_SERVER_TOKEN", &token)
        // Parent-death watchdog: the Node sidecar polls this PID and self-exits
        // when the shell process is gone, so a crash / force-quit / Task Manager
        // "End task" can't leave an orphaned node.exe holding the port. (Child::kill
        // only covers the clean-shutdown paths we control.)
        .env("RIVET_PARENT_PID", std::process::id().to_string());
    // Anchor the child's cwd (NOT the parent's — `entry`/`node` are already
    // resolved to absolute paths above, so the child's different cwd can't break
    // locating them). Leave it inherited only if home can't be resolved.
    if let Some(dir) = sidecar_cwd(app) {
        cmd.current_dir(dir);
    }
    // Windows: `node` is a console-subsystem binary, so a GUI parent spawning it
    // flashes a black console window on every launch. CREATE_NO_WINDOW suppresses it.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!(
                "[rivet] failed to spawn sidecar (node='{}', source='{}', entry='{}'): {}",
                node, node_source, entry.display(), e
            );
            None
        }
    };

    let ready = child.is_some() && wait_until_ready(port, &token, Duration::from_secs(15));
    if child.is_some() && !ready {
        eprintln!(
            "[rivet] sidecar spawned but did not pass /health on port {port} within timeout"
        );
        // Health never came up: reap the half-dead child so it can't linger
        // holding the port behind a UI that's about to show a fatal error.
        if let Some(mut c) = child.take() {
            let _ = c.kill();
        }
    }

    (
        RuntimeInfo {
            port,
            token,
            node_source: node_source.to_string(),
            ready,
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
            set_window_glass,
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

            // Windows Mica is applied on demand from the frontend via
            // `set_window_glass` (gated on the user's glass preference), not
            // unconditionally — testers default to solid surfaces, where Mica is
            // pure wasted DWM compositing behind opaque CSS.

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
