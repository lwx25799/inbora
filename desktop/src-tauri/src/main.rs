#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod protocol;
#[cfg(windows)]
mod win32_bridge;
#[cfg(windows)]
mod win32_process;

use protocol::{
    frame_kind, read_bounded_line, BoundedLine, FrameReader, ZeroizingString,
    MAX_SIDECAR_LINE_BYTES,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

struct Backend {
    writer: Mutex<Option<SyncSender<WriteFrame>>>,
    stopping: Arc<AtomicBool>,
    queued_clients: Arc<AtomicUsize>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, PendingResponse>>,
    secret: String,
    #[cfg(windows)]
    bridge: win32_bridge::Win32BridgeState,
    #[cfg(windows)]
    job: Mutex<Option<Job>>,
}
struct Desktop(Arc<Backend>);

struct PendingResponse {
    protocol: u64,
    tx: oneshot::Sender<Result<Value, String>>,
    #[cfg(windows)]
    connect_cache_epoch: Option<u64>,
}

struct WriteFrame {
    line: ZeroizingString,
    deadline: Instant,
    client: bool,
}

impl Backend {
    fn queue_frame(&self, line: ZeroizingString, deadline: Instant, client: bool) -> Result<(), String> {
        let writer = self.writer.lock().map_err(|_| "IPC_UNAVAILABLE")?;
        let writer = writer.as_ref().ok_or("SIDECAR_CLOSED")?;
        if client {
            if self.queued_clients.load(Ordering::Relaxed) >= 128 {
                return Err("IPC_UNAVAILABLE".into());
            }
            self.queued_clients.fetch_add(1, Ordering::Relaxed);
        }
        if let Err(error) = writer.try_send(WriteFrame { line, deadline, client }) {
            if client { self.queued_clients.fetch_sub(1, Ordering::Relaxed); }
            return Err(match error {
                TrySendError::Full(_) => "IPC_UNAVAILABLE".into(),
                TrySendError::Disconnected(_) => "SIDECAR_CLOSED".into(),
            });
        }
        Ok(())
    }

    #[cfg(windows)]
    fn queue_bridge_reply(&self, line: ZeroizingString) {
        if self.queue_frame(line, Instant::now() + Duration::from_secs(4), false).is_err() {
            self.terminate_generation();
        }
    }

    fn terminate_generation(&self) {
        self.stopping.store(true, Ordering::Release);
        #[cfg(windows)]
        {
            self.bridge.suspend_cache();
            // Closing the job's sole handle terminates the sidecar and every reader of its pipe.
            if let Ok(mut job) = self.job.lock() { job.take(); }
        }
        #[cfg(not(windows))]
        if let Ok(mut child) = self.child.lock() { let _ = child.kill(); }
        if let Ok(mut writer) = self.writer.lock() { writer.take(); }
    }

    fn too_large(&self, request_id: Option<&str>) {
        if let Some(id) = request_id {
            if let Ok(mut pending) = self.pending.lock() {
                if let Some(response) = pending.remove(id) {
                    let _ = response.tx.send(Err("SIDECAR_RESPONSE_TOO_LARGE".into()));
                }
            }
        }
    }
}

fn start_writer(
    mut input: impl Write + Send + 'static,
    stopping: Arc<AtomicBool>,
    queued_clients: Arc<AtomicUsize>,
    terminate: impl Fn() + Send + Sync + 'static,
) -> std::io::Result<SyncSender<WriteFrame>> {
    // Native responses can still enter the writer when client frames fill their 128 slots.
    let (send, receive) = mpsc::sync_channel::<WriteFrame>(160);
    let (watch, writes) = mpsc::sync_channel::<(Instant, mpsc::Receiver<()>)>(1);
    let terminate = Arc::new(terminate);
    let on_timeout = terminate.clone();
    std::thread::Builder::new()
        .name("inbora-sidecar-write-deadline".into())
        .spawn(move || {
            while let Ok((deadline, completed)) = writes.recv() {
                if completed.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    == Err(mpsc::RecvTimeoutError::Timeout)
                {
                    on_timeout();
                    break;
                }
            }
        })?;
    std::thread::Builder::new()
        .name("inbora-sidecar-writer".into())
        .spawn(move || {
            while let Ok(frame) = receive.recv() {
                if frame.client { queued_clients.fetch_sub(1, Ordering::Relaxed); }
                if stopping.load(Ordering::Acquire) {
                    break;
                }
                if Instant::now() >= frame.deadline {
                    continue;
                }
                let (complete, completed) = mpsc::channel();
                if watch.send((frame.deadline, completed)).is_err() { break; }
                // A partially written line cannot be reused. Keep its delimiter off the wire after timeout.
                let wrote = Instant::now() < frame.deadline && input.write_all(frame.line.as_bytes()).is_ok() &&
                    Instant::now() < frame.deadline && input.write_all(b"\n").is_ok() &&
                    Instant::now() < frame.deadline;
                let _ = complete.send(());
                if !wrote {
                    terminate();
                    break;
                }
            }
        })?;
    Ok(send)
}

#[cfg(windows)]
struct Job(usize);
#[cfg(windows)]
impl Job {
    fn attach(child: &Child) -> std::io::Result<Self> {
        use std::{
            mem::{size_of, zeroed},
            os::windows::io::AsRawHandle,
        };
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error);
            }
            Ok(Job(handle as usize))
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

fn valid_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("IPC_WINDOW_DENIED".into());
    }
    let url = window.url().map_err(|_| "IPC_ORIGIN_DENIED")?;
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"));
    let dev =
        cfg!(debug_assertions) && url.host_str() == Some("127.0.0.1") && url.port() == Some(1420);
    if !local && !dev {
        return Err("IPC_ORIGIN_DENIED".into());
    }
    Ok(())
}

#[tauri::command]
fn desktop_info(window: WebviewWindow) -> Result<Value, String> {
    valid_window(&window)?;
    let root = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA_REQUIRED")?;
    let remembered_runtime = if cfg!(debug_assertions) {
        std::env::var("INBORA_DEV_RUNTIME")
            .ok()
            .filter(|value| std::path::Path::new(value).is_absolute())
    } else {
        None
    };
    Ok(
        json!({"runtime":std::path::Path::new(&root).join("inbora"),"version":env!("CARGO_PKG_VERSION"),
            "rememberedRuntime":remembered_runtime,"features":{"replyKnowledge":true}}),
    )
}
#[tauri::command]
fn desktop_exit(window: WebviewWindow, handle: tauri::AppHandle) -> Result<(), String> {
    valid_window(&window)?;
    handle.exit(0);
    Ok(())
}

fn validate_command(body: &Value) -> Result<(), String> {
    let command = body
        .get("command")
        .and_then(Value::as_str)
        .ok_or("INVALID_COMMAND")?;
    const ALLOWED: &[&str] = &[
        "accounts",
        "replyKnowledge",
        "replyPipeline",
        "accountAiFeatures",
        "mediaAssets",
        "businessTools",
        "modelProviders",
        "connect",
        "disconnect",
        "getStatus",
        "getDiagnostics",
        "getInbox",
        "markInboxRead",
        "getThread",
        "getMessagePreview",
        "openTarget",
        "selectTarget",
        "claimHuman",
        "renewHuman",
        "releaseHuman",
        "saveDraft",
        "generateSuggestion",
        "dismissSuggestion",
        "previewSend",
        "submitManualSend",
        "getSendResult",
        "pause",
        "resume",
        "emergencyStop",
        "setMode",
        "getAudit",
        "browser",
        "securityRecovery",
        "observe",
        "syncInbox",
        "reconcileUncertain",
        "configureAi",
        "authorizeAi",
        "configureCollection",
        "setModelGrant",
        "setLocalAssistantGrant",
        "setReplyPolicy",
        "enableReplyPolicy",
        "setAutomaticReply",
        "resumeAutomation",
        "clearModelKey",
        "openHumanDialog",
        "closeHumanDialog",
        "sendHumanReply",
        "saveHumanFollowupDraft",
        "sendHumanFollowup",
        "setKeyStorage",
    ];
    if !ALLOWED.contains(&command) {
        return Err("INVALID_COMMAND".into());
    }
    Ok(())
}

#[tauri::command]
async fn client_request(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    body: Value,
) -> Result<Value, String> {
    valid_window(&window)?;
    validate_command(&body)?;
    if body.to_string().len() > 90_000 {
        return Err("INVALID_COMMAND".into());
    }
    let backend = state.0.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let line = json!({"protocol":1,"requestId":id,"secret":backend.secret,"body":body}).to_string();
    send_client_request(&backend, id, 1, line, body["command"].as_str()).await
}

#[tauri::command]
async fn client_request_v2(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    scope: Value,
    body: Value,
    command_id: Option<String>,
) -> Result<Value, String> {
    valid_window(&window)?;
    validate_command(&body)?;
    let backend = state.0.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let command = body["command"].as_str().map(str::to_owned);
    let line = protocol::encode_v2_request(&id, &backend.secret, scope, body, command_id)?;
    send_client_request(&backend, id, 2, line, command.as_deref()).await
}

async fn send_client_request(
    backend: &Backend,
    id: String,
    protocol: u64,
    line: String,
    command: Option<&str>,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(65);
    let line = line.into();
    #[cfg(not(windows))]
    let _ = command;
    #[cfg(windows)]
    let connect_cache_epoch = match command {
        Some("disconnect") => {
            // Clear before the sidecar can hand off its directory lock. Queued old requests
            // may finish, but their epoch can no longer refill this cache.
            backend.bridge.suspend_cache();
            None
        }
        Some("connect") => backend.bridge.cache_epoch(),
        _ => None,
    };
    let (tx, rx) = oneshot::channel();
    backend
        .pending
        .lock()
        .map_err(|_| "IPC_UNAVAILABLE")?
        .insert(
            id.clone(),
            PendingResponse {
                protocol,
                tx,
                #[cfg(windows)]
                connect_cache_epoch,
            },
        );
    if let Err(error) = backend.queue_frame(line, deadline - Duration::from_secs(1), true) {
        backend
            .pending
            .lock()
            .map_err(|_| "IPC_UNAVAILABLE")?
            .remove(&id);
        return Err(error);
    }
    match tokio::time::timeout_at(deadline.into(), rx).await {
        Ok(Ok(result)) => result,
        _ => {
            backend
                .pending
                .lock()
                .map_err(|_| "IPC_UNAVAILABLE")?
                .remove(&id);
            // A timed-out send is not replayed. The client reads the durable result.
            Err("IPC_RESPONSE_UNKNOWN_READ_STATUS".into())
        }
    }
}

const STRIPPED_SIDECAR_ENV_VARS: &[&str] = &[
    "NODE_OPTIONS",
    "NODE_PATH",
    "INBORA_MODEL_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
];

fn configure_sidecar_env<'a>(command: &'a mut Command, secret: &str) -> &'a mut Command {
    command
        .env("INBORA_PIPE_NONCE", secret)
        .env("INBORA_NATIVE_BRIDGE", "1");
    for name in STRIPPED_SIDECAR_ENV_VARS {
        command.env_remove(name);
    }
    command
}

#[cfg(windows)]
type BridgeWork = (
    String,
    Result<protocol::NativeBridgeRequest, String>,
    Option<u64>,
);

#[cfg(windows)]
fn start_native_bridge(backend: &Arc<Backend>) -> std::io::Result<SyncSender<BridgeWork>> {
    let (send, receive) = mpsc::sync_channel::<BridgeWork>(16);
    let backend = Arc::downgrade(backend);
    std::thread::Builder::new()
        .name("inbora-win32-bridge".into())
        .spawn(move || {
            while let Ok((id, payload, cache_epoch)) = receive.recv() {
                let Some(backend) = backend.upgrade() else {
                    break;
                };
                if backend.stopping.load(Ordering::Acquire) {
                    break;
                }
                let result = payload.and_then(|request| {
                    win32_bridge::handle_bridge_request(&backend.bridge, cache_epoch, request)
                });
                let line = protocol::encode_native_bridge_response(&id, &backend.secret, result);
                backend.queue_bridge_reply(line);
            }
        })?;
    Ok(send)
}

fn start_backend(app: &tauri::App) -> Result<Desktop, Box<dyn std::error::Error>> {
    let packaged = app.path().resource_dir()?.join("sidecar");
    let resources = if cfg!(debug_assertions) && !packaged.join("node.exe").is_file() {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.local/staged-sidecar")
    } else {
        packaged
    };
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut command = if cfg!(debug_assertions) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let node = std::env::var_os("INBORA_DEV_NODE").ok_or("DEV_NODE_REQUIRED")?;
        let mut dev = Command::new(node);
        dev.arg(root.join("scripts/dev-sidecar.mjs"))
            .current_dir(root);
        dev
    } else {
        let mut packaged = Command::new(resources.join("node.exe"));
        packaged
            .arg(resources.join("dist/app/sidecar.js"))
            .current_dir(&resources);
        packaged
    };
    configure_sidecar_env(&mut command, &secret)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let job = match Job::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(error.into());
        }
    };
    let output = child.stdout.take().ok_or("SIDECAR_STDOUT_REQUIRED")?;
    let input = child.stdin.take().ok_or("SIDECAR_STDIN_REQUIRED")?;
    let stopping = Arc::new(AtomicBool::new(false));
    let backend = Arc::new(Backend {
        writer: Mutex::new(None),
        stopping,
        queued_clients: Arc::new(AtomicUsize::new(0)),
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        secret,
        #[cfg(windows)]
        bridge: win32_bridge::Win32BridgeState::default(),
        #[cfg(windows)]
        job: Mutex::new(Some(job)),
    });
    let writer_backend = Arc::downgrade(&backend);
    let writer = start_writer(input, backend.stopping.clone(), backend.queued_clients.clone(), move || {
        if let Some(backend) = writer_backend.upgrade() { backend.terminate_generation(); }
    })?;
    *backend.writer.lock().unwrap() = Some(writer);
    #[cfg(windows)]
    let bridge = start_native_bridge(&backend)?;
    let handle = app.handle().clone();
    let reader_backend = backend.clone();
    std::thread::spawn(move || {
        let mut reader = FrameReader::new(output);
        loop {
            let line = match read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES) {
                Ok(BoundedLine::Line(line)) => line,
                Ok(BoundedLine::Oversized(request_id)) => {
                    reader_backend.too_large(request_id.as_deref());
                    let _ = handle.emit(
                        "inbora_status_updated",
                        json!({"event": "sidecar_response_too_large"}),
                    );
                    continue;
                }
                Ok(BoundedLine::InvalidUtf8) => continue,
                Ok(BoundedLine::Eof) | Err(_) => break,
            };
            let Ok(kind) = frame_kind(&line) else {
                continue;
            };
            if kind == Some("dev_sidecar_cache_reset") {
                #[cfg(windows)]
                if protocol::is_authenticated_cache_reset(&line, &reader_backend.secret) {
                    reader_backend.bridge.advance_cache_epoch();
                }
                continue;
            }
            if kind == Some("native_bridge_request") {
                #[cfg(windows)]
                if let Some((id, request)) =
                    protocol::native_bridge_request(&line, &reader_backend.secret)
                {
                    drop(line);
                    if let Err(error) = bridge.try_send((id, request, reader_backend.bridge.active_cache_epoch())) {
                        let (TrySendError::Full((id, _, _)) | TrySendError::Disconnected((id, _, _))) = error;
                        reader_backend.queue_bridge_reply(protocol::encode_native_bridge_response::<Value>(
                            &id, &reader_backend.secret, Err("NATIVE_BRIDGE_BUSY".into()),
                        ));
                    }
                }
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let version = value.get("protocol").and_then(Value::as_u64);
            if version == Some(1) && value.get("ready") == Some(&Value::Bool(true)) {
                #[cfg(windows)]
                reader_backend.bridge.advance_cache_epoch();
                continue;
            }
            if version == Some(2) && line.len() > protocol::MAX_PROTOCOL_V2_FRAME_BYTES {
                reader_backend.too_large(value.get("requestId").and_then(Value::as_str));
                let _ = handle.emit(
                    "inbora_status_updated",
                    json!({"event":"sidecar_response_too_large"}),
                );
                continue;
            }
            if let Some(id) = value.get("requestId").and_then(Value::as_str) {
                if let Ok(mut pending) = reader_backend.pending.lock() {
                    if !pending
                        .get(id)
                        .is_some_and(|entry| version == Some(entry.protocol))
                    {
                        continue;
                    }
                    if let Some(response) = pending.remove(id) {
                        let result = if value.get("ok") == Some(&Value::Bool(true)) {
                            #[cfg(windows)]
                            if let Some(epoch) = response.connect_cache_epoch {
                                reader_backend.bridge.resume_cache(epoch);
                            }
                            Ok(value.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(value
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("SIDECAR_ERROR")
                                .to_string())
                        };
                        let _ = response.tx.send(result);
                    }
                }
            } else if let Some((channel, event)) = protocol::sidecar_event(&value) {
                let _ = handle.emit(channel, event);
            }
        }
        #[cfg(windows)]
        reader_backend.bridge.suspend_cache();
        if let Ok(mut pending) = reader_backend.pending.lock() {
            for (_, response) in pending.drain() {
                let _ = response.tx.send(Err("SIDECAR_CLOSED".into()));
            }
        }
        let _ = handle.emit("inbora_status_updated", json!({"event":"sidecar_closed"}));
    });
    Ok(Desktop(backend))
}

fn shutdown(backend: &Backend) {
    backend.stopping.store(true, Ordering::Release);
    if let Ok(mut writer) = backend.writer.lock() {
        writer.take();
    }
    #[cfg(windows)]
    backend.bridge.suspend_cache();
    for _ in 0..400 {
        if let Ok(mut child) = backend.child.lock() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    backend.terminate_generation();
    if let Ok(mut child) = backend.child.lock() {
        let _ = child.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let desktop = start_backend(app)?;
            app.manage(desktop);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            desktop_exit,
            client_request,
            client_request_v2
        ])
        .build(tauri::generate_context!())
        .expect("INBORA_DESKTOP_START_FAILED")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown(&handle.state::<Desktop>().0);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn pipe_backpressure_bounds_the_queue_and_stop_drops_waiting_frames() {
        struct TestPipe {
            next_write: mpsc::Sender<Vec<u8>>,
            unblock: mpsc::Receiver<()>,
        }
        impl Write for TestPipe {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.next_write.send(bytes.to_vec()).unwrap();
                if bytes != b"\n" {
                    self.unblock.recv_timeout(Duration::from_secs(2)).unwrap();
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (next_write, written) = mpsc::channel();
        let (unblock, waiting) = mpsc::channel();
        let stopping = Arc::new(AtomicBool::new(false));
        let sender = start_writer(
            TestPipe {
                next_write,
                unblock: waiting,
            },
            stopping.clone(),
            Arc::new(AtomicUsize::new(0)),
            || panic!("writer terminated without an expired or failed write"),
        )
        .unwrap();
        let frame = |line: &str| WriteFrame {
            line: line.into(),
            deadline: Instant::now() + Duration::from_secs(4),
            client: false,
        };
        assert!(sender.try_send(frame("in progress")).is_ok());
        assert_eq!(
            written.recv_timeout(Duration::from_secs(2)).unwrap(),
            b"in progress"
        );
        for _ in 0..160 {
            assert!(sender.try_send(frame("queued")).is_ok());
        }
        assert!(matches!(
            sender.try_send(frame("overflow")),
            Err(TrySendError::Full(_))
        ));
        stopping.store(true, Ordering::Release);
        drop(sender);
        assert!(unblock.send(()).is_ok());
        assert_eq!(written.recv_timeout(Duration::from_secs(2)).unwrap(), b"\n");
        assert_eq!(
            written.recv_timeout(Duration::from_secs(2)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn blocked_write_terminates_the_generation_without_flushing_the_delimiter() {
        struct BlockedPipe(mpsc::Sender<Vec<u8>>, mpsc::Receiver<()>);
        impl Write for BlockedPipe {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.send(bytes.to_vec()).unwrap();
                self.1.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let (write, written) = mpsc::channel();
        let (terminated, termination) = mpsc::channel();
        let sender = start_writer(
            BlockedPipe(write, termination),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicUsize::new(0)),
            move || { let _ = terminated.send(()); },
        ).unwrap();
        assert!(sender.try_send(WriteFrame {
            line: "blocked".into(),
            deadline: Instant::now() + Duration::from_millis(300),
            client: false,
        }).is_ok());
        assert_eq!(written.recv_timeout(Duration::from_secs(3)).unwrap(), b"blocked");
        assert_eq!(written.recv_timeout(Duration::from_secs(3)), Err(mpsc::RecvTimeoutError::Disconnected));
    }

    #[test]
    fn configure_sidecar_env_sets_nonce_and_strips_sensitive_vars() {
        let mut command = Command::new("synthetic-node");
        let secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        configure_sidecar_env(&mut command, secret);
        let envs: HashMap<&OsStr, Option<&OsStr>> = command.get_envs().collect();
        assert_eq!(
            envs.get(OsStr::new("INBORA_PIPE_NONCE")).copied().flatten(),
            Some(OsStr::new(secret))
        );
        assert_eq!(
            envs.get(OsStr::new("INBORA_NATIVE_BRIDGE"))
                .copied()
                .flatten(),
            Some(OsStr::new("1"))
        );
        for name in STRIPPED_SIDECAR_ENV_VARS {
            assert_eq!(
                envs.get(OsStr::new(name)),
                Some(&None),
                "expected {name} to be explicitly removed from child environment"
            );
        }
    }
}
