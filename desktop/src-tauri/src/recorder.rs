//! RPA 录制捕获层 — 全局输入事件监听 → 聚合成语义事件 → JSONL 落盘。
//!
//! 设计立场（见 `.cursor/plans/rpa_录制回放规划`）：录制产物不是坐标脚本，
//! 而是「带元素证据的语义事件流」，交给蒸馏阶段转成 agent 可回放的工作流。
//!
//! 架构：
//!   - **纯聚合核**（`Aggregator` + `RawEvent`/`RecEvent`，跨平台、可单测）：
//!     连续可打印键击合并成一段 `text`；带修饰键/命名键记 `key_combo`；
//!     前台 app 变化派生 `app_switch`；安全输入（拿不到字符）记 `[redacted]`。
//!   - **macOS 捕获层**（`#[cfg(target_os = "macos")]`）：CGEventTap（listen-only）
//!     在专用线程 + CFRunLoop 上监听点击/键盘，点击时用 AX hit-test（O(1)，
//!     不走全树）取命中元素身份，前台 app 名由 AX focused-application 的
//!     pid → bundle 名推导。
//!   - **Tauri 命令 + 托管状态**：start/stop/status/permissions（macOS 门禁），
//!     list/delete/read（纯文件操作，跨平台，供蒸馏读取）。
//!
//! JSONL schema（首行 header，其余每行一个事件，顶层固定 `{ts,type,app,data}`）
//! 是三个 Phase 的共同契约，平台无关；Windows 二期复用同一 schema。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;

// ────────────────────────── 纯聚合核（可单测） ──────────────────────────

/// 命中元素的无障碍身份证据。取不到时整体为 `None`（Electron 未开 AX 是
/// 预期路径），此时蒸馏阶段靠坐标 + app + 上下文意图描述该步。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ElementInfo {
    pub role: String,
    pub title: String,
    pub value: String,
    pub ancestors: Vec<Ancestor>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Ancestor {
    pub role: String,
    pub title: String,
}

/// 捕获层喂给聚合器的原始事件。分类（可打印字符 / 需脱敏 / 组合键）已在
/// 捕获层完成，聚合器只负责文本合并、app_switch 派生与冲刷时机。
#[derive(Clone, Debug, PartialEq)]
pub enum RawEvent {
    Click {
        ts: u64,
        app: String,
        x: i64,
        y: i64,
        button: String,
        count: u32,
        element: Option<ElementInfo>,
    },
    /// 一个可打印字符（或字符簇），进入文本合并缓冲。
    Char { ts: u64, app: String, ch: String },
    /// 一次拿不到字符的键击（安全输入模式）——记为脱敏，不落原文。
    Redacted { ts: u64, app: String },
    /// 带修饰键或命名键（回车/Tab/Esc/方向…），组合串与 computer_use `key` 同词表。
    Combo { ts: u64, app: String, combo: String },
}

impl RawEvent {
    fn ts(&self) -> u64 {
        match self {
            RawEvent::Click { ts, .. }
            | RawEvent::Char { ts, .. }
            | RawEvent::Redacted { ts, .. }
            | RawEvent::Combo { ts, .. } => *ts,
        }
    }
    fn app(&self) -> &str {
        match self {
            RawEvent::Click { app, .. }
            | RawEvent::Char { app, .. }
            | RawEvent::Redacted { app, .. }
            | RawEvent::Combo { app, .. } => app,
        }
    }
}

/// 聚合后的语义事件——与 JSONL schema 一一对应。
#[derive(Clone, Debug, PartialEq)]
pub enum RecEvent {
    Click {
        ts: u64,
        app: String,
        x: i64,
        y: i64,
        button: String,
        count: u32,
        element: Option<ElementInfo>,
    },
    Text {
        ts: u64,
        app: String,
        text: String,
        redacted: bool,
    },
    KeyCombo {
        ts: u64,
        app: String,
        combo: String,
    },
    AppSwitch {
        ts: u64,
        app: String,
        from: String,
    },
}

impl RecEvent {
    /// 序列化为 schema 定义的顶层 `{ts,type,app,data}` 形状。
    pub fn to_value(&self) -> serde_json::Value {
        match self {
            RecEvent::Click { ts, app, x, y, button, count, element } => json!({
                "ts": ts, "type": "click", "app": app,
                "data": { "x": x, "y": y, "button": button, "count": count, "element": element }
            }),
            RecEvent::Text { ts, app, text, redacted } => json!({
                "ts": ts, "type": "text", "app": app,
                "data": { "text": text, "redacted": redacted }
            }),
            RecEvent::KeyCombo { ts, app, combo } => json!({
                "ts": ts, "type": "key_combo", "app": app,
                "data": { "combo": combo }
            }),
            RecEvent::AppSwitch { ts, app, from } => json!({
                "ts": ts, "type": "app_switch", "app": app,
                "data": { "from": from }
            }),
        }
    }

    pub fn to_line(&self) -> String {
        self.to_value().to_string()
    }
}

/// 进行中的文本合并段。`redacted` 段不落原文，冲刷时输出 `[redacted]`。
struct TextRun {
    app: String,
    ts: u64,
    redacted: bool,
    buf: String,
}

/// 原始事件 → 语义事件的有状态聚合器。跨平台、纯逻辑、可单测。
#[derive(Default)]
pub struct Aggregator {
    current_app: Option<String>,
    run: Option<TextRun>,
}

impl Aggregator {
    pub fn new() -> Self {
        Self::default()
    }

    /// 冲刷当前文本段（若有），返回对应的 `Text` 事件。
    fn flush_run(&mut self) -> Option<RecEvent> {
        let r = self.run.take()?;
        if r.redacted {
            Some(RecEvent::Text { ts: r.ts, app: r.app, text: "[redacted]".to_string(), redacted: true })
        } else if r.buf.is_empty() {
            None
        } else {
            Some(RecEvent::Text { ts: r.ts, app: r.app, text: r.buf, redacted: false })
        }
    }

    /// 送入一个原始事件，返回它引发的零个或多个语义事件（可能含前置
    /// 文本冲刷与 app_switch）。
    pub fn push(&mut self, ev: RawEvent) -> Vec<RecEvent> {
        let mut out = Vec::new();
        let app = ev.app().to_string();
        let ts = ev.ts();

        // 前台 app 变化：先冲刷未完的文本段，再派生 app_switch。
        if self.current_app.as_deref() != Some(app.as_str()) {
            if let Some(e) = self.flush_run() {
                out.push(e);
            }
            if let Some(prev) = self.current_app.clone() {
                out.push(RecEvent::AppSwitch { ts, app: app.clone(), from: prev });
            }
            self.current_app = Some(app.clone());
        }

        match ev {
            RawEvent::Char { ts, app, ch } => {
                // 若当前是脱敏段，先冲刷再起普通段（不混段）。
                let redacted_run = matches!(&self.run, Some(r) if r.redacted);
                if redacted_run {
                    if let Some(e) = self.flush_run() {
                        out.push(e);
                    }
                }
                match &mut self.run {
                    Some(r) => r.buf.push_str(&ch),
                    None => self.run = Some(TextRun { app, ts, redacted: false, buf: ch }),
                }
            }
            RawEvent::Redacted { ts, app } => {
                // 已在脱敏段则继续；否则冲刷普通段再起脱敏段。
                let normal_run = matches!(&self.run, Some(r) if !r.redacted);
                if normal_run {
                    if let Some(e) = self.flush_run() {
                        out.push(e);
                    }
                }
                if self.run.is_none() {
                    self.run = Some(TextRun { app, ts, redacted: true, buf: String::new() });
                }
            }
            RawEvent::Click { ts, app, x, y, button, count, element } => {
                if let Some(e) = self.flush_run() {
                    out.push(e);
                }
                out.push(RecEvent::Click { ts, app, x, y, button, count, element });
            }
            RawEvent::Combo { ts, app, combo } => {
                if let Some(e) = self.flush_run() {
                    out.push(e);
                }
                out.push(RecEvent::KeyCombo { ts, app, combo });
            }
        }
        out
    }

    /// 录制结束时冲刷尾部残留文本段。
    pub fn flush_all(&mut self) -> Vec<RecEvent> {
        self.flush_run().into_iter().collect()
    }
}

// ────────────────────────── 公共类型 / Tauri 状态 ──────────────────────────

const SCHEMA_VERSION: &str = "rivet-recording/1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    /// Input Monitoring —— CGEventTap 收键盘事件的前提。
    pub input_monitoring: bool,
    /// Accessibility —— AX hit-test 与前台 app 解析的前提。
    pub accessibility: bool,
    /// 人类可读引导（缺权限时给出去哪授权）。
    pub detail: String,
    /// 本平台是否支持录制（当前仅 macOS）。
    pub supported: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub id: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSummary {
    pub id: String,
    pub path: String,
    pub started_at: u64,
    pub event_count: usize,
    pub duration_ms: u64,
    pub apps: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub recording: bool,
    pub id: Option<String>,
    pub count: usize,
}

/// 实时推送给前端指示条的每事件通知。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecordingEventPayload {
    id: String,
    count: usize,
    ts: u64,
    kind: String,
    app: String,
}

struct Active {
    id: String,
    path: PathBuf,
    started_at: u64,
    stop: Arc<AtomicBool>,
    count: Arc<AtomicUsize>,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
pub struct RecorderState {
    inner: Mutex<Option<Active>>,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn recordings_dir(app: &AppHandle) -> PathBuf {
    let home = crate::strip_verbatim_prefix(crate::resolve_rivet_home(app));
    home.join("recordings")
}

fn new_id() -> String {
    use rand::Rng;
    let r: u64 = rand::thread_rng().gen();
    format!("{:x}-{:x}", now_ms(), r & 0xffff_ffff)
}

/// 解析一个录制文件，得到摘要（header + 逐行统计）。跨平台纯文件逻辑。
fn summarize_file(id: &str, path: &PathBuf) -> Option<RecordingSummary> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content.lines();
    let header = lines.next()?;
    let header: serde_json::Value = serde_json::from_str(header).ok()?;
    if header.get("schema").and_then(|v| v.as_str()) != Some(SCHEMA_VERSION) {
        return None;
    }
    let started_at = header.get("startedAt").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut event_count = 0usize;
    let mut duration_ms = 0u64;
    let mut apps: Vec<String> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        event_count += 1;
        if let Some(ts) = ev.get("ts").and_then(|v| v.as_u64()) {
            duration_ms = duration_ms.max(ts);
        }
        if let Some(a) = ev.get("app").and_then(|v| v.as_str()) {
            if !a.is_empty() && !apps.iter().any(|x| x == a) {
                apps.push(a.to_string());
            }
        }
    }
    Some(RecordingSummary {
        id: id.to_string(),
        path: path.to_string_lossy().to_string(),
        started_at,
        event_count,
        duration_ms,
        apps,
    })
}

fn id_from_path(path: &std::path::Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().to_string())
}

// ────────────────────────── Tauri 命令 ──────────────────────────

#[tauri::command]
pub fn recorder_permissions() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        mac::permissions()
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus {
            input_monitoring: false,
            accessibility: false,
            detail: "GUI 录制当前仅支持 macOS。".to_string(),
            supported: false,
        }
    }
}

#[tauri::command]
pub fn recording_start(
    app: AppHandle,
    state: tauri::State<'_, RecorderState>,
) -> Result<StartResult, String> {
    let mut guard = state.inner.lock().map_err(|_| "recorder state poisoned".to_string())?;
    if guard.is_some() {
        return Err("已有正在进行的录制".to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        return Err("GUI 录制当前仅支持 macOS。".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let perms = mac::permissions();
        if !perms.input_monitoring || !perms.accessibility {
            return Err(perms.detail);
        }
        let dir = recordings_dir(&app);
        fs::create_dir_all(&dir).map_err(|e| format!("无法创建录制目录: {e}"))?;
        let id = new_id();
        let path = dir.join(format!("{id}.jsonl"));
        let started_at = now_ms();
        let stop = Arc::new(AtomicBool::new(false));
        let count = Arc::new(AtomicUsize::new(0));

        let thread_app = app.clone();
        let thread_id = id.clone();
        let thread_path = path.clone();
        let thread_stop = stop.clone();
        let thread_count = count.clone();
        let handle = std::thread::Builder::new()
            .name("rivet-recorder".to_string())
            .spawn(move || {
                mac::capture_loop(thread_app, thread_id, thread_path, started_at, thread_stop, thread_count);
            })
            .map_err(|e| format!("无法启动录制线程: {e}"))?;

        *guard = Some(Active {
            id: id.clone(),
            path: path.clone(),
            started_at,
            stop,
            count,
            handle: Some(handle),
        });
        Ok(StartResult { id, path: path.to_string_lossy().to_string() })
    }
}

#[tauri::command]
pub fn recording_stop(
    state: tauri::State<'_, RecorderState>,
) -> Result<RecordingSummary, String> {
    let mut active = {
        let mut guard = state.inner.lock().map_err(|_| "recorder state poisoned".to_string())?;
        guard.take().ok_or_else(|| "没有正在进行的录制".to_string())?
    };
    active.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = active.handle.take() {
        let _ = handle.join();
    }
    summarize_file(&active.id, &active.path).ok_or_else(|| {
        // 线程还没落任何事件也算成功停止，给出空摘要而非报错。
        format!("录制已停止但无可解析内容: {}", active.path.to_string_lossy())
    }).or_else(|_| {
        Ok(RecordingSummary {
            id: active.id.clone(),
            path: active.path.to_string_lossy().to_string(),
            started_at: active.started_at,
            event_count: active.count.load(Ordering::SeqCst),
            duration_ms: 0,
            apps: Vec::new(),
        })
    })
}

#[tauri::command]
pub fn recording_status(state: tauri::State<'_, RecorderState>) -> StatusResult {
    let guard = state.inner.lock().ok();
    match guard.as_ref().and_then(|g| g.as_ref()) {
        Some(a) => StatusResult {
            recording: true,
            id: Some(a.id.clone()),
            count: a.count.load(Ordering::SeqCst),
        },
        None => StatusResult { recording: false, id: None, count: 0 },
    }
}

#[tauri::command]
pub fn list_recordings(app: AppHandle) -> Vec<RecordingSummary> {
    let dir = recordings_dir(&app);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(id) = id_from_path(&path) {
            if let Some(summary) = summarize_file(&id, &path) {
                out.push(summary);
            }
        }
    }
    // 新的在前。
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

#[tauri::command]
pub fn delete_recording(app: AppHandle, id: String) -> Result<(), String> {
    let path = recordings_dir(&app).join(format!("{id}.jsonl"));
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))
}

#[tauri::command]
pub fn read_recording(app: AppHandle, id: String) -> Result<String, String> {
    let path = recordings_dir(&app).join(format!("{id}.jsonl"));
    fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))
}

// ────────────────────────── macOS 捕获层 ──────────────────────────

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use core::ffi::{c_ulong, c_void};
    use core_foundation::base::{CFGetTypeID, CFRelease, TCFType};
    use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopRunResult};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventType, CallbackResult, EventField,
    };
    use foreign_types::ForeignType;
    use std::cell::RefCell;
    use std::io::{BufWriter, Write};
    use std::rc::Rc;
    use std::time::Instant;
    use tauri::Emitter;

    // AX / IOKit / libproc FFI —— 最小面，全部 fail-soft。
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateSystemWide() -> *mut c_void;
        fn AXUIElementCopyElementAtPosition(sys: *mut c_void, x: f32, y: f32, out: *mut *mut c_void) -> i32;
        fn AXUIElementCopyAttributeValue(el: *mut c_void, attr: CFStringRef, out: *mut *const c_void) -> i32;
        fn AXUIElementGetPid(el: *mut c_void, pid: *mut i32) -> i32;
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
    }
    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
        fn CGEventKeyboardGetUnicodeString(
            event: *const c_void,
            max_len: c_ulong,
            actual_len: *mut c_ulong,
            buf: *mut u16,
        );
    }

    const K_IOHID_REQUEST_TYPE_LISTEN: u32 = 1;
    const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;
    const VALUE_TRUNCATE: usize = 120;

    pub fn permissions() -> PermissionStatus {
        let accessibility = unsafe { AXIsProcessTrusted() != 0 };
        let input_monitoring = unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN) == K_IOHID_ACCESS_TYPE_GRANTED };
        let mut missing: Vec<&str> = Vec::new();
        if !input_monitoring {
            missing.push("输入监控（系统设置 → 隐私与安全性 → 输入监控）");
        }
        if !accessibility {
            missing.push("辅助功能（系统设置 → 隐私与安全性 → 辅助功能）");
        }
        let detail = if missing.is_empty() {
            "录制所需权限已全部授予。".to_string()
        } else {
            format!("请为天枢开启以下权限后重试录制：{}。", missing.join("；"))
        };
        PermissionStatus { input_monitoring, accessibility, detail, supported: true }
    }

    /// AX 元素引用的 RAII 守卫（create-rule +1，Drop 时 CFRelease）。
    struct AxElem(*mut c_void);
    impl Drop for AxElem {
        fn drop(&mut self) {
            unsafe {
                if !self.0.is_null() {
                    CFRelease(self.0 as *const c_void);
                }
            }
        }
    }

    unsafe fn ax_string(el: *mut c_void, attr: &str) -> Option<String> {
        let key = CFString::new(attr);
        let mut out: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out);
        if err != 0 || out.is_null() {
            return None;
        }
        if CFGetTypeID(out) != CFString::type_id() {
            CFRelease(out);
            return None;
        }
        let s = CFString::wrap_under_create_rule(out as CFStringRef);
        Some(s.to_string())
    }

    unsafe fn ax_copy_elem(el: *mut c_void, attr: &str) -> Option<AxElem> {
        let key = CFString::new(attr);
        let mut out: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out);
        if err != 0 || out.is_null() {
            return None;
        }
        Some(AxElem(out as *mut c_void))
    }

    fn truncate(mut s: String) -> String {
        if s.chars().count() > VALUE_TRUNCATE {
            s = s.chars().take(VALUE_TRUNCATE).collect::<String>();
            s.push('…');
        }
        s
    }

    /// 点击处 O(1) hit-test，取命中元素 role/title/value + 上两级父链。
    /// 任一步失败即返回 None（Electron 未预热是预期路径）。
    unsafe fn hit_test(sys: *mut c_void, x: f64, y: f64) -> Option<ElementInfo> {
        let mut out: *mut c_void = std::ptr::null_mut();
        let err = AXUIElementCopyElementAtPosition(sys, x as f32, y as f32, &mut out);
        if err != 0 || out.is_null() {
            return None;
        }
        let el = AxElem(out);
        let role = ax_string(el.0, "AXRole").unwrap_or_default();
        let title = ax_string(el.0, "AXTitle")
            .or_else(|| ax_string(el.0, "AXDescription"))
            .unwrap_or_default();
        let value = truncate(ax_string(el.0, "AXValue").unwrap_or_default());
        let mut ancestors = Vec::new();
        let mut cur = ax_copy_elem(el.0, "AXParent");
        for _ in 0..2 {
            match cur {
                Some(p) => {
                    ancestors.push(Ancestor {
                        role: ax_string(p.0, "AXRole").unwrap_or_default(),
                        title: ax_string(p.0, "AXTitle")
                            .or_else(|| ax_string(p.0, "AXDescription"))
                            .unwrap_or_default(),
                    });
                    cur = ax_copy_elem(p.0, "AXParent");
                }
                None => break,
            }
        }
        // role/title/value 全空的元素没有语义价值，视作未命中。
        if role.is_empty() && title.is_empty() && value.is_empty() {
            return None;
        }
        Some(ElementInfo { role, title, value, ancestors })
    }

    unsafe fn app_name_from_pid(pid: i32) -> String {
        if pid <= 0 {
            return String::new();
        }
        let mut buf = [0u8; 4096];
        let n = proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32);
        if n <= 0 {
            return String::new();
        }
        let path = String::from_utf8_lossy(&buf[..n as usize]).to_string();
        // /Applications/QQ.app/Contents/MacOS/QQ → "QQ"（用户传给 computer_use 的名字）。
        if let Some(idx) = path.find(".app/") {
            let before = &path[..idx];
            if let Some(slash) = before.rfind('/') {
                return before[slash + 1..].to_string();
            }
        }
        path.rsplit('/').next().unwrap_or("").to_string()
    }

    unsafe fn frontmost_app_name(sys: *mut c_void) -> String {
        if let Some(app_el) = ax_copy_elem(sys, "AXFocusedApplication") {
            let mut pid: i32 = 0;
            if AXUIElementGetPid(app_el.0, &mut pid) == 0 {
                return app_name_from_pid(pid);
            }
        }
        String::new()
    }

    fn key_chars(event: &CGEvent) -> String {
        let mut len: c_ulong = 0;
        let mut buf = [0u16; 8];
        unsafe {
            CGEventKeyboardGetUnicodeString(
                event.as_ptr() as *const c_void,
                buf.len() as c_ulong,
                &mut len,
                buf.as_mut_ptr(),
            );
        }
        let len = (len as usize).min(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    /// 命名键 keycode → computer_use `key` 词表 token。刻意不含 space
    /// （空格是普通文本，不该打断文本段）。
    fn named_key(keycode: i64) -> Option<&'static str> {
        match keycode {
            36 => Some("return"),
            76 => Some("enter"),
            48 => Some("tab"),
            51 => Some("delete"),
            53 => Some("escape"),
            123 => Some("left"),
            124 => Some("right"),
            125 => Some("down"),
            126 => Some("up"),
            _ => None,
        }
    }

    fn build_combo(flags: CGEventFlags, key_token: &str) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if flags.contains(CGEventFlags::CGEventFlagCommand) {
            parts.push("cmd");
        }
        if flags.contains(CGEventFlags::CGEventFlagControl) {
            parts.push("ctrl");
        }
        if flags.contains(CGEventFlags::CGEventFlagAlternate) {
            parts.push("opt");
        }
        if flags.contains(CGEventFlags::CGEventFlagShift) {
            parts.push("shift");
        }
        let mut s = parts.join("+");
        if !s.is_empty() {
            s.push('+');
        }
        s.push_str(key_token);
        s
    }

    /// KeyDown → RawEvent 分类：命名键 / 带修饰键 → Combo；纯可打印 → Char；
    /// 拿不到字符（安全输入等）→ Redacted。
    fn classify_key(ts: u64, app: String, keycode: i64, flags: CGEventFlags, chars: String) -> RawEvent {
        let has_mod = flags.contains(CGEventFlags::CGEventFlagCommand)
            || flags.contains(CGEventFlags::CGEventFlagControl)
            || flags.contains(CGEventFlags::CGEventFlagAlternate);
        if let Some(name) = named_key(keycode) {
            return RawEvent::Combo { ts, app, combo: build_combo(flags, name) };
        }
        if has_mod {
            let token = if !chars.trim().is_empty() {
                chars.to_lowercase()
            } else {
                format!("key{keycode}")
            };
            return RawEvent::Combo { ts, app, combo: build_combo(flags, &token) };
        }
        if chars.is_empty() {
            RawEvent::Redacted { ts, app }
        } else {
            RawEvent::Char { ts, app, ch: chars }
        }
    }

    fn emit_events(
        app: &AppHandle,
        id: &str,
        writer: &RefCell<BufWriter<fs::File>>,
        count: &Arc<AtomicUsize>,
        evs: Vec<RecEvent>,
    ) {
        for e in evs {
            {
                let mut w = writer.borrow_mut();
                let _ = writeln!(w, "{}", e.to_line());
                let _ = w.flush();
            }
            let n = count.fetch_add(1, Ordering::SeqCst) + 1;
            let (ts, kind, ev_app) = match &e {
                RecEvent::Click { ts, app, .. } => (*ts, "click", app.clone()),
                RecEvent::Text { ts, app, .. } => (*ts, "text", app.clone()),
                RecEvent::KeyCombo { ts, app, .. } => (*ts, "key_combo", app.clone()),
                RecEvent::AppSwitch { ts, app, .. } => (*ts, "app_switch", app.clone()),
            };
            let _ = app.emit(
                "recording://event",
                RecordingEventPayload { id: id.to_string(), count: n, ts, kind: kind.to_string(), app: ev_app },
            );
        }
    }

    /// 录制线程主体：装 event tap，在专用 CFRunLoop 上处理事件直到 stop。
    pub fn capture_loop(
        app: AppHandle,
        id: String,
        path: PathBuf,
        started_at: u64,
        stop: Arc<AtomicBool>,
        count: Arc<AtomicUsize>,
    ) {
        let file = match fs::File::create(&path) {
            Ok(f) => f,
            Err(_) => return,
        };
        // Rc 让 callback 与循环后的尾部冲刷共享同一 writer/aggregator；
        // 录制线程单线程运行，Rc/RefCell 无并发问题（event tap 用
        // new_unchecked 装在本线程 runloop 上，不要求 Send）。
        let writer = Rc::new(RefCell::new(BufWriter::new(file)));
        // header 行。
        {
            let header = json!({
                "schema": SCHEMA_VERSION,
                "startedAt": started_at,
                "platform": "darwin",
                "appVersion": app.package_info().version.to_string(),
            });
            let mut w = writer.borrow_mut();
            let _ = writeln!(w, "{header}");
            let _ = w.flush();
        }

        let agg = Rc::new(RefCell::new(Aggregator::new()));
        let sys = unsafe { AXUIElementCreateSystemWide() };
        // sys 生命周期覆盖整个 runloop，结束后释放。
        let start = Instant::now();

        let cb_app = app.clone();
        let cb_id = id.clone();
        let cb_count = count.clone();
        let cb_agg = agg.clone();
        let cb_writer = writer.clone();
        let callback = move |_proxy: core_graphics::event::CGEventTapProxy,
                             etype: CGEventType,
                             event: &CGEvent|
              -> CallbackResult {
            let ts = start.elapsed().as_millis() as u64;
            let app_name = unsafe { frontmost_app_name(sys) };
            match etype {
                CGEventType::LeftMouseDown | CGEventType::RightMouseDown | CGEventType::OtherMouseDown => {
                    let loc = event.location();
                    let button = match etype {
                        CGEventType::RightMouseDown => "right",
                        CGEventType::OtherMouseDown => "other",
                        _ => "left",
                    };
                    let cnt = event.get_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE).max(1) as u32;
                    let element = unsafe { hit_test(sys, loc.x, loc.y) };
                    let raw = RawEvent::Click {
                        ts,
                        app: app_name,
                        x: loc.x.round() as i64,
                        y: loc.y.round() as i64,
                        button: button.to_string(),
                        count: cnt,
                        element,
                    };
                    let evs = cb_agg.borrow_mut().push(raw);
                    emit_events(&cb_app, &cb_id, &cb_writer, &cb_count, evs);
                }
                CGEventType::KeyDown => {
                    let flags = event.get_flags();
                    let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                    let chars = key_chars(event);
                    let raw = classify_key(ts, app_name, keycode, flags, chars);
                    let evs = cb_agg.borrow_mut().push(raw);
                    emit_events(&cb_app, &cb_id, &cb_writer, &cb_count, evs);
                }
                _ => {}
            }
            CallbackResult::Keep
        };

        let events = vec![
            CGEventType::LeftMouseDown,
            CGEventType::RightMouseDown,
            CGEventType::OtherMouseDown,
            CGEventType::KeyDown,
        ];

        let run_result = CGEventTap::with_enabled(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            events,
            callback,
            || {
                while !stop.load(Ordering::SeqCst) {
                    let _ = CFRunLoop::run_in_mode(
                        unsafe { kCFRunLoopDefaultMode },
                        std::time::Duration::from_millis(250),
                        false,
                    );
                }
            },
        );

        // tap 创建失败（通常是权限缺失）——已在 start 前门禁，这里兜底静默。
        let _ = run_result.map(|_: ()| ()).unwrap_or(());
        let _ = CFRunLoopRunResult::Finished; // 保持类型引用，避免未使用告警

        // 冲刷尾部文本段。
        let evs = agg.borrow_mut().flush_all();
        emit_events(&app, &id, &writer, &count, evs);
        let _ = writer.borrow_mut().flush();

        unsafe {
            if !sys.is_null() {
                CFRelease(sys as *const c_void);
            }
        }
    }
}

// ────────────────────────── 单元测试（纯聚合核） ──────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn click(ts: u64, app: &str) -> RawEvent {
        RawEvent::Click { ts, app: app.to_string(), x: 1, y: 2, button: "left".to_string(), count: 1, element: None }
    }
    fn ch(ts: u64, app: &str, c: &str) -> RawEvent {
        RawEvent::Char { ts, app: app.to_string(), ch: c.to_string() }
    }

    #[test]
    fn coalesces_consecutive_chars_into_one_text() {
        let mut agg = Aggregator::new();
        for (i, c) in ["h", "e", "l", "l", "o"].iter().enumerate() {
            let out = agg.push(ch(i as u64, "QQ", c));
            assert!(out.is_empty(), "字符不应立即产出事件");
        }
        let out = agg.flush_all();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], RecEvent::Text { ts: 0, app: "QQ".into(), text: "hello".into(), redacted: false });
    }

    #[test]
    fn combo_flushes_pending_text_then_emits_key_combo() {
        let mut agg = Aggregator::new();
        agg.push(ch(0, "QQ", "a"));
        agg.push(ch(1, "QQ", "b"));
        let out = agg.push(RawEvent::Combo { ts: 2, app: "QQ".into(), combo: "return".into() });
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], RecEvent::Text { ts: 0, app: "QQ".into(), text: "ab".into(), redacted: false });
        assert_eq!(out[1], RecEvent::KeyCombo { ts: 2, app: "QQ".into(), combo: "return".into() });
    }

    #[test]
    fn click_flushes_pending_text_then_emits_click() {
        let mut agg = Aggregator::new();
        agg.push(ch(0, "QQ", "x"));
        let out = agg.push(click(5, "QQ"));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], RecEvent::Text { ts: 0, app: "QQ".into(), text: "x".into(), redacted: false });
        assert!(matches!(out[1], RecEvent::Click { .. }));
    }

    #[test]
    fn app_change_flushes_text_and_derives_app_switch() {
        let mut agg = Aggregator::new();
        agg.push(ch(0, "QQ", "h"));
        agg.push(ch(1, "QQ", "i"));
        let out = agg.push(click(10, "WeChat"));
        // Text("hi") 冲刷 → app_switch(QQ→WeChat) → click
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], RecEvent::Text { ts: 0, app: "QQ".into(), text: "hi".into(), redacted: false });
        assert_eq!(out[1], RecEvent::AppSwitch { ts: 10, app: "WeChat".into(), from: "QQ".into() });
        assert!(matches!(out[2], RecEvent::Click { .. }));
    }

    #[test]
    fn first_event_establishes_app_without_app_switch() {
        let mut agg = Aggregator::new();
        let out = agg.push(click(0, "QQ"));
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], RecEvent::Click { .. }), "首个事件不产 app_switch");
    }

    #[test]
    fn redacted_run_emits_placeholder_not_raw() {
        let mut agg = Aggregator::new();
        agg.push(RawEvent::Redacted { ts: 0, app: "QQ".into() });
        agg.push(RawEvent::Redacted { ts: 1, app: "QQ".into() });
        let out = agg.flush_all();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], RecEvent::Text { ts: 0, app: "QQ".into(), text: "[redacted]".into(), redacted: true });
    }

    #[test]
    fn mixed_normal_and_redacted_runs_split_cleanly() {
        let mut agg = Aggregator::new();
        agg.push(ch(0, "QQ", "a"));
        let mid = agg.push(RawEvent::Redacted { ts: 1, app: "QQ".into() });
        // 从普通段切到脱敏段：先冲刷 "a"
        assert_eq!(mid, vec![RecEvent::Text { ts: 0, app: "QQ".into(), text: "a".into(), redacted: false }]);
        let back = agg.push(ch(2, "QQ", "b"));
        // 从脱敏段切回普通段：先冲刷 "[redacted]"
        assert_eq!(back, vec![RecEvent::Text { ts: 1, app: "QQ".into(), text: "[redacted]".into(), redacted: true }]);
        let tail = agg.flush_all();
        assert_eq!(tail, vec![RecEvent::Text { ts: 2, app: "QQ".into(), text: "b".into(), redacted: false }]);
    }

    #[test]
    fn click_json_shape_matches_schema() {
        let ev = RecEvent::Click {
            ts: 1250,
            app: "QQ".into(),
            x: 640,
            y: 410,
            button: "left".into(),
            count: 1,
            element: Some(ElementInfo {
                role: "AXTextField".into(),
                title: "搜索".into(),
                value: "".into(),
                ancestors: vec![Ancestor { role: "AXWindow".into(), title: "QQ".into() }],
            }),
        };
        let v = ev.to_value();
        assert_eq!(v["type"], "click");
        assert_eq!(v["app"], "QQ");
        assert_eq!(v["data"]["x"], 640);
        assert_eq!(v["data"]["button"], "left");
        assert_eq!(v["data"]["element"]["role"], "AXTextField");
        assert_eq!(v["data"]["element"]["ancestors"][0]["title"], "QQ");
    }

    #[test]
    fn click_without_element_serializes_null() {
        let ev = RecEvent::Click {
            ts: 1, app: "QQ".into(), x: 0, y: 0, button: "left".into(), count: 1, element: None,
        };
        let v = ev.to_value();
        assert!(v["data"]["element"].is_null());
    }

    #[test]
    fn text_and_app_switch_json_shapes() {
        let t = RecEvent::Text { ts: 3480, app: "QQ".into(), text: "TUI".into(), redacted: false };
        let tv = t.to_value();
        assert_eq!(tv["type"], "text");
        assert_eq!(tv["data"]["text"], "TUI");
        assert_eq!(tv["data"]["redacted"], false);

        let a = RecEvent::AppSwitch { ts: 5100, app: "WeChat".into(), from: "QQ".into() };
        let av = a.to_value();
        assert_eq!(av["type"], "app_switch");
        assert_eq!(av["data"]["from"], "QQ");
        assert_eq!(av["app"], "WeChat");
    }
}
