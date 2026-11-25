#[cfg(any(windows, test))]
use serde::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(any(windows, test))]
use std::io::Write;
use std::{
    io::{self, BufRead, Read},
    ops::Deref,
};

pub const MAX_SIDECAR_LINE_BYTES: usize = 2_000_000;
pub const MAX_PROTOCOL_V2_FRAME_BYTES: usize = 1_048_576;
#[cfg(any(windows, test))]
const MAX_NATIVE_BRIDGE_BYTES: usize = 262_144;
const OVERSIZED_PREFIX_BYTES: usize = 256;
const REQUEST_ID_PREFIX_V1: &[u8] = b"{\"protocol\":1,\"requestId\":\"";
const REQUEST_ID_PREFIX_V2: &[u8] = b"{\"protocol\":2,\"requestId\":\"";

pub fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        // Keep these writes even when the allocation is about to be freed.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

#[derive(Clone, Default)]
pub struct ZeroizingBytes(pub Vec<u8>);

impl ZeroizingBytes {
    fn clear(&mut self) {
        wipe(&mut self.0);
        self.0.clear();
    }

    fn extend(&mut self, bytes: &[u8]) {
        let required = self.0.len() + bytes.len();
        if required > self.0.capacity() {
            // Vec's normal growth would free the old allocation with its contents intact.
            let mut next = Self(Vec::with_capacity(required.max(self.0.capacity() * 2)));
            next.0.extend_from_slice(&self.0);
            *self = next;
        }
        self.0.extend_from_slice(bytes);
    }

    fn into_line(mut self) -> Option<ZeroizingString> {
        match String::from_utf8(std::mem::take(&mut self.0)) {
            Ok(line) => Some(line.into()),
            Err(error) => {
                wipe(&mut error.into_bytes());
                None
            }
        }
    }
}

impl Drop for ZeroizingBytes {
    fn drop(&mut self) {
        self.clear();
    }
}

#[cfg(any(windows, test))]
impl Write for ZeroizingBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_NATIVE_BRIDGE_BYTES - self.0.len() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.extend(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ZeroizingString(String);

impl From<String> for ZeroizingString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[cfg(test)]
impl From<&str> for ZeroizingString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

#[cfg(any(windows, test))]
impl<'de> Deserialize<'de> for ZeroizingString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Canonical Base64 from Node needs no JSON escapes. Borrow directly from the frame.
        <&str>::deserialize(deserializer).map(|value| value.to_owned().into())
    }
}

impl Deref for ZeroizingString {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ZeroizingString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ZeroizingString([redacted])")
    }
}

impl Drop for ZeroizingString {
    fn drop(&mut self) {
        // Zero is valid UTF-8, and the string is exclusively borrowed until the wipe completes.
        unsafe { wipe(self.0.as_mut_vec()) };
    }
}

/// BufReader does not expose its consumed bytes for erasure.
pub struct FrameReader<R> {
    input: R,
    bytes: ZeroizingBytes,
    start: usize,
    end: usize,
}

impl<R: Read> FrameReader<R> {
    pub fn new(input: R) -> Self {
        Self {
            input,
            bytes: ZeroizingBytes(vec![0; 8192]),
            start: 0,
            end: 0,
        }
    }
}

impl<R: Read> Read for FrameReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let read = self.fill_buf()?.read(output)?;
        self.consume(read);
        Ok(read)
    }
}

impl<R: Read> BufRead for FrameReader<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if self.start == self.end {
            self.start = 0;
            self.end = 0;
            self.end = self.input.read(&mut self.bytes.0)?;
        }
        Ok(&self.bytes.0[self.start..self.end])
    }

    fn consume(&mut self, amount: usize) {
        let end = self.start + amount.min(self.end - self.start);
        wipe(&mut self.bytes.0[self.start..end]);
        self.start = end;
    }
}

fn valid_scope(scope: &Value) -> bool {
    let Some(scope) = scope.as_object() else {
        return false;
    };
    match scope.get("kind").and_then(Value::as_str) {
        Some("GLOBAL") => scope.len() == 1,
        Some("ACCOUNT") if scope.len() == 2 => scope
            .get("accountRef")
            .and_then(Value::as_str)
            .is_some_and(|id| {
                let mut bytes = id.bytes();
                id.len() <= 128
                    && bytes
                        .next()
                        .is_some_and(|byte| byte.is_ascii_alphanumeric())
                    && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            }),
        _ => false,
    }
}

fn is_schema_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    is_canonical_uuid_bytes(bytes)
        && ((matches!(bytes[14], b'1'..=b'8')
            && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B'))
            || matches!(
                value,
                "00000000-0000-0000-0000-000000000000" | "ffffffff-ffff-ffff-ffff-ffffffffffff"
            ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct V2Request<'a> {
    protocol: u8,
    request_id: &'a str,
    secret: &'a str,
    scope: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_id: Option<String>,
    body: Value,
}

pub fn encode_v2_request(
    request_id: &str,
    secret: &str,
    scope: Value,
    body: Value,
    command_id: Option<String>,
) -> Result<String, String> {
    if !valid_scope(&scope) {
        return Err("INVALID_SCOPE".into());
    }
    if command_id.as_deref().is_some_and(|id| !is_schema_uuid(id)) {
        return Err("INVALID_COMMAND_ID".into());
    }
    let line = serde_json::to_string(&V2Request {
        protocol: 2,
        request_id,
        secret,
        scope,
        command_id,
        body,
    })
    .map_err(|_| "INVALID_COMMAND")?;
    if line.len() > MAX_PROTOCOL_V2_FRAME_BYTES {
        return Err("IPC_REQUEST_TOO_LARGE".into());
    }
    Ok(line)
}

#[derive(Deserialize)]
struct FrameKind<'a> {
    #[serde(borrow)]
    kind: Option<&'a str>,
}

pub fn frame_kind(line: &str) -> Result<Option<&str>, serde_json::Error> {
    serde_json::from_str::<FrameKind<'_>>(line).map(|frame| frame.kind)
}

#[cfg(windows)]
pub fn is_authenticated_cache_reset(line: &str, expected: &str) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CacheReset<'a> {
        kind: &'a str,
        secret: &'a str,
    }
    line.len() <= 160 && serde_json::from_str::<CacheReset<'_>>(line)
        .is_ok_and(|frame| frame.kind == "dev_sidecar_cache_reset" && frame.secret == expected)
}

pub fn sidecar_event(frame: &Value) -> Option<(&'static str, &Value)> {
    let event = frame.get("event")?;
    match frame.get("protocol").and_then(Value::as_u64) {
        Some(1) => Some(("inbora_status_updated", event)),
        Some(2) if frame.get("scope").is_some_and(valid_scope) => {
            Some(("inbora_status_updated_v2", frame))
        }
        _ => None,
    }
}

#[cfg(any(windows, test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeBridgeEnvelope<'a, T> {
    kind: &'a str,
    bridge_id: &'a str,
    secret: &'a str,
    payload: T,
}

#[cfg(any(windows, test))]
pub fn native_bridge_request(
    line: &str,
    secret: &str,
) -> Option<(String, Result<NativeBridgeRequest, String>)> {
    if line.len() > MAX_NATIVE_BRIDGE_BYTES {
        return None;
    }
    let frame =
        serde_json::from_str::<NativeBridgeEnvelope<'_, serde::de::IgnoredAny>>(line).ok()?;
    if frame.kind != "native_bridge_request"
        || frame.secret != secret
        || !is_schema_uuid(frame.bridge_id)
    {
        return None;
    }
    let request = serde_json::from_str::<NativeBridgeEnvelope<'_, NativeBridgeRequest>>(line)
        .map(|frame| frame.payload)
        .map_err(|_| "NATIVE_BRIDGE_INVALID_PAYLOAD".into());
    Some((frame.bridge_id.to_owned(), request))
}

#[cfg(any(windows, test))]
pub fn encode_native_bridge_response<T: Serialize>(
    bridge_id: &str,
    secret: &str,
    result: Result<T, String>,
) -> ZeroizingString {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Response<'a, T> {
        kind: &'static str,
        bridge_id: &'a str,
        secret: &'a str,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<T>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    }

    let serialize = |result: Option<&T>, error: Option<&str>| {
        let frame = Response {
            kind: "native_bridge_response",
            bridge_id,
            secret,
            ok: error.is_none(),
            result,
            error,
        };
        let mut bytes = ZeroizingBytes::default();
        serde_json::to_writer(&mut bytes, &frame).ok()?;
        bytes.into_line()
    };
    let line = match &result {
        Ok(value) => serialize(Some(value), None),
        Err(error) => serialize(None, Some(error.as_str())),
    };
    line.unwrap_or_else(|| {
        serialize(None, Some("NATIVE_BRIDGE_RESPONSE_TOO_LARGE")).expect("bounded bridge error")
    })
}

#[cfg(any(windows, test))]
fn optional_field<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[cfg(any(windows, test))]
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeBridgeRequest {
    DpapiProtect {
        data_base64: ZeroizingString,
        entropy: String,
    },
    DpapiUnprotect {
        data_base64: ZeroizingString,
        entropy: String,
        #[serde(default, deserialize_with = "optional_field")]
        cache_key: Option<String>,
        #[serde(default, deserialize_with = "optional_field")]
        mtime_ms: Option<f64>,
    },
    ClearDpapiCache {
        #[serde(default, deserialize_with = "optional_field")]
        cache_key: Option<String>,
    },
    SampleProcessTree {
        root_pid: u32,
        #[serde(default, deserialize_with = "optional_field")]
        target_exe: Option<String>,
        #[serde(default, deserialize_with = "optional_field")]
        max_age_ms: Option<u64>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum BoundedLine {
    Line(ZeroizingString),
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
    let rest = prefix
        .strip_prefix(REQUEST_ID_PREFIX_V1)
        .or_else(|| prefix.strip_prefix(REQUEST_ID_PREFIX_V2))?;
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

pub fn read_bounded_line(
    reader: &mut impl BufRead,
    max_bytes: usize,
) -> std::io::Result<BoundedLine> {
    let mut buf = ZeroizingBytes::default();
    let mut prefix = ZeroizingBytes(Vec::with_capacity(OVERSIZED_PREFIX_BYTES));
    let mut oversized = false;
    let mut limit = max_bytes;
    loop {
        let chunk = reader.fill_buf()?;
        let eof = chunk.is_empty();
        let newline = chunk.iter().position(|&b| b == b'\n');
        let slice = match newline {
            Some(pos) => &chunk[..pos],
            None => chunk,
        };
        if prefix.0.len() < OVERSIZED_PREFIX_BYTES {
            let take = (OVERSIZED_PREFIX_BYTES - prefix.0.len()).min(slice.len());
            prefix.extend(&slice[..take]);
            if prefix.0.starts_with(REQUEST_ID_PREFIX_V2) {
                limit = limit.min(MAX_PROTOCOL_V2_FRAME_BYTES);
            }
        }
        if !oversized {
            // Permit one trailing CR even when it arrives in a chunk before the LF.
            let trailing_cr = slice.last().or_else(|| buf.0.last()) == Some(&b'\r');
            if buf.0.len() + slice.len() > limit + usize::from(trailing_cr) {
                oversized = true;
                buf.clear();
            } else {
                buf.extend(slice);
            }
        }
        let consumed = match newline {
            Some(pos) => pos + 1,
            None => chunk.len(),
        };
        reader.consume(consumed);
        if newline.is_some() || eof {
            if oversized {
                return Ok(BoundedLine::Oversized(extract_prefix_request_id(&prefix.0)));
            }
            if buf.0.is_empty() && eof {
                return Ok(BoundedLine::Eof);
            }
            if buf.0.last() == Some(&b'\r') {
                buf.0.pop();
            }
            return Ok(match buf.into_line() {
                Some(line) => BoundedLine::Line(line),
                None => BoundedLine::InvalidUtf8,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufReader, Cursor};

    const SAMPLE_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";

    #[test]
    fn protocol_v2_request_checks_scope_command_id_and_wire_size() {
        let valid_scope = json!({"kind":"ACCOUNT","accountRef":"account_001"});
        let body =
            json!({"command":"accounts","action":"getAccountStatus","accountRef":"account_001"});
        let line = encode_v2_request(
            SAMPLE_UUID,
            "nonce",
            valid_scope.clone(),
            body.clone(),
            Some(SAMPLE_UUID.into()),
        )
        .unwrap();
        assert_eq!(
            extract_prefix_request_id(line.as_bytes()).as_deref(),
            Some(SAMPLE_UUID)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({"protocol":2,"requestId":SAMPLE_UUID,"secret":"nonce","scope":valid_scope,"commandId":SAMPLE_UUID,"body":body})
        );
        let global = json!({"kind":"GLOBAL"});
        let line =
            encode_v2_request(SAMPLE_UUID, "nonce", global.clone(), body.clone(), None).unwrap();
        assert!(serde_json::from_str::<Value>(&line)
            .unwrap()
            .get("commandId")
            .is_none());

        for invalid in [
            json!("GLOBAL"),
            json!({"kind":"GLOBAL","accountRef":"account_001"}),
            json!({"kind":"ACCOUNT"}),
            json!({"kind":"ACCOUNT","accountRef":"_bad"}),
            json!({"kind":"ACCOUNT","accountRef":"中文"}),
            json!({"kind":"ACCOUNT","accountRef":"a".repeat(129)}),
            json!({"kind":"ACCOUNT","accountRef":"account_001","extra":7}),
        ] {
            assert_eq!(
                encode_v2_request(SAMPLE_UUID, "nonce", invalid, body.clone(), None).unwrap_err(),
                "INVALID_SCOPE"
            );
        }
        assert_eq!(
            encode_v2_request(
                SAMPLE_UUID,
                "nonce",
                global.clone(),
                body,
                Some("bad".into())
            )
            .unwrap_err(),
            "INVALID_COMMAND_ID"
        );

        let empty = encode_v2_request(
            SAMPLE_UUID,
            "nonce",
            global.clone(),
            json!({"data":""}),
            None,
        )
        .unwrap();
        let padding = MAX_PROTOCOL_V2_FRAME_BYTES - empty.len();
        let exact = encode_v2_request(
            SAMPLE_UUID,
            "nonce",
            global.clone(),
            json!({"data":"x".repeat(padding)}),
            None,
        )
        .unwrap();
        assert_eq!(exact.len(), MAX_PROTOCOL_V2_FRAME_BYTES);
        let oversized = json!({"data":format!("{}中", "x".repeat(padding))});
        assert_eq!(
            encode_v2_request(SAMPLE_UUID, "nonce", global, oversized, None).unwrap_err(),
            "IPC_REQUEST_TOO_LARGE"
        );
    }

    #[test]
    fn v2_frames_have_one_mib_limit_and_v1_keeps_legacy_limit() {
        let line = |version, len| {
            let prefix =
                format!("{{\"protocol\":{version},\"requestId\":\"{SAMPLE_UUID}\",\"result\":\"");
            let padding = "x".repeat(len - prefix.len() - 2);
            format!("{prefix}{padding}\"}}")
        };
        let oversized_v2 = line(2, MAX_PROTOCOL_V2_FRAME_BYTES + 1);
        let exact_v2 = line(2, MAX_PROTOCOL_V2_FRAME_BYTES);
        let legacy = line(1, MAX_PROTOCOL_V2_FRAME_BYTES + 1);
        let frames = format!("{oversized_v2}\n{exact_v2}\r\n{legacy}\n");
        let mut reader = BufReader::with_capacity(256, Cursor::new(frames));
        assert_eq!(
            read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES).unwrap(),
            BoundedLine::Oversized(Some(SAMPLE_UUID.into()))
        );
        assert_eq!(
            read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES).unwrap(),
            BoundedLine::Line(exact_v2.into())
        );
        assert_eq!(
            read_bounded_line(&mut reader, MAX_SIDECAR_LINE_BYTES).unwrap(),
            BoundedLine::Line(legacy.into())
        );
    }

    #[test]
    fn bridge_frames_require_an_authenticated_uuid_and_have_their_own_limit() {
        let secret = "a".repeat(64);
        let payload = json!({"op":"dpapiProtect","dataBase64":"Zm9v","entropy":"fixture"});
        let frame = json!({"kind":"native_bridge_request","bridgeId":SAMPLE_UUID,"secret":secret,"payload":payload});
        let line = frame.to_string();
        assert_eq!(frame_kind(&line).unwrap(), Some("native_bridge_request"));
        assert!(native_bridge_request(&line, &"b".repeat(64)).is_none());
        let oversized = format!("{line}{}", " ".repeat(MAX_NATIVE_BRIDGE_BYTES));
        assert!(native_bridge_request(&oversized, &secret).is_none());
        let mut missing_id = frame.clone();
        missing_id["bridgeId"] = json!("");
        assert!(native_bridge_request(&missing_id.to_string(), &secret).is_none());
        let (id, accepted) = native_bridge_request(&line, &secret).unwrap();
        assert_eq!(id, SAMPLE_UUID);
        assert!(
            matches!(accepted, Ok(NativeBridgeRequest::DpapiProtect { data_base64, entropy })
            if &*data_base64 == "Zm9v" && entropy == "fixture")
        );
        let reply = encode_native_bridge_response(&id, &secret, Ok(json!({"cleared":true})));
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap(),
            json!({"kind":"native_bridge_response","bridgeId":SAMPLE_UUID,"secret":secret,"ok":true,"result":{"cleared":true}})
        );
        let too_large = encode_native_bridge_response(
            &id,
            &secret,
            Ok(json!("a".repeat(MAX_NATIVE_BRIDGE_BYTES))),
        );
        let reply = serde_json::from_str::<Value>(&too_large).unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "NATIVE_BRIDGE_RESPONSE_TOO_LARGE");
    }

    #[test]
    fn forwards_each_event_once_on_its_protocol_channel() {
        let event = json!({"event":"status_updated"});
        let v1 = json!({"protocol":1,"event":event});
        let v2 = json!({"protocol":2,"scope":{"kind":"GLOBAL"},"event":event});
        assert_eq!(
            [&v1, &v2].into_iter().filter_map(sidecar_event).collect::<Vec<_>>(),
            vec![("inbora_status_updated", &event), ("inbora_status_updated_v2", &v2)]
        );
        assert!(sidecar_event(&json!({"protocol":2,"event":event})).is_none());
        assert!(sidecar_event(&json!({"protocol":3,"event":event})).is_none());
    }

    #[test]
    fn reader_wipes_consumed_pipe_bytes_and_keeps_unread_frames() {
        let mut reader = FrameReader::new(Cursor::new(b"secret\nevent\n"));
        assert_eq!(
            read_bounded_line(&mut reader, 32).unwrap(),
            BoundedLine::Line("secret".into())
        );
        assert_eq!(&reader.bytes.0[..7], &[0; 7]);
        assert_eq!(
            read_bounded_line(&mut reader, 32).unwrap(),
            BoundedLine::Line("event".into())
        );
        assert_eq!(&reader.bytes.0[..13], &[0; 13]);
    }

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

        let wrong_protocol =
            format!("{{\"protocol\":3,\"requestId\":\"{SAMPLE_UUID}\",\"ok\":true}}");
        assert_eq!(extract_prefix_request_id(wrong_protocol.as_bytes()), None);

        let bad_uuid =
            b"{\"protocol\":1,\"requestId\":\"not-a-valid-uuid-at-all-000000000000\",\"ok\":true}";
        assert_eq!(extract_prefix_request_id(bad_uuid), None);

        let bad_delimiter = format!("{{\"protocol\":1,\"requestId\":\"{SAMPLE_UUID}\"garbage}}");
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
        assert_eq!(
            read_bounded_line(&mut reader, 256).unwrap(),
            BoundedLine::Eof
        );

        // Oversized non-top-level event returns Oversized(None)
        let oversized_event = format!(
            "{{\"protocol\":1,\"event\":{{\"requestId\":\"{SAMPLE_UUID}\",\"data\":\"{}\"}}}}\n",
            "中文内容".repeat(40)
        );
        let mut event_reader =
            BufReader::with_capacity(32, Cursor::new(oversized_event.into_bytes()));
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
        assert_eq!(
            read_bounded_line(&mut invalid_reader, 256).unwrap(),
            BoundedLine::Eof
        );
    }
}
