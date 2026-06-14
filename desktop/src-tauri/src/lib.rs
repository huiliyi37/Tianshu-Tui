use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::Rng;
use serde::Serialize;
use tauri::{Manager, State};

/// Live coordinates of the rivet sidecar, handed to the frontend so it can talk
/// to 127.0.0.1:<port> with the per-launch Bearer token.
#[derive(Clone, Serialize)]
pub struct RuntimeInfo {
    pub port: u16,
    pub token: String,
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

/// Resolve the rivet runtime entry point. Defaults to the repo's built
/// `dist/main.js` (two levels up from `desktop/src-tauri`), overridable via env
/// for packaged builds that ship the sidecar elsewhere.
fn sidecar_entry() -> PathBuf {
    if let Ok(p) = std::env::var("RIVET_SIDECAR_ENTRY") {
        return PathBuf::from(p);
    }
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // desktop/src-tauri -> desktop -> repo root
    dir.pop();
    dir.pop();
    dir.join("dist").join("main.js")
}

fn wait_until_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn spawn_sidecar() -> (RuntimeInfo, Option<Child>) {
    let port = pick_free_port();
    let token = random_token();
    let node = std::env::var("RIVET_SIDECAR_CMD").unwrap_or_else(|_| "node".to_string());
    let entry = sidecar_entry();

    let child = Command::new(node)
        .arg(entry)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .env("RIVET_SERVER_TOKEN", &token)
        .spawn()
        .ok();

    if child.is_some() {
        wait_until_ready(port, Duration::from_secs(15));
    }

    (RuntimeInfo { port, token }, child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (info, child) = spawn_sidecar();

    tauri::Builder::default()
        .manage(Sidecar {
            info,
            child: Mutex::new(child),
        })
        .invoke_handler(tauri::generate_handler![runtime_info])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<Sidecar>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut c) = guard.take() {
                            let _ = c.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
