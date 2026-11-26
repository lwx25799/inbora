use crate::{
    protocol::{wipe, NativeBridgeRequest, ZeroizingBytes, ZeroizingString},
    win32_process::{
        sample_process_tree, NativeProcessSample, DEFAULT_SAMPLE_AGE_MS, MAX_SAMPLE_AGE_MS,
    },
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    ptr::{null, null_mut},
    sync::Mutex,
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        BCryptCloseAlgorithmProvider, BCryptHash, BCryptOpenAlgorithmProvider, CryptProtectData,
        CryptUnprotectData, BCRYPT_SHA256_ALGORITHM, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

const MAX_PLAINTEXT_BYTES: usize = 12_000;
const MAX_CIPHERTEXT_BYTES: usize = 16_000;
const MAX_CACHE_ENTRIES: usize = 64;
const INVALID_PAYLOAD: &str = "NATIVE_BRIDGE_INVALID_PAYLOAD";

struct DpapiOutput {
    blob: CRYPT_INTEGER_BLOB,
    plaintext: bool,
}

impl Drop for DpapiOutput {
    fn drop(&mut self) {
        if !self.blob.pbData.is_null() {
            // DPAPI owns this allocation until LocalFree. Only unprotect produces plaintext.
            unsafe {
                if self.plaintext {
                    wipe(std::slice::from_raw_parts_mut(
                        self.blob.pbData,
                        self.blob.cbData as usize,
                    ));
                }
                LocalFree(self.blob.pbData.cast());
            }
        }
    }
}

pub fn dpapi_protect(plaintext: &[u8], entropy: &str) -> Result<Vec<u8>, String> {
    dpapi(plaintext, entropy, false)
}

pub fn dpapi_unprotect(ciphertext: &[u8], entropy: &str) -> Result<Vec<u8>, String> {
    dpapi(ciphertext, entropy, true)
}

fn dpapi(input: &[u8], entropy: &str, decrypt: bool) -> Result<Vec<u8>, String> {
    let (max_input, max_output, error) = if decrypt {
        (
            MAX_CIPHERTEXT_BYTES,
            MAX_PLAINTEXT_BYTES,
            "DPAPI_UNPROTECT_FAILED",
        )
    } else {
        (
            MAX_PLAINTEXT_BYTES,
            MAX_CIPHERTEXT_BYTES,
            "DPAPI_PROTECT_FAILED",
        )
    };
    let size_error = "DPAPI_INVALID_SIZE";
    if input.len() > max_input || (decrypt && input.is_empty()) {
        return Err(size_error.into());
    }
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(entropy.len()).map_err(|_| size_error)?,
        pbData: entropy.as_bytes().as_ptr().cast_mut(),
    };
    let mut output = DpapiOutput {
        blob: CRYPT_INTEGER_BLOB::default(),
        plaintext: decrypt,
    };
    // These APIs read input and entropy, and allocate their output with LocalAlloc.
    // Omitting CRYPTPROTECT_LOCAL_MACHINE selects CurrentUser.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input_blob,
                null_mut(),
                &entropy_blob,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.blob,
            )
        } else {
            CryptProtectData(
                &input_blob,
                null(),
                &entropy_blob,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.blob,
            )
        }
    };
    if ok == 0 {
        return Err(error.into());
    }
    let len = output.blob.cbData as usize;
    if len > max_output {
        return Err(size_error.into());
    }
    if len == 0 {
        return Ok(Vec::new());
    }
    if output.blob.pbData.is_null() {
        return Err(error.into());
    }
    Ok(unsafe { std::slice::from_raw_parts(output.blob.pbData, len) }.to_vec())
}

#[derive(PartialEq)]
struct DpapiCacheKey {
    cache_key: String,
    entropy_hash: [u8; 32],
    mtime_ms: f64,
    ciphertext_hash: [u8; 32],
}

impl DpapiCacheKey {
    fn new(
        cache_key: String,
        entropy: &str,
        mtime_ms: f64,
        ciphertext: &[u8],
    ) -> Result<Self, String> {
        let mut provider = null_mut();
        let error = "DPAPI_CACHE_UNAVAILABLE";
        // A cache hit bypasses DPAPI authentication, so use a collision-resistant hash.
        if unsafe { BCryptOpenAlgorithmProvider(&mut provider, BCRYPT_SHA256_ALGORITHM, null(), 0) }
            < 0
        {
            return Err(error.into());
        }
        let mut entropy_hash = [0; 32];
        let mut ciphertext_hash = [0; 32];
        let hash = |input: &[u8], output: &mut [u8; 32]| unsafe {
            BCryptHash(
                provider,
                null(),
                0,
                input.as_ptr(),
                input.len() as u32,
                output.as_mut_ptr(),
                output.len() as u32,
            )
        };
        let ok = hash(entropy.as_bytes(), &mut entropy_hash) >= 0
            && hash(ciphertext, &mut ciphertext_hash) >= 0;
        unsafe { BCryptCloseAlgorithmProvider(provider, 0) };
        if !ok {
            return Err(error.into());
        }
        Ok(Self {
            cache_key,
            entropy_hash,
            mtime_ms,
            ciphertext_hash,
        })
    }
}

#[derive(Default)]
struct DpapiMtimeCache {
    state: Mutex<DpapiCacheState>,
}

#[derive(Default)]
struct DpapiCacheState {
    epoch: u64,
    suspended: bool,
    entries: VecDeque<(DpapiCacheKey, ZeroizingBytes)>,
}

impl DpapiMtimeCache {
    fn get(&self, epoch: u64, key: &DpapiCacheKey) -> Result<Option<ZeroizingBytes>, String> {
        let state = self.state.lock().map_err(|_| "DPAPI_CACHE_UNAVAILABLE")?;
        if state.suspended || state.epoch != epoch {
            return Ok(None);
        }
        Ok(state
            .entries
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, bytes)| bytes.clone()))
    }

    fn put(&self, epoch: u64, key: DpapiCacheKey, bytes: ZeroizingBytes) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "DPAPI_CACHE_UNAVAILABLE")?;
        if state.suspended || state.epoch != epoch {
            return Ok(());
        }
        let entries = &mut state.entries;
        entries.retain(|(candidate, _)| candidate != &key);
        if entries.len() >= MAX_CACHE_ENTRIES {
            entries.pop_front();
        }
        entries.push_back((key, bytes));
        Ok(())
    }

    fn clear(&self, cache_key: Option<&str>) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "DPAPI_CACHE_UNAVAILABLE")?;
        state
            .entries
            .retain(|(key, _)| cache_key.is_some_and(|target| key.cache_key != target));
        Ok(())
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode_base64(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(BASE64[(first >> 2) as usize] as char);
        encoded.push(BASE64[(((first & 3) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            BASE64[(((second & 15) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            BASE64[(third & 63) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

fn decode_base64(encoded: &str, max_bytes: usize) -> Result<ZeroizingBytes, String> {
    const INVALID_BASE64: &str = "DPAPI_INVALID_BASE64";
    let decode = |byte| match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(INVALID_BASE64),
    };
    let len = encoded.len();
    if len > max_bytes.div_ceil(3) * 4 {
        return Err("DPAPI_INVALID_SIZE".into());
    }
    if len % 4 != 0 {
        return Err(INVALID_BASE64.into());
    }
    let mut bytes = ZeroizingBytes(Vec::with_capacity(len / 4 * 3));
    let mut chunks = encoded.as_bytes().chunks_exact(4).peekable();
    while let Some(chunk) = chunks.next() {
        let first = decode(chunk[0])?;
        let second = decode(chunk[1])?;
        bytes.0.push((first << 2) | (second >> 4));
        if chunks.peek().is_none() && chunk[2..] == *b"==" && second & 15 == 0 {
            break;
        }
        let third = decode(chunk[2])?;
        bytes.0.push((second << 4) | (third >> 2));
        if chunks.peek().is_none() && chunk[3] == b'=' && third & 3 == 0 {
            break;
        }
        bytes.0.push((third << 6) | decode(chunk[3])?);
    }
    if bytes.0.len() > max_bytes {
        return Err("DPAPI_INVALID_SIZE".into());
    }
    Ok(bytes)
}

#[derive(Default)]
pub struct Win32BridgeState {
    dpapi: DpapiMtimeCache,
}

impl Win32BridgeState {
    pub fn cache_epoch(&self) -> Option<u64> {
        self.dpapi.state.lock().ok().map(|state| state.epoch)
    }

    pub fn active_cache_epoch(&self) -> Option<u64> {
        let state = self.dpapi.state.lock().ok()?;
        (!state.suspended).then_some(state.epoch)
    }

    pub fn advance_cache_epoch(&self) {
        if let Ok(mut state) = self.dpapi.state.lock() {
            state.entries.clear();
            state.epoch = state.epoch.wrapping_add(1);
        }
    }

    pub fn suspend_cache(&self) {
        if let Ok(mut state) = self.dpapi.state.lock() {
            state.entries.clear();
            state.epoch = state.epoch.wrapping_add(1);
            state.suspended = true;
        }
    }

    pub fn resume_cache(&self, epoch: u64) {
        if let Ok(mut state) = self.dpapi.state.lock() {
            if state.epoch == epoch {
                state.suspended = false;
            }
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum NativeBridgeResult {
    Data {
        #[serde(rename = "dataBase64")]
        data_base64: ZeroizingString,
    },
    Clear {
        cleared: bool,
    },
    Sample(NativeProcessSample),
}

impl NativeBridgeResult {
    fn data(bytes: &[u8]) -> Self {
        Self::Data {
            data_base64: encode_base64(bytes).into(),
        }
    }
}

pub fn handle_bridge_request(
    cache: &Win32BridgeState,
    epoch: Option<u64>,
    request: NativeBridgeRequest,
) -> Result<NativeBridgeResult, String> {
    match request {
        NativeBridgeRequest::DpapiProtect {
            data_base64,
            entropy,
        } => {
            let plaintext = decode_base64(&data_base64, MAX_PLAINTEXT_BYTES)?;
            drop(data_base64);
            let ciphertext = dpapi_protect(&plaintext.0, &entropy)?;
            Ok(NativeBridgeResult::data(&ciphertext))
        }
        NativeBridgeRequest::DpapiUnprotect {
            data_base64,
            entropy,
            cache_key,
            mtime_ms,
        } => {
            let ciphertext = decode_base64(&data_base64, MAX_CIPHERTEXT_BYTES)?;
            drop(data_base64);
            let key = match epoch.zip(cache_key.zip(mtime_ms)) {
                Some((epoch, (name, mtime))) => Some((
                    epoch,
                    DpapiCacheKey::new(name, &entropy, mtime, &ciphertext.0)?,
                )),
                None => None,
            };
            if let Some((epoch, key)) = &key {
                if let Some(plaintext) = cache.dpapi.get(*epoch, key)? {
                    return Ok(NativeBridgeResult::data(&plaintext.0));
                }
            }
            let plaintext = ZeroizingBytes(dpapi_unprotect(&ciphertext.0, &entropy)?);
            let result = NativeBridgeResult::data(&plaintext.0);
            if let Some((epoch, key)) = key {
                cache.dpapi.put(epoch, key, plaintext)?;
            }
            Ok(result)
        }
        NativeBridgeRequest::ClearDpapiCache { cache_key } => {
            cache.dpapi.clear(cache_key.as_deref())?;
            Ok(NativeBridgeResult::Clear { cleared: true })
        }
        NativeBridgeRequest::SampleProcessTree {
            root_pid,
            target_exe,
            max_age_ms,
        } => {
            let max_age_ms = max_age_ms.unwrap_or(DEFAULT_SAMPLE_AGE_MS);
            if root_pid == 0 || max_age_ms > MAX_SAMPLE_AGE_MS {
                return Err(INVALID_PAYLOAD.into());
            }
            let sample = sample_process_tree(root_pid, target_exe.as_deref(), max_age_ms)?;
            Ok(NativeBridgeResult::Sample(sample))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn dispatch_fixture(cache: &Win32BridgeState, payload: &Value) -> Result<Value, String> {
        let request = serde_json::from_str(&payload.to_string()).map_err(|_| INVALID_PAYLOAD)?;
        handle_bridge_request(cache, cache.active_cache_epoch(), request)
            .and_then(|value| serde_json::to_value(value).map_err(|_| INVALID_PAYLOAD.into()))
    }

    #[test]
    fn disconnect_clears_cache_and_prevents_late_dpapi_writes_from_refilling_it() {
        let cache = Win32BridgeState::default();
        let epoch = cache.active_cache_epoch().unwrap();
        let key = || DpapiCacheKey::new("model".into(), "fixture", 1.0, b"cipher").unwrap();
        cache
            .dpapi
            .put(epoch, key(), ZeroizingBytes(vec![1]))
            .unwrap();
        cache.suspend_cache();
        assert!(cache.active_cache_epoch().is_none());
        assert!(cache.dpapi.state.lock().unwrap().entries.is_empty());
        cache.resume_cache(epoch);
        assert!(cache.active_cache_epoch().is_none());

        let next_epoch = cache.cache_epoch().unwrap();
        cache.resume_cache(next_epoch);
        cache
            .dpapi
            .put(epoch, key(), ZeroizingBytes(vec![1]))
            .unwrap();
        assert!(cache.dpapi.get(next_epoch, &key()).unwrap().is_none());
        cache
            .dpapi
            .put(next_epoch, key(), ZeroizingBytes(vec![2]))
            .unwrap();
        assert_eq!(cache.dpapi.get(next_epoch, &key()).unwrap().unwrap().0, [2]);
    }

    #[test]
    fn base64_matches_rfc4648_and_round_trips_binary() {
        let examples = [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ];
        for (plain, encoded) in examples {
            assert_eq!(encode_base64(plain.as_bytes()), encoded);
            assert_eq!(
                &decode_base64(encoded, plain.len()).unwrap().0,
                plain.as_bytes()
            );
        }
        let binary: Vec<u8> = (0..=255).collect();
        assert_eq!(
            decode_base64(&encode_base64(&binary), binary.len())
                .unwrap()
                .0,
            binary
        );
    }

    #[test]
    fn base64_rejects_invalid_characters_padding_and_size() {
        for invalid in [
            "Zg=", "Zg==\n", "Zg!!", "AB==", "Zm9=", "Zg==Zg==", "Zg=_", "====", "中A",
        ] {
            assert!(decode_base64(invalid, 32).is_err());
        }
        assert!(decode_base64("Zm9v", 2).is_err());
        assert!(decode_base64("Zm9vZm9v", 2).is_err());
    }

    #[test]
    fn dpapi_round_trips_current_user_with_utf8_entropy_and_rejects_wrong_entropy() {
        let plaintext = b"synthetic\0credential\xff";
        let encrypted = dpapi_protect(plaintext, "测试 entropy").unwrap();
        assert_ne!(encrypted.as_slice(), &plaintext[..]);
        assert_eq!(
            dpapi_unprotect(&encrypted, "测试 entropy")
                .unwrap()
                .as_slice(),
            &plaintext[..]
        );
        assert_eq!(
            dpapi_unprotect(&encrypted, "wrong entropy").unwrap_err(),
            "DPAPI_UNPROTECT_FAILED"
        );
        assert!(dpapi_protect(&[0; MAX_PLAINTEXT_BYTES + 1], "").is_err());
        assert!(dpapi_unprotect(&[0; MAX_CIPHERTEXT_BYTES + 1], "").is_err());

        let boundary = [17; MAX_PLAINTEXT_BYTES];
        let encrypted = dpapi_protect(&boundary, "").unwrap();
        assert_eq!(dpapi_unprotect(&encrypted, "").unwrap(), boundary);
    }

    #[test]
    fn dpapi_cache_keys_bind_mtime_entropy_and_ciphertext_and_clear_by_key() {
        let cache = DpapiMtimeCache::default();
        let key = |name: &str, entropy: &str, mtime, ciphertext: &[u8]| {
            DpapiCacheKey::new(name.into(), entropy, mtime, ciphertext).unwrap()
        };
        cache
            .put(
                0,
                key("one", "entropy", 1.25, b"cipher"),
                ZeroizingBytes(vec![1]),
            )
            .unwrap();
        cache
            .put(
                0,
                key("two", "entropy", 1.25, b"cipher"),
                ZeroizingBytes(vec![2]),
            )
            .unwrap();
        assert_eq!(
            cache
                .get(0, &key("one", "entropy", 1.25, b"cipher"))
                .unwrap()
                .unwrap()
                .0,
            [1]
        );
        assert!(cache
            .get(0, &key("one", "entropy", 1.5, b"cipher"))
            .unwrap()
            .is_none());
        assert!(cache
            .get(0, &key("one", "other", 1.25, b"cipher"))
            .unwrap()
            .is_none());
        assert!(cache
            .get(0, &key("one", "entropy", 1.25, b"other"))
            .unwrap()
            .is_none());
        cache.clear(Some("one")).unwrap();
        assert!(cache
            .get(0, &key("one", "entropy", 1.25, b"cipher"))
            .unwrap()
            .is_none());
        assert!(cache
            .get(0, &key("two", "entropy", 1.25, b"cipher"))
            .unwrap()
            .is_some());
        cache.clear(None).unwrap();
        assert!(cache.state.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn dpapi_cache_evicts_oldest_entry_at_capacity() {
        let cache = DpapiMtimeCache::default();
        let key = |index: usize| DpapiCacheKey {
            cache_key: index.to_string(),
            entropy_hash: [0; 32],
            mtime_ms: 1.0,
            ciphertext_hash: [0; 32],
        };
        for index in 0..=MAX_CACHE_ENTRIES {
            cache.put(0, key(index), ZeroizingBytes(vec![1])).unwrap();
        }
        assert_eq!(cache.state.lock().unwrap().entries.len(), MAX_CACHE_ENTRIES);
        assert!(cache.get(0, &key(0)).unwrap().is_none());
        assert!(cache.get(0, &key(MAX_CACHE_ENTRIES)).unwrap().is_some());
    }

    #[test]
    fn bridge_dispatches_dpapi_and_rejects_invalid_shapes() {
        let state = Win32BridgeState::default();
        let protected = dispatch_fixture(
            &state,
            &json!({
                "op":"dpapiProtect", "dataBase64":"Zm9v", "entropy":"fixture"
            }),
        )
        .unwrap();
        let mut decrypt = json!({
            "op":"dpapiUnprotect", "dataBase64":protected["dataBase64"], "entropy":"fixture",
            "cacheKey":"model", "mtimeMs":1000.25
        });
        for _ in 0..2 {
            assert_eq!(
                dispatch_fixture(&state, &decrypt).unwrap(),
                json!({"dataBase64":"Zm9v"})
            );
        }
        assert_eq!(state.dpapi.state.lock().unwrap().entries.len(), 1);
        decrypt["entropy"] = json!("wrong");
        assert_eq!(
            dispatch_fixture(&state, &decrypt).unwrap_err(),
            "DPAPI_UNPROTECT_FAILED"
        );
        assert_eq!(
            dispatch_fixture(&state, &json!({"op":"clearDpapiCache","cacheKey":"model"})).unwrap(),
            json!({"cleared":true})
        );
        assert!(state.dpapi.state.lock().unwrap().entries.is_empty());
        for invalid in [
            json!({"op":"sampleProcessTree","rootPid":0}),
            json!({"op":"sampleProcessTree","rootPid":1,"maxAgeMs":30001}),
            json!({"op":"clearDpapiCache","cacheKey":null}),
            json!({"op":"clearDpapiCache","unexpected":true}),
        ] {
            assert_eq!(
                dispatch_fixture(&state, &invalid).unwrap_err(),
                INVALID_PAYLOAD
            );
        }
    }
}
