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
        "replyKnowledge",
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

const MAX_SIDECAR_LINE_BYTES: usize = 2_000_000;
const OVERSIZED_PREFIX_BYTES: usize = 256;
const REQUEST_ID_PREFIX: &[u8] = b"{\"protocol\":1,\"requestId\":\"";
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

#[derive(Debug, PartialEq, Eq)]
enum BoundedLine {
    Line(String),
    Oversized(Option<String>),
    InvalidUtf8,
    Eof,
}

fn is_canonical_uuid_bytes(bytes: &[u8]) -> bool {
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn extract_prefix_request_id(prefix: &[u8]) -> Option<String> {
    let rest = prefix.strip_prefix(REQUEST_ID_PREFIX)?;
    if rest.len() < 38 || rest[36] != b'"' || !matches!(rest[37], b',' | b'}') {
        return None;
    }
    let id = &rest[..36];
    if is_canonical_uuid_bytes(id) {
        std::str::from_utf8(id).ok().map(str::to_string)
    } else {
        None
    }
}

fn configure_sidecar_env<'a>(command: &'a mut Command, secret: &str) -> &'a mut Command {
    command.env("INBORA_PIPE_NONCE", secret);
    for name in STRIPPED_SIDECAR_ENV_VARS {
        command.env_remove(name);
    }
    command
}

fn read_bounded_line(reader: &mut impl BufRead, max_bytes: usize) -> std::io::Result<BoundedLine> {
    let mut buf = Vec::new();
    let mut prefix = Vec::new();
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            if oversized {
                return Ok(BoundedLine::Oversized(extract_prefix_request_id(&prefix)));
            }
            if buf.is_empty() {
                return Ok(BoundedLine::Eof);
            }
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(match String::from_utf8(buf) {
                Ok(line) => BoundedLine::Line(line),
                Err(_) => BoundedLine::InvalidUtf8,
            });
        }
        let newline = chunk.iter().position(|&b| b == b'\n');
        let slice = match newline {
            Some(pos) => &chunk[..pos],
            None => chunk,
        };
        if prefix.len() < OVERSIZED_PREFIX_BYTES {
            let take = (OVERSIZED_PREFIX_BYTES - prefix.len()).min(slice.len());
            prefix.extend_from_slice(&slice[..take]);
        }
        if !oversized {
            let effective_len = if newline.is_some() && slice.last() == Some(&b'\r') {
                slice.len() - 1
            } else {
                slice.len()
            };
            if buf.len() + effective_len > max_bytes {
                oversized = true;
                buf.clear();
            } else {
                buf.extend_from_slice(slice);
            }
        }
        let consumed = match newline {
            Some(pos) => pos + 1,
            None => chunk.len(),
        };
        reader.consume(consumed);
        if newline.is_some() {
            if oversized {
                return Ok(BoundedLine::Oversized(extract_prefix_request_id(&prefix)));
            }
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(match String::from_utf8(buf) {
                Ok(line) => BoundedLine::Line(line),
                Err(_) => BoundedLine::InvalidUtf8,
            });
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
        let mut reader = BufReader::new(output);
        loop {
            let line = match read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES) {
                Ok(BoundedLine::Line(line)) => line,
                Ok(BoundedLine::Oversized(request_id)) => {
                    if let Some(id) = request_id {
                        if let Ok(mut pending) = reader_backend.pending.lock() {
                            if let Some(tx) = pending.remove(&id) {
                                let _ = tx.send(Err("SIDECAR_RESPONSE_TOO_LARGE".into()));
                            }
                        }
                    }
                    let _ = handle.emit(
                        "inbora_status_updated",
                        json!({"event": "sidecar_response_too_large"}),
                    );
                    continue;
                }
                Ok(BoundedLine::InvalidUtf8) => continue,
                Ok(BoundedLine::Eof) | Err(_) => break,
            };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::io::Cursor;

    const SAMPLE_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";

    #[test]
    fn extract_prefix_request_id_handles_utf8_mid_character_truncation() {
        for pad in 0..4 {
            let padding = "a".repeat(pad);
            let line = format!(
                "{{\"protocol\":1,\"requestId\":\"{SAMPLE_UUID}\",\"ok\":true,\"result\":{{\"pad\":\"{padding}\",\"text\":\"{}\"}}}}",
                "你好世界😀".repeat(60)
            );
            let prefix = &line.as_bytes()[..OVERSIZED_PREFIX_BYTES];
            assert_eq!(
                extract_prefix_request_id(prefix).as_deref(),
                Some(SAMPLE_UUID),
                "failed for pad={pad}, valid_utf8={}",
                std::str::from_utf8(prefix).is_ok()
            );
        }
        // Explicitly verify a case where the 256-byte cut breaks a 3-byte Chinese UTF-8 sequence.
        let chinese_line = format!(
            "{{\"protocol\":1,\"requestId\":\"{SAMPLE_UUID}\",\"ok\":true,\"result\":{{\"text\":\"{}\"}}}}",
            "你好世界".repeat(100)
        );
        let chinese_prefix = &chinese_line.as_bytes()[..OVERSIZED_PREFIX_BYTES];
        assert!(
            std::str::from_utf8(chinese_prefix).is_err(),
            "test fixture must cut inside a multi-byte UTF-8 sequence"
        );
        assert_eq!(
            extract_prefix_request_id(chinese_prefix).as_deref(),
            Some(SAMPLE_UUID)
        );
    }

    #[test]
    fn extract_prefix_request_id_rejects_non_top_level_and_invalid_values() {
        let nested = format!(
            "{{\"protocol\":1,\"event\":{{\"requestId\":\"{SAMPLE_UUID}\"}},\"text\":\"{}\"}}",
            "你好".repeat(100)
        );
        assert_eq!(extract_prefix_request_id(nested.as_bytes()), None);

        let null_id = b"{\"protocol\":1,\"requestId\":null,\"ok\":false}";
        assert_eq!(extract_prefix_request_id(null_id), None);

        let wrong_protocol = format!(
            "{{\"protocol\":2,\"requestId\":\"{SAMPLE_UUID}\",\"ok\":true}}"
        );
        assert_eq!(extract_prefix_request_id(wrong_protocol.as_bytes()), None);

        let bad_uuid = b"{\"protocol\":1,\"requestId\":\"not-a-valid-uuid-at-all-000000000000\",\"ok\":true}";
        assert_eq!(extract_prefix_request_id(bad_uuid), None);

        let bad_delimiter = format!(
            "{{\"protocol\":1,\"requestId\":\"{SAMPLE_UUID}\"garbage}}"
        );
        assert_eq!(extract_prefix_request_id(bad_delimiter.as_bytes()), None);

        let closing_brace = format!("{{\"protocol\":1,\"requestId\":\"{SAMPLE_UUID}\"}}");
        assert_eq!(
            extract_prefix_request_id(closing_brace.as_bytes()).as_deref(),
            Some(SAMPLE_UUID)
        );
    }

    #[test]
    fn read_bounded_line_recovers_request_id_on_over_2mb_chinese_response_and_continues() {
        let huge_payload = "你好世界".repeat(200_000); // 2.4 MB UTF-8
        let oversized = format!(
            "{{\"protocol\":1,\"requestId\":\"{SAMPLE_UUID}\",\"ok\":true,\"result\":{{\"text\":\"{huge_payload}\"}}}}\n"
        );
        assert!(oversized.len() > MAX_SIDECAR_LINE_BYTES);
        let next_line = "{\"protocol\":1,\"event\":{\"event\":\"status_updated\"}}\r\n";
        let mut combined = Vec::with_capacity(oversized.len() + next_line.len());
        combined.extend_from_slice(oversized.as_bytes());
        combined.extend_from_slice(next_line.as_bytes());

        let mut reader = BufReader::with_capacity(64, Cursor::new(combined));
        let first = read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES).unwrap();
        assert_eq!(first, BoundedLine::Oversized(Some(SAMPLE_UUID.to_string())));

        let second = read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES).unwrap();
        assert_eq!(
            second,
            BoundedLine::Line("{\"protocol\":1,\"event\":{\"event\":\"status_updated\"}}".into())
        );

        let third = read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES).unwrap();
        assert_eq!(third, BoundedLine::Eof);
    }

    #[test]
    fn read_bounded_line_handles_oversized_eof_nested_event_and_invalid_utf8() {
        // Oversized response ending at EOF without newline
        let oversized_eof = format!(
            "{{\"protocol\":1,\"requestId\":\"{SAMPLE_UUID}\",\"ok\":true,\"result\":{{\"text\":\"{}\"}}}}",
            "中文内容".repeat(40)
        );
        let mut reader = BufReader::with_capacity(32, Cursor::new(oversized_eof.into_bytes()));
        assert_eq!(
            read_bounded_line(&mut reader, 256).unwrap(),
            BoundedLine::Oversized(Some(SAMPLE_UUID.to_string()))
        );
        assert_eq!(read_bounded_line(&mut reader, 256).unwrap(), BoundedLine::Eof);

        // Oversized non-top-level event returns Oversized(None)
        let oversized_event = format!(
            "{{\"protocol\":1,\"event\":{{\"requestId\":\"{SAMPLE_UUID}\",\"data\":\"{}\"}}}}\n",
            "中文内容".repeat(40)
        );
        let mut event_reader = BufReader::with_capacity(32, Cursor::new(oversized_event.into_bytes()));
        assert_eq!(
            read_bounded_line(&mut event_reader, 256).unwrap(),
            BoundedLine::Oversized(None)
        );

        // Short invalid UTF-8 line returns InvalidUtf8, followed by Eof
        let invalid = vec![0xff, 0xfe, b'\n'];
        let mut invalid_reader = BufReader::new(Cursor::new(invalid));
        assert_eq!(
            read_bounded_line(&mut invalid_reader, 256).unwrap(),
            BoundedLine::InvalidUtf8
        );
        assert_eq!(read_bounded_line(&mut invalid_reader, 256).unwrap(), BoundedLine::Eof);
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
        for name in STRIPPED_SIDECAR_ENV_VARS {
            assert_eq!(
                envs.get(OsStr::new(name)),
                Some(&None),
                "expected {name} to be explicitly removed from child environment"
            );
        }
    }
}
