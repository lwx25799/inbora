use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    mem::size_of,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_NO_MORE_FILES, FILETIME, HANDLE,
        INVALID_HANDLE_VALUE, STILL_ACTIVE,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX},
        Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

const MAX_PROCESS_ROWS: usize = 16_384;
const MAX_PROCESS_CACHE_ENTRIES: usize = 64;
pub const DEFAULT_SAMPLE_AGE_MS: u64 = 2000;
pub const MAX_SAMPLE_AGE_MS: u64 = 30_000;
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeProcessRow {
    pid: u32,
    parent_pid: u32,
    name: String,
    created_at: u64,
    working_set_bytes: Option<usize>,
    private_bytes: Option<usize>,
    cpu_seconds: Option<f64>,
    stat_created_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProcessSample {
    rows: Vec<NativeProcessRow>,
    sampled_at: u64,
    cached: bool,
}

struct ProcessEntry {
    pid: u32,
    parent_pid: u32,
    name: String,
}

fn process_snapshot() -> Result<(ProcessEntryMap, u64), String> {
    // Use the last time known before the snapshot. A later timestamp could admit a reused PID.
    let since_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "INVALID_SAMPLE")?;
    let snapshot_upper_bound_ticks = FILETIME_UNIX_EPOCH + (since_unix.as_nanos() / 100) as u64;
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(process_error());
    }
    let snapshot = Handle(raw);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut available = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let mut by_parent = HashMap::<u32, Vec<ProcessEntry>>::new();
    while available != 0 {
        if entry.th32ProcessID != 0 {
            let mut name_units = entry.szExeFile[..128].split(|&unit| unit == 0);
            let name = String::from_utf16_lossy(name_units.next().unwrap_or_default());
            by_parent
                .entry(entry.th32ParentProcessID)
                .or_default()
                .push(ProcessEntry {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    name,
                });
        }
        available = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
        return Err(process_error());
    }
    Ok((by_parent, snapshot_upper_bound_ticks))
}

type ProcessEntryMap = HashMap<u32, Vec<ProcessEntry>>;

fn process_error() -> String {
    if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
        "ACCESS_DENIED".into()
    } else {
        "PROCESS_UNAVAILABLE".into()
    }
}

fn ticks(value: FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

fn process_times(pid: u32) -> Result<(Handle, u64, f64), String> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        return Err(process_error());
    }
    let handle = Handle(raw);
    let [mut created, mut exited, mut kernel, mut user] = [FILETIME::default(); 4];
    let mut exit_code = 0;
    if unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
    {
        return Err(process_error());
    }
    if unsafe { GetExitCodeProcess(handle.0, &mut exit_code) } == 0 {
        return Err(process_error());
    }
    let created = ticks(created);
    if created < FILETIME_UNIX_EPOCH + 10_000 || exit_code != STILL_ACTIVE as u32 {
        return Err("PROCESS_UNAVAILABLE".into());
    }
    Ok((
        handle,
        created,
        (ticks(kernel) + ticks(user)) as f64 / 10_000_000.0,
    ))
}

fn process_row(
    entry: &ProcessEntry,
    handle: &Handle,
    created: u64,
    cpu: Option<f64>,
) -> NativeProcessRow {
    let mut memory = PROCESS_MEMORY_COUNTERS_EX {
        cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    let has_memory = cpu.is_some()
        && unsafe {
            GetProcessMemoryInfo(
                handle.0,
                (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
                memory.cb,
            )
        } != 0;
    let created_at = (created - FILETIME_UNIX_EPOCH) / 10_000;
    NativeProcessRow {
        pid: entry.pid,
        parent_pid: entry.parent_pid,
        name: entry.name.clone(),
        created_at,
        working_set_bytes: has_memory.then_some(memory.WorkingSetSize),
        private_bytes: has_memory.then_some(memory.PrivateUsage),
        cpu_seconds: cpu,
        stat_created_at: cpu.map(|_| created_at),
    }
}

struct CachedProcessSample {
    root_pid: u32,
    root_created: u64,
    target_exe: Option<String>,
    sampled: Instant,
    sample: NativeProcessSample,
}

static PROCESS_CACHE: Mutex<VecDeque<CachedProcessSample>> = Mutex::new(VecDeque::new());

pub fn sample_process_tree(
    root_pid: u32,
    target_exe: Option<&str>,
    max_age_ms: u64,
) -> Result<NativeProcessSample, String> {
    let target_exe = target_exe.map(str::to_lowercase);
    let (root_handle, root_created, root_cpu) = process_times(root_pid)?;
    let mut cache = PROCESS_CACHE.lock().map_err(|_| "PROCESS_UNAVAILABLE")?;
    let max_age = Duration::from_millis(max_age_ms.min(MAX_SAMPLE_AGE_MS));
    let matches_key =
        |entry: &CachedProcessSample| entry.root_pid == root_pid && entry.target_exe == target_exe;
    if max_age_ms != 0 {
        if let Some(entry) = cache.iter().find(|entry| {
            matches_key(entry)
                && entry.root_created == root_created
                && entry.sampled.elapsed() <= max_age
        }) {
            return Ok(NativeProcessSample {
                cached: true,
                ..entry.sample.clone()
            });
        }
    }

    let sampled = Instant::now();
    let (mut by_parent, snapshot_upper_bound_ticks) = process_snapshot()?;
    let snapshot_upper_bound_ms = (snapshot_upper_bound_ticks - FILETIME_UNIX_EPOCH) / 10_000;
    if root_created > snapshot_upper_bound_ticks {
        return Err("PROCESS_UNAVAILABLE".into());
    }
    let root = by_parent
        .values()
        .flatten()
        .find(|entry| entry.pid == root_pid)
        .ok_or("PROCESS_UNAVAILABLE")?;
    let mut rows = vec![process_row(
        root,
        &root_handle,
        root_created,
        Some(root_cpu),
    )];
    let mut seen = HashSet::from([root_pid]);
    let mut tree = VecDeque::from([(root_pid, root_created)]);
    while let Some((parent_pid, parent_created)) = tree.pop_front() {
        for entry in by_parent.remove(&parent_pid).unwrap_or_default() {
            if seen.contains(&entry.pid) {
                continue;
            }
            let (handle, created, cpu) = match process_times(entry.pid) {
                Ok(times) => times,
                Err(error) if error == "ACCESS_DENIED" => return Err(error),
                Err(_) => continue, // A process can exit between enumeration and OpenProcess.
            };
            // Compare at FILETIME precision, before createdAt is rounded down to milliseconds.
            if created < parent_created || created > snapshot_upper_bound_ticks {
                continue;
            }
            if rows.len() == MAX_PROCESS_ROWS {
                return Err("INVALID_SAMPLE".into());
            }
            let measure = target_exe
                .as_ref()
                .map_or(true, |target| entry.name.to_lowercase() == *target);
            rows.push(process_row(
                &entry,
                &handle,
                created,
                measure.then_some(cpu),
            ));
            seen.insert(entry.pid);
            tree.push_back((entry.pid, created));
        }
    }
    let sample = NativeProcessSample {
        rows,
        sampled_at: snapshot_upper_bound_ms,
        cached: false,
    };
    cache.retain(|entry| {
        !matches_key(entry) && entry.sampled.elapsed() <= Duration::from_millis(MAX_SAMPLE_AGE_MS)
    });
    if cache.len() >= MAX_PROCESS_CACHE_ENTRIES {
        cache.pop_front();
    }
    cache.push_back(CachedProcessSample {
        root_pid,
        root_created,
        target_exe,
        sampled,
        sample: sample.clone(),
    });
    Ok(sample)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_sampling_reports_current_process_with_real_metrics_and_caches() {
        let pid = std::process::id();
        let first = sample_process_tree(pid, None, 0).unwrap();
        let root = first.rows.iter().find(|row| row.pid == pid).unwrap();
        assert!(!first.cached);
        assert!(root.created_at > 0 && root.created_at <= first.sampled_at);
        assert_eq!(root.stat_created_at, Some(root.created_at));
        assert!(root.working_set_bytes.unwrap() > 0);
        assert!(root.private_bytes.unwrap() > 0);
        assert!(root.cpu_seconds.unwrap() >= 0.0);
        let cached = sample_process_tree(pid, None, 5000).unwrap();
        assert!(cached.cached);
        assert_eq!(cached.sampled_at, first.sampled_at);
        let other_target =
            sample_process_tree(pid, Some("inbora.exe"), DEFAULT_SAMPLE_AGE_MS).unwrap();
        assert!(!other_target.cached);
        assert_eq!(other_target.rows[0].pid, pid);
    }
}
