mod pty;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use known_folders::{get_known_folder_path, KnownFolder};
use rand::Rng;
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

/// 进程级退出标志。托盘「退出」触发后置 true，退出过程中所有可见性切换
/// （托盘点击 toggle、CloseRequested→hide）都让它先让路，避免退出清理
/// 与可见性切换打架，表现为窗口/托盘"一闪一闪"且退不干净。
static EXITING: AtomicBool = AtomicBool::new(false);

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
    /// The resolved RIVET_HOME passed to the sidecar. Empty string when the
    /// shell could not resolve a data directory.
    pub rivet_home: String,
}

/// Everything needed to (re)spawn the sidecar. Resolved once at setup so the
/// crash monitor can relaunch with identical coordinates — same port + token —
/// letting the frontend's health polling recover without re-fetching RuntimeInfo.
#[derive(Clone)]
struct SidecarLaunchSpec {
    node: String,
    entry: PathBuf,
    rivet_home: PathBuf,
    cwd: Option<PathBuf>,
    port: u16,
    token: String,
    /// Extracted bundled PortableGit dir (Windows-only). Passed as
    /// RIVET_BUNDLED_GIT_DIR so platform.ts can use its bin\bash.exe as the
    /// shell fallback when no system Git is installed (system Git wins).
    bundled_git_dir: Option<PathBuf>,
}

struct Sidecar {
    info: RuntimeInfo,
    child: Mutex<Option<Child>>,
    spec: SidecarLaunchSpec,
    /// Set by kill_sidecar before killing so the crash monitor can tell an
    /// intentional shutdown from a crash and skip the restart.
    shutting_down: AtomicBool,
}

#[tauri::command]
fn runtime_info(state: State<Sidecar>) -> RuntimeInfo {
    state.info.clone()
}

// ── Storage location (RIVET_HOME) UI commands ───────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageOptions {
    current: String,
    default_path: String,
    portable_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageApplyResult {
    success: bool,
    migrated: bool,
    requires_restart: bool,
    error: Option<String>,
}

#[tauri::command]
fn is_storage_configured(app: tauri::AppHandle) -> bool {
    launcher_config_path(&app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
fn get_storage_options(app: tauri::AppHandle) -> StorageOptions {
    let current = resolve_rivet_home(&app).to_string_lossy().to_string();
    let default_path = default_rivet_home(&app).to_string_lossy().to_string();
    let portable_path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
        .filter(|p| is_portable_location(p))
        .map(|p| p.join("TianshuData").join(".rivet").to_string_lossy().to_string());
    StorageOptions {
        current,
        default_path,
        portable_path,
    }
}

fn validate_storage_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("请选择绝对路径".to_string());
    }
    let s = path.to_string_lossy();
    if s.starts_with(r"\\") || s.starts_with("//") {
        return Err("不支持网络路径（UNC）".to_string());
    }
    #[cfg(target_os = "macos")]
    if s.starts_with("/Volumes/") {
        return Err("不支持 /Volumes/ 网络卷".to_string());
    }
    Ok(())
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建父目录: {}", e))?;
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();

        // Skip symlinks — they can point outside the data tree or create cycles.
        if entry.file_type()?.is_symlink() {
            continue;
        }

        let dst_path = dst.join(entry.file_name());

        // Merge, don't overwrite — the design contract says "不覆盖同名文件".
        if dst_path.exists() {
            continue;
        }

        if entry.file_type()?.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn apply_storage_location(
    app: tauri::AppHandle,
    path: String,
    migrate: bool,
) -> Result<StorageApplyResult, String> {
    let new_home = PathBuf::from(path);
    validate_storage_path(&new_home)?;

    let old_home = resolve_rivet_home(&app);

    // Guard against setting a path inside the current data root.
    if new_home.starts_with(&old_home) && new_home != old_home {
        return Err("新路径不能位于当前数据目录内部".to_string());
    }

    let mut migrated = false;
    if migrate && old_home.exists() && old_home != new_home {
        ensure_parent_dir(&new_home)?;
        // Both homes ARE the data roots (RIVET_HOME semantics — resolve_rivet_home
        // already returns a path ending in `.rivet` or a user-picked folder).
        // Joining another `.rivet` here made the source never exist, so "migrate"
        // silently copied nothing while still reporting success.
        let old_data = old_home.clone();
        let new_data = new_home.clone();
        // Run the recursive copy on a blocking thread — session data can
        // be hundreds of MB and must not freeze the UI.
        let result = tauri::async_runtime::spawn_blocking(move || {
            copy_dir_all(&old_data, &new_data)
        })
        .await
        .map_err(|e| format!("迁移线程异常: {}", e))?;
        match result {
            Ok(()) => migrated = true,
            Err(e) => {
                return Ok(StorageApplyResult {
                    success: false,
                    migrated: false,
                    requires_restart: false,
                    error: Some(format!("迁移失败: {}", e)),
                });
            }
        }
    }

    // Write launcher config so the next sidecar spawn uses the new path.
    let cfg_path = launcher_config_path(&app).ok_or("无法定位启动器配置目录")?;
    ensure_parent_dir(&cfg_path)?;
    let cfg = LauncherConfig {
        rivet_home: new_home.to_string_lossy().to_string(),
        source: "user-selected".to_string(),
        updated_at: OffsetDateTime::now_utc().format(&Rfc3339).ok(),
    };
    let raw = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&cfg_path, raw).map_err(|e| format!("写入 launcher.json 失败: {}", e))?;

    Ok(StorageApplyResult {
        success: true,
        migrated,
        requires_restart: true,
        error: None,
    })
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

/// Version of the bundled PortableGit archive. MUST stay in sync with the
/// default PORTABLE_GIT_VERSION in desktop/scripts/fetch-shell-runtime.js.
#[cfg(target_os = "windows")]
const BUNDLED_GIT_VERSION: &str = "2.55.0.2";

/// Locate the bundled PortableGit self-extracting archive (Windows-only).
/// Returns None when not bundled (e.g. fetch-shell-runtime download failed).
#[cfg(target_os = "windows")]
fn bundled_git_archive(app: &tauri::App) -> Option<PathBuf> {
    let res = resource_dir_fallback(app);
    let arch_dir = match std::env::consts::ARCH {
        "aarch64" => "win-aarch64",
        "x86_64" => "win-x86_64",
        _ => return None,
    };
    let path = res
        .join("shell-runtime")
        .join(arch_dir)
        .join("PortableGit.7z.exe");
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Remove stale version dirs under `<rivet_home>/git-runtime` (anything that
/// isn't the current bundled version). `.extract-tmp` is left alone — it is
/// cleaned at the start of the next extraction attempt.
#[cfg(target_os = "windows")]
fn cleanup_stale_git_runtimes(runtime_root: &Path) {
    let Ok(entries) = std::fs::read_dir(runtime_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name != BUNDLED_GIT_VERSION && name != ".extract-tmp" {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Ensure the bundled PortableGit is extracted to `<rivet_home>/git-runtime/<ver>`.
///
/// Returns the FINAL dir as soon as extraction is under way — the sidecar
/// probes `<dir>\bin\bash.exe` lazily on the first bash tool call, so passing
/// the path before extraction completes is safe (the probe just misses and the
/// existing PowerShell fallback covers the gap until the next probe/launch).
///
/// Extraction runs on a background thread and never blocks startup. It goes
/// through `.extract-tmp` + rename so the final dir only ever appears complete:
/// `bin\bash.exe` existing implies the whole tree is in place.
#[cfg(target_os = "windows")]
fn ensure_bundled_git(app: &tauri::App, rivet_home: &Path) -> Option<PathBuf> {
    let runtime_root = rivet_home.join("git-runtime");
    let final_dir = runtime_root.join(BUNDLED_GIT_VERSION);
    if final_dir.join("bin").join("bash.exe").exists() {
        cleanup_stale_git_runtimes(&runtime_root);
        // Also expose to THIS process so the integrated-terminal PTY
        // (pty.rs::find_git_bash) can use the bundled bash as its fallback.
        std::env::set_var("RIVET_BUNDLED_GIT_DIR", final_dir.as_os_str());
        return Some(final_dir);
    }
    let archive = bundled_git_archive(app)?;
    // Expose the (future) dir now — consumers probe bin\bash.exe existence
    // lazily, so a not-yet-extracted dir is a harmless miss until it lands.
    std::env::set_var("RIVET_BUNDLED_GIT_DIR", final_dir.as_os_str());
    let tmp_dir = runtime_root.join(".extract-tmp");
    let final_clone = final_dir.clone();
    std::thread::spawn(move || {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let _ = std::fs::remove_dir_all(&tmp_dir);
        if let Err(e) = std::fs::create_dir_all(&tmp_dir) {
            eprintln!("[rivet] PortableGit extract: cannot create tmp dir: {e}");
            return;
        }
        // PortableGit.7z.exe is a 7-Zip SFX: -y (yes to all) -o<dir> (output).
        let status = Command::new(&archive)
            .arg("-y")
            .arg(format!("-o{}", tmp_dir.display()))
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        match status {
            Ok(s) if s.success() => {
                if !tmp_dir.join("bin").join("bash.exe").exists() {
                    eprintln!("[rivet] PortableGit extract: bin\\bash.exe missing after extraction");
                    let _ = std::fs::remove_dir_all(&tmp_dir);
                    return;
                }
                let _ = std::fs::remove_dir_all(&final_clone);
                match std::fs::rename(&tmp_dir, &final_clone) {
                    Ok(()) => {
                        eprintln!("[rivet] PortableGit ready at {}", final_clone.display());
                        if let Some(root) = final_clone.parent() {
                            cleanup_stale_git_runtimes(root);
                        }
                    }
                    Err(e) => eprintln!("[rivet] PortableGit extract: rename into place failed: {e}"),
                }
            }
            Ok(s) => eprintln!("[rivet] PortableGit extract failed: {s}"),
            Err(e) => eprintln!("[rivet] PortableGit extract: cannot run SFX: {e}"),
        }
    });
    Some(final_dir)
}

#[cfg(not(target_os = "windows"))]
fn ensure_bundled_git(_app: &tauri::App, _rivet_home: &Path) -> Option<PathBuf> {
    None
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
    // Dev mode: always use the repo's dist/main.js so code changes take effect
    // after `npm run build` without manually re-staging rivet-runtime/. The
    // bundled resource (from a prior `tauri build`) would be a stale copy.
    if cfg!(debug_assertions) {
        let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        // desktop/src-tauri -> desktop -> repo root
        dir.pop();
        dir.pop();
        let repo_dist = dir.join("dist").join("main.js");
        if repo_dist.exists() {
            return repo_dist;
        }
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

/// Launcher-level config stored outside the data root so the shell can decide
/// where the data root is before the sidecar starts.
#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherConfig {
    #[serde(default)]
    rivet_home: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    updated_at: Option<String>,
}

fn launcher_config_path<R: tauri::Runtime>(app: &impl tauri::Manager<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d: PathBuf| d.join("launcher.json"))
}

fn read_launcher_config<R: tauri::Runtime>(app: &impl tauri::Manager<R>) -> LauncherConfig {
    let Some(path) = launcher_config_path(app) else {
        return LauncherConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<LauncherConfig>(&raw).unwrap_or_default(),
        Err(_) => LauncherConfig::default(),
    }
}

/// Resolve the data root (RIVET_HOME) for the sidecar.
///
/// Priority:
///   1. launcher.json rivetHome (set by desktop Settings > Storage)
///   2. default: platform default, with portable-mode detection on first run
fn resolve_rivet_home<R: tauri::Runtime>(app: &impl tauri::Manager<R>) -> PathBuf {
    let cfg = read_launcher_config(app);
    if !cfg.rivet_home.is_empty() {
        return PathBuf::from(cfg.rivet_home);
    }
    default_rivet_home(app)
}

fn default_rivet_home<R: tauri::Runtime>(app: &impl tauri::Manager<R>) -> PathBuf {
    // Portable-mode detection: if the exe lives next to the data directory
    // (e.g., green/zip install on D:\Tools\Tianshu), keep data beside the exe.
    // System installs (Program Files, /Applications, /usr, /opt) use the OS user dir.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if is_portable_location(parent) {
                return parent.join("TianshuData").join(".rivet");
            }
        }
    }
    if cfg!(target_os = "windows") {
        // Mirror the Node-side fallback (src/config/paths.ts): an empty
        // LOCALAPPDATA must not yield a relative `.rivet` with an undefined cwd.
        let base = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                app.path()
                    .home_dir()
                    .ok()
                    .map(|h| h.join("AppData").join("Local"))
            })
            .unwrap_or_else(|| PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()));
        base.join(".rivet")
    } else {
        app.path()
            .home_dir()
            .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()))
            .join(".rivet")
    }
}

/// True when the exe parent is NOT a known system install directory.
/// Uses the Windows Known Folders API so non-English "Program Files" variants
/// (Programme, Archivos de programa, プログラムファイル, etc.) are handled.
fn is_portable_location(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy().to_lowercase();

    #[cfg(target_os = "macos")]
    if s.starts_with("/applications/") {
        return false;
    }

    #[cfg(target_os = "linux")]
    if s.starts_with("/usr/") || s.starts_with("/opt/") {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        let system_folders = [
            KnownFolder::ProgramFiles,
            KnownFolder::ProgramFilesX86,
            KnownFolder::ProgramFilesCommon,
            KnownFolder::Windows,
        ];
        for folder in system_folders {
            if let Some(folder) = get_known_folder_path(folder) {
                if p.starts_with(&folder) {
                    return false;
                }
            }
        }
    }

    true
}

/// Spawn a sidecar process from a resolved launch spec. Used for both the
/// initial launch (setup) and crash-monitor restarts.
fn spawn_from_spec(spec: &SidecarLaunchSpec) -> Option<Child> {
    // Report spawn failures instead of swallowing them with `.ok()`: a missing
    // node / bad entry path otherwise leaves the UI with a valid-looking handle
    // pointing at nothing, surfacing only as opaque fetch failures later.
    let mut cmd = Command::new(&spec.node);
    // Node runtime flags MUST precede the script path. The tsup banner bakes these
    // into dist/main.js's shebang, but `node main.js` ignores the shebang (Windows
    // ignores it entirely), so without passing them here the sidecar runs on V8's
    // default heap and `global.gc()` is undefined — making the post-compaction
    // gc() calls inert and leaving no deterministic ceiling. --expose-gc cannot be
    // set via NODE_OPTIONS (Node rejects it), so it has to be a direct arg.
    //
    // Heap ceiling is tunable via RIVET_SIDECAR_HEAP_MB (system env) for heavy
    // workloads (large knowledge-base ingestion, multi-million-token sessions).
    // The Node-side resource sensor reads the real V8 ceiling, so all memory
    // pressure signals follow this value automatically.
    let heap_mb = std::env::var("RIVET_SIDECAR_HEAP_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(4096);
    cmd.arg(format!("--max-old-space-size={heap_mb}"))
        .arg("--expose-gc")
        .arg(&spec.entry)
        .arg("serve")
        .arg("--port")
        .arg(spec.port.to_string())
        .env("RIVET_SERVER_TOKEN", &spec.token)
        .env("RIVET_HOME", spec.rivet_home.to_string_lossy().as_ref())
        // Parent-death watchdog: the Node sidecar polls this PID and self-exits
        // when the shell process is gone, so a crash / force-quit / Task Manager
        // "End task" can't leave an orphaned node.exe holding the port. (Child::kill
        // only covers the clean-shutdown paths we control.)
        .env("RIVET_PARENT_PID", std::process::id().to_string());
    // Bundled PortableGit (Windows-only): tell platform.ts where the fallback
    // Git Bash lives, and append the git `cmd\` dir to PATH so `git` resolves
    // on machines without a system Git. Appended LAST so a system Git wins.
    if let Some(dir) = &spec.bundled_git_dir {
        cmd.env("RIVET_BUNDLED_GIT_DIR", dir.to_string_lossy().as_ref());
        let mut paths: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        paths.push(dir.join("cmd"));
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    // Anchor the child's cwd (NOT the parent's — `entry`/`node` are already
    // resolved to absolute paths above, so the child's different cwd can't break
    // locating them). Leave it inherited only if home can't be resolved.
    if let Some(dir) = &spec.cwd {
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
    match cmd.spawn() {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!(
                "[rivet] failed to spawn sidecar (node='{}', entry='{}'): {}",
                spec.node,
                spec.entry.display(),
                e
            );
            None
        }
    }
}

/// Seed `RIVET_GIT_BASH_PATH` from the persisted config (`env.gitBashPath` in
/// `<rivet_home>/config.json`) so BOTH the sidecar bash tool (platform.ts) and
/// the desktop integrated terminal PTY (pty.rs::find_git_bash) honor a
/// user-chosen Git Bash location set from the Settings UI. Setting it on THIS
/// process's env means the sidecar inherits it on spawn and the PTY reads it
/// later. A real OS env var of the same name always wins (explicit override).
/// Best-effort: any missing file / parse error just leaves the normal probe
/// chain (where git → common dirs → bundled PortableGit) intact.
fn apply_configured_git_bash(rivet_home: &std::path::Path) {
    if let Some(v) = std::env::var_os("RIVET_GIT_BASH_PATH") {
        if !v.is_empty() {
            return;
        }
    }
    let cfg_path = std::env::var_os("RIVET_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| rivet_home.join("config.json"));
    let text = match std::fs::read_to_string(&cfg_path) {
        Ok(t) => t,
        Err(_) => return,
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(j) => j,
        Err(_) => return,
    };
    if let Some(p) = json
        .get("env")
        .and_then(|e| e.get("gitBashPath"))
        .and_then(|v| v.as_str())
    {
        let p = p.trim();
        if !p.is_empty() {
            std::env::set_var("RIVET_GIT_BASH_PATH", p);
        }
    }
}

fn spawn_sidecar(app: &tauri::App) -> (RuntimeInfo, Option<Child>, SidecarLaunchSpec) {
    let port = pick_free_port();
    let token = random_token();
    let (node, node_source) = resolve_node_cmd(app);
    let entry = sidecar_entry(app);
    let rivet_home = strip_verbatim_prefix(resolve_rivet_home(app));
    // Seed a user-configured Git Bash path before spawn (sidecar inherits it)
    // and before any PTY is created (pty.rs reads it from this process env).
    apply_configured_git_bash(&rivet_home);
    let spec = SidecarLaunchSpec {
        node,
        entry,
        rivet_home: rivet_home.clone(),
        cwd: sidecar_cwd(app),
        port,
        token: token.clone(),
        bundled_git_dir: ensure_bundled_git(app, &rivet_home),
    };

    let mut child = spawn_from_spec(&spec);

    let ready = child.is_some() && wait_until_ready(port, &token, Duration::from_secs(15));
    if child.is_some() && !ready {
        eprintln!(
            "[rivet] sidecar spawned but did not pass /health on port {port} within timeout"
        );
        // Health never came up: reap the half-dead child so it can't linger
        // holding the port behind a UI that's about to show a fatal error.
        if let Some(mut c) = child.take() {
            kill_child_tree(&mut c);
        }
    }

    (
        RuntimeInfo {
            port,
            token,
            node_source: node_source.to_string(),
            ready,
            rivet_home: rivet_home.to_string_lossy().to_string(),
        },
        child,
        spec,
    )
}

/// Kill a sidecar child *and its process tree*.
///
/// Windows: `Child::kill` only terminates node.exe itself — tool subprocesses
/// (bash, git, workers) it spawned survive briefly until the RIVET_PARENT_PID
/// watchdog notices. `taskkill /T /F` removes the whole tree synchronously.
/// Unix: plain kill — the Node side's SIGTERM cleanup chain handles children.
fn kill_child_tree(c: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let ok = Command::new("taskkill")
            .args(["/PID", &c.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            let _ = c.wait(); // reap the zombie handle
            return;
        }
        // taskkill missing/failed — fall through to plain kill.
    }
    let _ = c.kill();
    let _ = c.wait();
}

/// Kill the sidecar child if still tracked. Idempotent (take() empties the slot)
/// so calling from both WindowEvent::Destroyed and RunEvent::Exit is safe.
/// Marks the state as shutting down first so the crash monitor doesn't treat
/// the kill as a crash and respawn.
fn kill_sidecar(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<Sidecar>() {
        state.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut c) = guard.take() {
                kill_child_tree(&mut c);
            }
        }
    }
}

/// Crash monitor (W2): polls the sidecar child every 2s; if it exited without
/// kill_sidecar being the cause, respawns it with the SAME port + token so the
/// frontend's health polling recovers in place. Capped at 3 restarts per 10min
/// window — beyond that the existing fatal-banner path takes over.
fn start_sidecar_monitor(handle: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut restarts: Vec<Instant> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let Some(state) = handle.try_state::<Sidecar>() else {
                continue;
            };
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let exited = {
                let Ok(mut guard) = state.child.lock() else { continue };
                match guard.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(_status)) => {
                            guard.take();
                            true
                        }
                        _ => false,
                    },
                    // None: never spawned (fatal path) or already killed — nothing to watch.
                    None => false,
                }
            };
            if !exited {
                continue;
            }
            // Re-check: kill_sidecar may have raced between our try_wait and here.
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            restarts.retain(|t| t.elapsed() < Duration::from_secs(600));
            if restarts.len() >= 3 {
                eprintln!("[rivet] sidecar crashed {} times within 10min — giving up auto-restart", restarts.len() + 1);
                return;
            }
            restarts.push(Instant::now());
            eprintln!(
                "[rivet] sidecar exited unexpectedly — restarting on port {}",
                state.spec.port
            );
            if let Some(mut child) = spawn_from_spec(&state.spec) {
                let ready = wait_until_ready(
                    state.spec.port,
                    &state.spec.token,
                    Duration::from_secs(15),
                );
                if ready {
                    if let Ok(mut guard) = state.child.lock() {
                        *guard = Some(child);
                    }
                    let _ = handle.emit("sidecar-restarted", ());
                    eprintln!("[rivet] sidecar restarted and healthy");
                } else {
                    // Half-dead respawn: reap it; the attempt still counts
                    // against the budget, and the next poll may retry.
                    kill_child_tree(&mut child);
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let tray_icon_bytes = include_bytes!("../icons/32x32.png");

    tauri::Builder::default()
        // 单例保护：必须是第一个 plugin。第二个实例启动直接退出并唤起已有窗口，
        // 杜绝多实例各建托盘图标 / sidecar、争抢同一 ~/.rivet。仅桌面端生效。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            // macOS: LaunchAgent plist (no deprecated AppleScript); Windows: HKCU Run key.
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            is_storage_configured,
            get_storage_options,
            apply_storage_location,
            set_window_glass,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill
        ])
        .setup(|app| {
            let (info, child, spec) = spawn_sidecar(app);
            app.manage(Sidecar {
                info,
                child: Mutex::new(child),
                spec,
                shutting_down: AtomicBool::new(false),
            });
            start_sidecar_monitor(app.handle().clone());

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
                // 左键点击由 on_tray_icon_event 切换窗口显隐，右键才弹上下文菜单。
                // 若保留默认(左键也弹菜单),左键会同时弹菜单+切窗口,行为冲突。
                .show_menu_on_left_click(false)
                .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    let id = event.id().as_ref();
                    if id == "quit" {
                        // 退出优先：先立 flag，让退出过程中所有可见性切换让路，
                        // 再杀 sidecar、退 app。避免 hide/show 打架导致"一闪一闪"退不干净。
                        EXITING.store(true, Ordering::SeqCst);
                        kill_sidecar(app);
                        app.exit(0);
                        return;
                    }
                    if EXITING.load(Ordering::SeqCst) {
                        return;
                    }
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
                })
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event: tauri::tray::TrayIconEvent| {
                    // 退出过程中忽略托盘点击 toggle，避免与退出清理的 window.hide 打架。
                    if EXITING.load(Ordering::SeqCst) {
                        return;
                    }
                    // 只在「左键抬起」时切换窗口显隐。之前用 `button: _` 会把右键点击
                    // 也当成切窗口,而右键此刻正要弹出托盘上下文菜单——切窗口会抢走菜单
                    // 焦点使其立即关闭,在 Windows 上表现为右键菜单闪来闪去、无法点退出。
                    // 限定 Left+Up 后,右键完全交给系统弹菜单,不再受干扰。
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
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
                if EXITING.load(Ordering::SeqCst) {
                    // 正在退出 → 不 prevent_close，让窗口正常关闭，别挡住退出流程。
                    return;
                }
                // 用户点 X → 隐藏到托盘，不杀 sidecar
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
