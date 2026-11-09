#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

struct Backend {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    secret: String,
    #[cfg(windows)]
    _job: Job,
}
struct Desktop(Arc<Backend>);

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
    Ok(
        json!({"runtime":std::path::Path::new(&root).join("inbora"),"version":env!("CARGO_PKG_VERSION")}),
    )
}
#[tauri::command]
fn desktop_exit(window: WebviewWindow, handle: tauri::AppHandle) -> Result<(), String> {
    valid_window(&window)?;
    handle.exit(0);
    Ok(())
}

#[tauri::command]
async fn client_request(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    body: Value,
) -> Result<Value, String> {
    valid_window(&window)?;
    let command = body
        .get("command")
        .and_then(Value::as_str)
        .ok_or("INVALID_COMMAND")?;
    const ALLOWED: &[&str] = &[
        "connect",
        "disconnect",
        "getStatus",
        "getInbox",
        "getThread",
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
        "observe",
        "syncInbox",
        "reconcileUncertain",
        "configureAi",
        "authorizeAi",
        "configureCollection",
        "setModelGrant",
        "setReplyPolicy",
        "enableReplyPolicy",
        "setAutomaticReply",
        "resumeAutomation",
        "clearModelKey",
        "openHumanDialog",
        "closeHumanDialog",
        "sendHumanReply",
        "setKeyStorage",
    ];
    if !ALLOWED.contains(&command) || body.to_string().len() > 90_000 {
        return Err("INVALID_COMMAND".into());
    }
    let backend = state.0.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    backend
        .pending
        .lock()
        .map_err(|_| "IPC_UNAVAILABLE")?
        .insert(id.clone(), tx);
    let line =
        json!({"protocol":1,"requestId":id,"secret":backend.secret,"body":body}).to_string() + "\n";
    let write_result = {
        let mut input = backend.input.lock().map_err(|_| "IPC_UNAVAILABLE")?;
        input
            .as_mut()
            .ok_or("SIDECAR_CLOSED")?
            .write_all(line.as_bytes())
    };
    if write_result.is_err() {
        backend
            .pending
            .lock()
            .map_err(|_| "IPC_UNAVAILABLE")?
            .remove(&id);
        return Err("SIDECAR_CLOSED".into());
    }
    match tokio::time::timeout(Duration::from_secs(65), rx).await {
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
        dev.arg(root.join("scripts/dev-sidecar.mjs")).current_dir(root);
        dev
    } else {
        let mut packaged = Command::new(resources.join("node.exe"));
        packaged.arg(resources.join("dist/app/sidecar.js")).current_dir(&resources);
        packaged
    };
    command
        .env("INBORA_PIPE_NONCE", &secret)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("INBORA_MODEL_KEY")
        .env_remove("DEEPSEEK_API_KEY")
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
    let backend = Arc::new(Backend {
        input: Mutex::new(Some(input)),
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        secret,
        #[cfg(windows)]
        _job: job,
    });
    let handle = app.handle().clone();
    let reader_backend = backend.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            if line.len() > 2_000_000 {
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(id) = value.get("requestId").and_then(Value::as_str) {
                if let Ok(mut pending) = reader_backend.pending.lock() {
                    if let Some(tx) = pending.remove(id) {
                        let result = if value.get("ok") == Some(&Value::Bool(true)) {
                            Ok(value.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(value
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("SIDECAR_ERROR")
                                .to_string())
                        };
                        let _ = tx.send(result);
                    }
                }
            } else if let Some(event) = value.get("event") {
                let _ = handle.emit("inbora_status_updated", event);
            }
        }
        if let Ok(mut pending) = reader_backend.pending.lock() {
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err("SIDECAR_CLOSED".into()));
            }
        }
        let _ = handle.emit("inbora_status_updated", json!({"event":"sidecar_closed"}));
    });
    Ok(Desktop(backend))
}

fn shutdown(backend: &Backend) {
    if let Ok(mut input) = backend.input.lock() {
        input.take();
    }
    if let Ok(mut child) = backend.child.lock() {
        for _ in 0..400 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
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
            client_request
        ])
        .build(tauri::generate_context!())
        .expect("INBORA_DESKTOP_START_FAILED")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown(&handle.state::<Desktop>().0);
            }
        });
}
