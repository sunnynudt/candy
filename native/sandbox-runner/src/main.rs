use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(target_os = "macos")]
use std::collections::BTreeSet;
#[cfg(target_os = "macos")]
use std::collections::VecDeque;
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(any(target_os = "macos", windows))]
use std::io::Read;
use std::io::{self, BufRead, Write};
#[cfg(target_os = "macos")]
use std::os::raw::c_void;
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::fs::{self, File};
#[cfg(windows)]
use std::iter::once;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::io::{FromRawHandle, RawHandle};
#[cfg(windows)]
use std::ptr::{null, null_mut};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use std::thread;

const PROTOCOL_VERSION: u32 = 1;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct RunRequest {
    v: u32,
    kind: String,
    #[serde(rename = "requestId")]
    request_id: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
    workspace: String,
    #[serde(default)]
    network: bool,
    #[serde(rename = "fullAccess", default)]
    full_access: bool,
    #[serde(rename = "allowProcessExec", default)]
    allow_process_exec: bool,
    #[serde(rename = "processExecPaths", default)]
    process_exec_paths: Vec<String>,
    #[serde(rename = "readOnlyPaths", default)]
    read_only_paths: Vec<String>,
    #[serde(rename = "parentPid", default)]
    parent_pid: u32,
    environment: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
struct CompletedResponse {
    v: u32,
    kind: &'static str,
    #[serde(rename = "requestId")]
    request_id: String,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    cancelled: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    v: u32,
    kind: &'static str,
    code: &'static str,
}

fn main() {
    #[cfg(target_os = "macos")]
    if let Some((parent_pid, process_group, target_pid)) = macos_reaper_arguments() {
        run_macos_reaper(parent_pid, process_group, target_pid);
        return;
    }
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    let mut input = stdin.lock();
    loop {
        let line = match read_bounded_line(&mut input) {
            Ok(Some(value)) => value,
            Ok(None) => break,
            Err(BoundedLineError::TooLarge) => {
                if writeln!(stdout, "{}", error_response("line_too_large")).is_err() {
                    break;
                }
                let _ = stdout.flush();
                break;
            }
            Err(BoundedLineError::InvalidUtf8 | BoundedLineError::Io) => break,
        };
        let response = response_for_line(&line);
        if writeln!(stdout, "{}", response).is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

#[derive(Debug)]
enum BoundedLineError {
    Io,
    InvalidUtf8,
    TooLarge,
}

fn read_bounded_line(reader: &mut impl BufRead) -> Result<Option<String>, BoundedLineError> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|_| BoundedLineError::Io)?;
        if buffer.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| BoundedLineError::InvalidUtf8);
        }
        if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            if line.len() + newline > MAX_LINE_BYTES {
                return Err(BoundedLineError::TooLarge);
            }
            line.extend_from_slice(&buffer[..newline]);
            reader.consume(newline + 1);
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| BoundedLineError::InvalidUtf8);
        }
        if line.len() + buffer.len() > MAX_LINE_BYTES {
            return Err(BoundedLineError::TooLarge);
        }
        line.extend_from_slice(buffer);
        let consumed = buffer.len();
        reader.consume(consumed);
    }
}

#[cfg(target_os = "macos")]
fn macos_reaper_arguments() -> Option<(u32, u32, u32)> {
    let mut arguments = std::env::args();
    if arguments.nth(1).as_deref() != Some("--macos-reaper") {
        return None;
    }
    let parent_pid = arguments.next()?.parse().ok()?;
    let process_group = arguments.next()?.parse().ok()?;
    let target_pid = arguments.next()?.parse().ok()?;
    if arguments.next().is_some() {
        return None;
    }
    Some((parent_pid, process_group, target_pid))
}

fn response_for_line(line: &str) -> String {
    if line.len() > MAX_LINE_BYTES {
        return error_response("line_too_large");
    }
    if contains_forbidden_secret_material(line) {
        return error_response("secret_forbidden");
    }
    let request: RunRequest = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return error_response("invalid_message"),
    };
    if request.v != PROTOCOL_VERSION {
        return error_response("unsupported_version");
    }
    if request.kind != "run" {
        return error_response("invalid_message");
    }
    if request.request_id.is_empty()
        || request.executable.is_empty()
        || request.cwd.is_empty()
        || request.workspace.is_empty()
    {
        return error_response("invalid_message");
    }
    if !request
        .environment
        .keys()
        .all(|key| is_safe_environment_key(key))
    {
        return error_response("secret_forbidden");
    }
    if request.network && !cfg!(any(target_os = "macos", windows)) {
        return error_response("network_forbidden");
    }
    if request.full_access && (!cfg!(target_os = "macos") || !request.network) {
        return error_response("full_access_unavailable");
    }
    if !is_absolute_path(Path::new(&request.cwd))
        || !is_absolute_path(Path::new(&request.workspace))
        || !is_absolute_path(Path::new(&request.executable))
    {
        return error_response("invalid_path");
    }

    #[cfg(target_os = "macos")]
    {
        return run_macos(request);
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(windows)]
        {
            return run_windows(request);
        }
        #[cfg(not(windows))]
        {
            let _ = request;
            error_response("unsupported_platform")
        }
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn getppid() -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn setpgid(pid: i32, pgid: i32) -> i32;
    fn signal(signal: i32, handler: extern "C" fn(i32)) -> extern "C" fn(i32);
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_listallpids(buffer: *mut c_void, buffersize: i32) -> i32;
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, buffersize: i32) -> i32;
}

#[cfg(target_os = "macos")]
static MACOS_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
#[repr(C)]
struct MacosProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [u8; 16],
    pbi_name: [u8; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
type TrackedMacosProcesses = BTreeMap<i32, (u64, u64)>;

#[cfg(target_os = "macos")]
fn run_macos(request: RunRequest) -> String {
    install_macos_signal_handler();
    MACOS_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    let workspace = match fs::canonicalize(&request.workspace) {
        Ok(path) => path,
        Err(_) => return error_response("invalid_path"),
    };
    let cwd = match fs::canonicalize(&request.cwd) {
        Ok(path) => path,
        Err(_) => return error_response("invalid_path"),
    };
    let executable = match fs::canonicalize(&request.executable) {
        Ok(path) => path,
        Err(_) => return error_response("invalid_path"),
    };
    if [&workspace, &cwd, &executable]
        .iter()
        .any(|path| !is_safe_profile_path(path))
    {
        return error_response("invalid_path");
    }
    if !cwd.starts_with(&workspace) {
        return error_response("workspace_escape");
    }
    let Some(workspace) = workspace.to_str() else {
        return error_response("invalid_path");
    };
    let Some(executable) = executable.to_str() else {
        return error_response("invalid_path");
    };
    let read_only_paths = request
        .read_only_paths
        .iter()
        .filter_map(|value| {
            let path = fs::canonicalize(value).ok()?;
            if !is_safe_profile_path(&path) {
                return None;
            }
            path.to_str().map(str::to_owned)
        })
        .collect::<Vec<_>>();
    let mut process_exec_paths = request
        .process_exec_paths
        .iter()
        .filter_map(|value| {
            let path = fs::canonicalize(value).ok()?;
            if !is_safe_profile_path(&path) || !path.is_dir() {
                return None;
            }
            path.to_str().map(str::to_owned)
        })
        .collect::<Vec<_>>();
    // `/bin/sh` may dispatch through this macOS-owned selector when npm runs
    // a package script. It is not user writable and remains a narrow process
    // execution/read root rather than widening `/private/var`.
    if Path::new("/private/var/select").is_dir() {
        process_exec_paths.push("/private/var/select".to_owned());
    }
    let profile = sandbox_profile(
        workspace,
        executable,
        request.network,
        request.allow_process_exec,
        &process_exec_paths,
        &read_only_paths,
    );
    let profile = if request.full_access {
        // Full access removes the normal workspace and network restrictions.
        // It deliberately retains a narrow Seatbelt denial for Keychain IPC:
        // Candy provider credentials must never become task-process data.
        full_access_sandbox_profile()
    } else {
        profile
    };
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .arg("-p")
        .arg(profile)
        .arg("--")
        .arg(executable)
        .args(&request.args)
        .current_dir(cwd)
        .env_clear()
        .envs(request.environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return completed_macos_error(request.request_id),
    };
    let child_pid = child.id();
    let process_group = child_pid;
    spawn_macos_reaper(request.parent_pid, process_group, child_pid);
    let Some(stdout) = child.stdout.take() else {
        terminate_macos_process_group(process_group, &BTreeMap::new(), true);
        let _ = child.wait();
        return completed_macos_error(request.request_id);
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_macos_process_group(process_group, &BTreeMap::new(), true);
        let _ = child.wait();
        return completed_macos_error(request.request_id);
    };
    let stdout_thread = thread::spawn(|| read_bounded(stdout));
    let stderr_thread = thread::spawn(|| read_bounded(stderr));
    let parent_pid = request.parent_pid;
    let mut descendants = BTreeMap::new();
    let mut status = None;
    let mut parent_lost = false;
    let mut cancelled = false;
    loop {
        match child.try_wait() {
            Ok(Some(value)) => {
                status = Some(value);
                break;
            }
            Ok(None) => {
                descendants.extend(macos_descendant_pids(child_pid));
                if MACOS_CANCEL_REQUESTED.load(Ordering::Relaxed) {
                    cancelled = true;
                    terminate_macos_process_group(process_group, &descendants, true);
                    status = child.wait().ok();
                    break;
                }
                if parent_pid > 0 && macos_parent_pid() != parent_pid {
                    parent_lost = true;
                    terminate_macos_process_group(process_group, &descendants, true);
                    status = child.wait().ok();
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => break,
        }
    }
    if status.is_none() {
        cancelled = true;
        terminate_macos_process_group(process_group, &descendants, true);
        status = child.wait().ok();
    }
    if status.is_some() && !parent_lost && !cancelled {
        terminate_macos_process_group(process_group, &descendants, false);
    }
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    let response = match status {
        Some(status) => CompletedResponse {
            v: PROTOCOL_VERSION,
            kind: "completed",
            request_id: request.request_id,
            code: status.code(),
            stdout,
            stderr,
            cancelled: parent_lost || cancelled,
        },
        None => return completed_macos_error(request.request_id),
    };
    serde_json::to_string(&response).unwrap_or_else(|_| error_response("runtime_error"))
}

#[cfg(target_os = "macos")]
fn completed_macos_error(request_id: String) -> String {
    serde_json::to_string(&CompletedResponse {
        v: PROTOCOL_VERSION,
        kind: "completed",
        request_id,
        code: None,
        stdout: String::new(),
        stderr: String::new(),
        cancelled: false,
    })
    .unwrap_or_else(|_| error_response("runtime_error"))
}

#[cfg(target_os = "macos")]
fn macos_parent_pid() -> u32 {
    unsafe { getppid() }.max(0) as u32
}

#[cfg(target_os = "macos")]
extern "C" fn macos_termination_handler(_: i32) {
    MACOS_CANCEL_REQUESTED.store(true, Ordering::Relaxed);
}

#[cfg(target_os = "macos")]
fn install_macos_signal_handler() {
    unsafe {
        signal(1, macos_termination_handler);
        signal(15, macos_termination_handler);
    }
}

#[cfg(target_os = "macos")]
fn spawn_macos_reaper(parent_pid: u32, process_group: u32, target_pid: u32) {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let mut command = Command::new(executable);
    command
        .arg("--macos-reaper")
        .arg(parent_pid.to_string())
        .arg(process_group.to_string())
        .arg(target_pid.to_string())
        .current_dir("/")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let _ = command.spawn();
}

#[cfg(target_os = "macos")]
fn run_macos_reaper(parent_pid: u32, process_group: u32, target_pid: u32) {
    let mut descendants = BTreeMap::new();
    loop {
        descendants.extend(macos_descendant_pids(target_pid));
        let parent_alive = parent_pid == 0 || macos_process_exists(parent_pid);
        if !parent_alive {
            terminate_macos_process_group(process_group, &descendants, true);
            return;
        }
        if !macos_process_exists(target_pid) {
            terminate_macos_process_group(process_group, &descendants, false);
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(target_os = "macos")]
fn macos_process_exists(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    pid > 0 && unsafe { kill(pid, 0) == 0 }
}

#[cfg(target_os = "macos")]
fn macos_descendant_pids(root_pid: u32) -> TrackedMacosProcesses {
    let Ok(root_pid) = i32::try_from(root_pid) else {
        return BTreeMap::new();
    };
    if root_pid <= 0 {
        return BTreeMap::new();
    }
    let mut pids = [0_i32; 4096];
    let returned = unsafe {
        proc_listallpids(
            pids.as_mut_ptr().cast(),
            std::mem::size_of_val(&pids) as i32,
        )
    };
    if returned <= 0 {
        return BTreeMap::new();
    }
    let mut children = BTreeMap::<i32, Vec<(i32, (u64, u64))>>::new();
    for pid in pids.into_iter().filter(|pid| *pid > 0) {
        let mut info = std::mem::MaybeUninit::<MacosProcBsdInfo>::zeroed();
        let result = unsafe {
            proc_pidinfo(
                pid,
                3,
                0,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<MacosProcBsdInfo>() as i32,
            )
        };
        if result < std::mem::size_of::<MacosProcBsdInfo>() as i32 {
            continue;
        }
        let info = unsafe { info.assume_init() };
        children
            .entry(info.pbi_ppid as i32)
            .or_default()
            .push((pid, (info.pbi_start_tvsec, info.pbi_start_tvusec)));
    }
    let mut descendants = BTreeMap::new();
    let mut pending = VecDeque::from([root_pid]);
    while let Some(parent_pid) = pending.pop_front() {
        for (child_pid, start_time) in children.get(&parent_pid).into_iter().flatten() {
            if descendants.insert(*child_pid, *start_time).is_none() {
                pending.push_back(*child_pid);
            }
        }
    }
    descendants
}

#[cfg(target_os = "macos")]
fn terminate_macos_process_group(
    process_group: u32,
    descendants: &TrackedMacosProcesses,
    include_group: bool,
) {
    let Ok(process_group) = i32::try_from(process_group) else {
        return;
    };
    if process_group <= 0 {
        return;
    }
    if include_group {
        unsafe {
            kill(-process_group, 15);
            kill(process_group, 15);
        }
    }
    signal_tracked_macos_processes(descendants, 15);
    if !descendants.is_empty() {
        thread::sleep(Duration::from_millis(250));
    }
    if include_group {
        unsafe {
            kill(-process_group, 9);
            kill(process_group, 9);
        }
    }
    signal_tracked_macos_processes(descendants, 9);
}

#[cfg(target_os = "macos")]
fn signal_tracked_macos_processes(processes: &TrackedMacosProcesses, signal: i32) {
    for (pid, start_time) in processes {
        let mut info = std::mem::MaybeUninit::<MacosProcBsdInfo>::zeroed();
        let result = unsafe {
            proc_pidinfo(
                *pid,
                3,
                0,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<MacosProcBsdInfo>() as i32,
            )
        };
        if result < std::mem::size_of::<MacosProcBsdInfo>() as i32 {
            // A detached child may be reparented between the last process
            // snapshot and cleanup. libproc can then hide its BSD info, so
            // fall back to signaling the still-tracked PID directly.
            unsafe {
                kill(*pid, signal);
            }
            continue;
        }
        let info = unsafe { info.assume_init() };
        if (info.pbi_start_tvsec, info.pbi_start_tvusec) != *start_time {
            continue;
        }
        unsafe {
            kill(*pid, signal);
        }
    }
}

#[cfg(target_os = "macos")]
fn sandbox_profile(
    workspace: &str,
    executable: &str,
    network: bool,
    allow_process_exec: bool,
    process_exec_paths: &[String],
    read_only_paths: &[String],
) -> String {
    let executable_parent = profile_string(
        Path::new(executable)
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_string_lossy()
            .as_ref(),
    );
    let workspace = profile_string(workspace);
    let executable = profile_string(executable);
    let read_only_policy = read_only_paths
        .iter()
        .map(|path| {
            let profile_path = profile_string(path);
            let operation = if Path::new(path).is_dir() {
                "subpath"
            } else {
                "literal"
            };
            format!(
                "(allow file-read* file-map-executable ({} \"{}\"))\n\
                 (deny file-write* ({} \"{}\"))\n\
                 ",
                operation, profile_path, operation, profile_path
            )
        })
        .collect::<String>();
    // macOS path resolution probes ancestors (for example `/Users`) with
    // lstat before opening an authorized file. Allow metadata only for the
    // exact ancestors of Candy-approved paths, never their contents.
    let mut metadata_paths = vec![workspace.as_str(), executable.as_str()];
    metadata_paths.extend(process_exec_paths.iter().map(String::as_str));
    metadata_paths.extend(read_only_paths.iter().map(String::as_str));
    // npm's launcher uses `/usr/bin/env`; it is already an allowed system
    // executable, and this adds only the metadata probes for its ancestors.
    metadata_paths.push("/usr/bin/env");
    let ancestor_metadata_policy = metadata_ancestor_policy(&metadata_paths);
    let network_policy = if network {
        "(allow network-outbound)\n         "
    } else {
        "(deny network*)\n         "
    };
    let network_system_read_policy = if network {
        "(allow file-read* file-map-executable
             (literal \"/private/etc/ssl/cert.pem\")
             (literal \"/private/etc/ssl/openssl.cnf\")
             (literal \"/private/etc/ssl/x509v3.cnf\"))"
    } else {
        ""
    };
    let process_exec_policy = if allow_process_exec {
        "(allow signal (target children))\n\
         (allow process-exec\n\
             (subpath \"/bin\")\n\
             (subpath \"/usr/bin\")\n\
             (subpath \"/usr/local\")\n\
             (subpath \"/opt/homebrew\")\n\
             (subpath \"/Library/Developer/CommandLineTools\"))\n\
         (allow file-read* file-map-executable\n\
             (subpath \"/bin\")\n\
             (subpath \"/usr/bin\")\n\
             (subpath \"/usr/local\")\n\
             (subpath \"/opt/homebrew\")\n\
             (subpath \"/Library/Developer/CommandLineTools\"))"
            .to_owned()
    } else {
        format!("(allow process-exec (literal \"{}\"))", executable)
    };
    let process_exec_path_policy = process_exec_paths
        .iter()
        .map(|path| {
            let profile_path = profile_string(path);
            format!(
                "(allow process-exec (subpath \"{}\"))\n\
                 (allow file-read* file-map-executable (subpath \"{}\"))\n\
                 ",
                profile_path, profile_path
            )
        })
        .collect::<String>();
    format!(
        "(version 1)\n\
         (deny default)\n\
         (import \"system.sb\")\n\
         {}\
         (allow process-fork)\n\
         {}\n\
         {}\
         {}\
         {}\
         {}\
         (allow file-read-metadata file-test-existence\n\
             (literal \"/private\")\n\
             (literal \"/private/var\")\n\
             (literal \"/private/var/db\")\n\
             (literal \"/private/var/db/xcode_select_link\")\n\
             (subpath \"/private/tmp\")\n\
             (subpath \"/private/var/folders\"))\n\
         (allow file-read* file-map-executable\n\
             (subpath \"/Library/Developer/CommandLineTools\"))\n\
         (allow file-read* file-map-executable (subpath \"{}\"))\n\
         (allow file-read* file-test-existence (subpath \"{}\"))\n\
         (allow file-write* (subpath \"{}\"))",
        network_policy,
        process_exec_policy,
        process_exec_path_policy,
        read_only_policy,
        network_system_read_policy,
        ancestor_metadata_policy,
        executable_parent,
        workspace,
        workspace
    )
}

#[cfg(target_os = "macos")]
fn full_access_sandbox_profile() -> String {
    // This deliberately starts from macOS's fully allowed profile, then
    // carves out the provider-credential Keychain IPC boundary. Do not
    // replace it with an unsandboxed Command: a cleared environment alone
    // cannot prevent a same-user child from asking the Keychain.
    "(version 1)\n\
     (allow default)\n\
     (deny mach-lookup (global-name \"com.apple.securityd\"))\n\
     (deny mach-lookup (global-name \"com.apple.SecurityServer\"))\n"
        .to_owned()
}

#[cfg(target_os = "macos")]
fn metadata_ancestor_policy(paths: &[&str]) -> String {
    let mut ancestors = BTreeSet::new();
    for path in paths {
        for ancestor in Path::new(path).ancestors().skip(1) {
            if ancestor == Path::new("/") {
                break;
            }
            if is_safe_profile_path(ancestor) {
                ancestors.insert(ancestor.to_string_lossy().into_owned());
            }
        }
    }
    if ancestors.is_empty() {
        return String::new();
    }
    let rules = ancestors
        .into_iter()
        .map(|ancestor| format!("(literal \"{}\")", profile_string(&ancestor)))
        .collect::<Vec<_>>()
        .join("\n             ");
    format!(
        "(allow file-read-metadata file-test-existence\n             {})\n         ",
        rules
    )
}

fn error_response(code: &'static str) -> String {
    serde_json::to_string(&ErrorResponse {
        v: PROTOCOL_VERSION,
        kind: "error",
        code,
    })
    .unwrap_or_else(|_| "{\"v\":1,\"kind\":\"error\",\"code\":\"runtime_error\"}".into())
}

fn bounded_utf8(bytes: Vec<u8>) -> String {
    let end = bytes.len().min(MAX_OUTPUT_BYTES);
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn is_absolute_path(path: &Path) -> bool {
    path.is_absolute()
}

fn is_safe_environment_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        && !contains_forbidden_environment_key(key)
}

#[cfg(target_os = "macos")]
fn profile_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn is_safe_profile_path(path: &Path) -> bool {
    path.to_str().is_some_and(|value| {
        !value
            .chars()
            .any(|character| matches!(character, '\0' | '\n' | '\r'))
    })
}

fn contains_forbidden_secret_material(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    ["bearer ", "sk-proj-", "sk-", "ds-", "minimax-"]
        .iter()
        .any(|prefix| contains_credential_prefix(&lower, prefix))
}

fn contains_forbidden_environment_key(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "api_key",
        "api-key",
        "authorization",
        "credential",
        "password",
        "secret",
        "token",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || contains_forbidden_secret_material(value)
}

fn contains_credential_prefix(value: &str, prefix: &str) -> bool {
    value.match_indices(prefix).any(|(index, _)| {
        let left_boundary = index == 0 || !value.as_bytes()[index - 1].is_ascii_alphanumeric();
        if !left_boundary {
            return false;
        }
        value.as_bytes()[index + prefix.len()..]
            .iter()
            .take_while(|byte| {
                let byte = **byte;
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
            })
            .count()
            >= 16
    })
}

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
#[cfg(windows)]
const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;
#[cfg(windows)]
const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
#[cfg(windows)]
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;
#[cfg(windows)]
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
#[cfg(windows)]
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
#[cfg(windows)]
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
#[cfg(windows)]
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
#[cfg(windows)]
const SE_GROUP_ENABLED: u32 = 0x0000_0004;
#[cfg(windows)]
const SE_FILE_OBJECT: u32 = 1;
#[cfg(windows)]
const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
#[cfg(windows)]
const GRANT_ACCESS: u32 = 1;
#[cfg(windows)]
const DENY_ACCESS: u32 = 3;
#[cfg(windows)]
const REVOKE_ACCESS: u32 = 4;
#[cfg(windows)]
const SUB_CONTAINERS_AND_OBJECTS_INHERIT: u32 = 0x0000_0003;
#[cfg(windows)]
const FILE_GENERIC_READ: u32 = 0x0012_0089;
#[cfg(windows)]
const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
#[cfg(windows)]
const FILE_GENERIC_EXECUTE: u32 = 0x0012_00a0;
#[cfg(all(windows, test))]
const FILE_EXECUTE: u32 = 0x0000_0020;
#[cfg(windows)]
const FILE_DELETE_CHILD: u32 = 0x0000_0040;
#[cfg(windows)]
const DELETE_ACCESS: u32 = 0x0001_0000;
#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
#[cfg(windows)]
const WAIT_OBJECT_0: u32 = 0;
#[cfg(windows)]
const WAIT_TIMEOUT: u32 = 258;
#[cfg(windows)]
const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;
#[cfg(windows)]
const INFINITE: u32 = u32::MAX;

#[cfg(windows)]
type Handle = *mut c_void;

#[cfg(windows)]
#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit_handle: i32,
}

#[cfg(windows)]
#[repr(C)]
struct StartupInfo {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    reserved2: u16,
    reserved2_ptr: *mut u8,
    std_input: Handle,
    std_output: Handle,
    std_error: Handle,
}

#[cfg(windows)]
#[repr(C)]
struct StartupInfoEx {
    startup: StartupInfo,
    attribute_list: *mut c_void,
}

#[cfg(windows)]
#[repr(C)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: u32,
}

#[cfg(windows)]
#[repr(C)]
struct SecurityCapabilities {
    app_container_sid: *mut c_void,
    capabilities: *mut SidAndAttributes,
    capability_count: u32,
    reserved: u32,
}

#[cfg(windows)]
#[repr(C)]
struct Trustee {
    multiple_trustee: *mut c_void,
    multiple_trustee_operation: u32,
    trustee_form: u32,
    trustee_type: u32,
    name: *mut u16,
}

#[cfg(windows)]
#[repr(C)]
struct ExplicitAccess {
    access_permissions: u32,
    access_mode: u32,
    inheritance: u32,
    trustee: Trustee,
}

#[cfg(windows)]
#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

#[cfg(windows)]
#[repr(C)]
struct JobBasicLimitInformation {
    per_process_user_time: i64,
    per_job_user_time: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
struct IoCounters {
    read_operations: u64,
    write_operations: u64,
    other_operations: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}

#[cfg(windows)]
#[repr(C)]
struct JobExtendedLimitInformation {
    basic: JobBasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn CreateJobObjectW(attributes: *mut SecurityAttributes, name: *const u16) -> Handle;
    fn CreatePipe(
        read_pipe: *mut Handle,
        write_pipe: *mut Handle,
        attributes: *mut SecurityAttributes,
        size: u32,
    ) -> i32;
    fn CreateProcessW(
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut SecurityAttributes,
        thread_attributes: *mut SecurityAttributes,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfo,
        process_information: *mut ProcessInformation,
    ) -> i32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    fn GetFileAttributesW(path: *const u16) -> u32;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn LoadLibraryExW(path: *const u16, file: Handle, flags: u32) -> Handle;
    fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
    fn FreeLibrary(module: Handle) -> i32;
    fn GetLastError() -> u32;
    fn InitializeProcThreadAttributeList(
        attribute_list: *mut c_void,
        attribute_count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        attribute_list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous_value: *mut c_void,
        return_size: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(attribute_list: *mut c_void);
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn GetLengthSid(sid: *mut c_void) -> u32;
    fn ResumeThread(thread: Handle) -> u32;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    fn SetInformationJobObject(
        job: Handle,
        information_class: u32,
        information: *mut c_void,
        information_length: u32,
    ) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
}

#[cfg(windows)]
#[link(name = "advapi32")]
extern "system" {
    fn FreeSid(sid: *mut c_void) -> *mut c_void;
    fn GetNamedSecurityInfoW(
        object_name: *mut u16,
        object_type: u32,
        security_info: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        security_descriptor: *mut *mut c_void,
    ) -> u32;
    fn SetEntriesInAclW(
        count: u32,
        entries: *mut ExplicitAccess,
        old_acl: *mut c_void,
        new_acl: *mut *mut c_void,
    ) -> u32;
    fn SetNamedSecurityInfoW(
        object_name: *mut u16,
        object_type: u32,
        security_info: u32,
        owner: *mut c_void,
        group: *mut c_void,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> u32;
}

#[cfg(windows)]
#[link(name = "userenv")]
extern "system" {
    fn CreateAppContainerProfile(
        app_container_name: *const u16,
        display_name: *const u16,
        description: *const u16,
        capabilities: *mut SidAndAttributes,
        capability_count: u32,
        app_container_sid: *mut *mut c_void,
    ) -> i32;
    fn DeleteAppContainerProfile(app_container_name: *const u16) -> i32;
    fn DeriveAppContainerSidFromAppContainerName(
        app_container_name: *const u16,
        app_container_sid: *mut *mut c_void,
    ) -> i32;
}

#[cfg(windows)]
fn run_windows(request: RunRequest) -> String {
    let paths = match canonical_launch_paths(&request) {
        Ok(paths) => paths,
        Err(code) => return error_response(code),
    };
    if let Some(code) = validate_windows_request(&request, &paths) {
        return error_response(code);
    }

    let job = unsafe { CreateJobObjectW(null_mut(), null()) };
    if job.is_null() {
        return error_response("job_object_failed");
    }
    let mut limits = JobExtendedLimitInformation {
        basic: JobBasicLimitInformation {
            per_process_user_time: 0,
            per_job_user_time: 0,
            limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            minimum_working_set_size: 0,
            maximum_working_set_size: 0,
            active_process_limit: 0,
            affinity: 0,
            priority_class: 0,
            scheduling_class: 0,
        },
        io: IoCounters {
            read_operations: 0,
            write_operations: 0,
            other_operations: 0,
            read_bytes: 0,
            write_bytes: 0,
            other_bytes: 0,
        },
        process_memory_limit: 0,
        job_memory_limit: 0,
        peak_process_memory_used: 0,
        peak_job_memory_used: 0,
    };
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&mut limits as *mut JobExtendedLimitInformation).cast(),
            std::mem::size_of::<JobExtendedLimitInformation>() as u32,
        )
    } != 0;
    if !configured {
        unsafe { CloseHandle(job) };
        return error_response("job_object_failed");
    }

    let result = create_windows_process(&request, job, &paths);
    unsafe { CloseHandle(job) };
    match result {
        Ok(result) => result,
        Err(code) => error_response(code),
    }
}

#[cfg(windows)]
type ExperimentalCreateProcessInSandbox = unsafe extern "system" fn(
    application_name: *const u16,
    command_line: *mut u16,
    process_attributes: *mut SecurityAttributes,
    thread_attributes: *mut SecurityAttributes,
    inherit_handles: i32,
    creation_flags: u32,
    environment: *mut c_void,
    current_directory: *const u16,
    startup_info: *mut StartupInfo,
    identity: *const u16,
    sandbox_specification: *const c_void,
    sandbox_specification_size: u32,
    process_information: *mut ProcessInformation,
) -> i32;

#[cfg(windows)]
struct WindowsAppContainerProfile {
    identity: Vec<u16>,
    access: Option<WindowsAppContainerAccess>,
}

#[cfg(windows)]
struct WindowsAppContainerAccess {
    paths: Vec<std::path::PathBuf>,
    sid: Vec<u8>,
}

#[cfg(windows)]
struct CapabilitySidAllocation {
    pointer: *mut *mut c_void,
    count: u32,
}

#[cfg(windows)]
fn create_process_in_windows_sandbox(
    request: &RunRequest,
    executable: *const u16,
    command_line: *mut u16,
    environment: *mut c_void,
    cwd: *const u16,
    startup: *mut StartupInfo,
    information: *mut ProcessInformation,
    paths: &CanonicalLaunchPaths,
) -> Result<Option<WindowsAppContainerProfile>, &'static str> {
    let module = unsafe {
        LoadLibraryExW(
            wide_null("processmodel.dll").as_ptr(),
            null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if module.is_null() {
        return Err("sandbox_unavailable");
    }
    let function =
        unsafe { GetProcAddress(module, b"Experimental_CreateProcessInSandbox\0".as_ptr()) };
    if function.is_null() {
        unsafe { FreeLibrary(module) };
        return Err("sandbox_unavailable");
    }
    let specification = match sandbox_specification(request, paths) {
        Ok(specification) => specification,
        Err(code) => {
            unsafe { FreeLibrary(module) };
            return Err(code);
        }
    };
    let identity = wide_null(&sandbox_identity(&request.request_id));
    let created = unsafe {
        std::mem::transmute::<*mut c_void, ExperimentalCreateProcessInSandbox>(function)(
            executable,
            command_line,
            null_mut(),
            null_mut(),
            0,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment,
            cwd,
            startup,
            identity.as_ptr(),
            specification.as_ptr().cast(),
            specification.len() as u32,
            information,
        )
    } != 0;
    let error = if created {
        0
    } else {
        unsafe { GetLastError() }
    };
    unsafe { FreeLibrary(module) };
    if created {
        Ok(None)
    } else {
        match error {
            120 => create_process_in_standard_appcontainer(
                request,
                executable,
                cwd,
                startup,
                information,
                paths,
            ),
            _ => Err(match error {
                5 => "sandbox_access_denied",
                13 | 87 | 13_005 => "sandbox_invalid_spec",
                1168 => "sandbox_capability_unavailable",
                0 => "sandbox_unavailable",
                _ => "sandbox_launch_failed",
            }),
        }
    }
}

#[cfg(windows)]
fn create_process_in_standard_appcontainer(
    request: &RunRequest,
    executable: *const u16,
    cwd: *const u16,
    startup: *mut StartupInfo,
    information: *mut ProcessInformation,
    paths: &CanonicalLaunchPaths,
) -> Result<Option<WindowsAppContainerProfile>, &'static str> {
    // The standard AppContainer path is retained for validator/workspace
    // containment only. Trusted Shell requires the experimental native
    // process-exec boundary and must fail closed when that path is absent.
    if request.allow_process_exec {
        return Err("sandbox_capability_unavailable");
    }
    let mut fallback_command_line = wide_null(&command_line(&request.executable, &request.args));
    let mut fallback_environment_values = std::env::vars().collect::<BTreeMap<_, _>>();
    fallback_environment_values.retain(|key, value| {
        is_safe_environment_key(key) && !contains_forbidden_secret_material(value)
    });
    fallback_environment_values.extend(request.environment.clone());
    let mut fallback_environment = wide_environment(&fallback_environment_values)?;
    let identity = wide_null(&sandbox_identity(&request.request_id));
    let display_name = wide_null("Candy Validator Sandbox");
    let description = wide_null("Candy validator workspace sandbox");
    let mut package_sid = null_mut();
    let (mut capabilities, capability_sids) = appcontainer_capabilities(request.network)?;
    let created_profile = unsafe {
        CreateAppContainerProfile(
            identity.as_ptr(),
            display_name.as_ptr(),
            description.as_ptr(),
            if capabilities.is_empty() {
                null_mut()
            } else {
                capabilities.as_mut_ptr()
            },
            capabilities.len() as u32,
            &mut package_sid,
        )
    };
    if created_profile != 0 && created_profile != 0x8007_00b7_u32 as i32 {
        free_capability_sids(capability_sids);
        return Err("sandbox_profile_failed");
    }
    if package_sid.is_null()
        && unsafe { DeriveAppContainerSidFromAppContainerName(identity.as_ptr(), &mut package_sid) }
            != 0
    {
        free_capability_sids(capability_sids);
        return Err("sandbox_profile_failed");
    }

    let access = match grant_standard_appcontainer_access(package_sid, paths) {
        Ok(access) => access,
        Err(code) => {
            unsafe { FreeSid(package_sid) };
            free_capability_sids(capability_sids);
            unsafe { DeleteAppContainerProfile(identity.as_ptr()) };
            return Err(code);
        }
    };

    let mut attribute_size = 0_usize;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut attribute_size);
    }
    if attribute_size == 0 {
        revoke_standard_appcontainer_access(Some(&access));
        unsafe { FreeSid(package_sid) };
        free_capability_sids(capability_sids);
        unsafe { DeleteAppContainerProfile(identity.as_ptr()) };
        return Err("sandbox_attribute_failed");
    }
    let mut attribute_storage = vec![0_u8; attribute_size];
    let attribute_list = attribute_storage.as_mut_ptr().cast::<c_void>();
    let initialized =
        unsafe { InitializeProcThreadAttributeList(attribute_list, 2, 0, &mut attribute_size) }
            != 0;
    if !initialized {
        revoke_standard_appcontainer_access(Some(&access));
        unsafe { FreeSid(package_sid) };
        free_capability_sids(capability_sids);
        unsafe { DeleteAppContainerProfile(identity.as_ptr()) };
        return Err("sandbox_attribute_failed");
    }
    let mut security_capabilities = SecurityCapabilities {
        app_container_sid: package_sid,
        capability_count: capabilities.len() as u32,
        capabilities: if capabilities.is_empty() {
            null_mut()
        } else {
            capabilities.as_mut_ptr()
        },
        reserved: 0,
    };
    let updated = unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            (&mut security_capabilities as *mut SecurityCapabilities).cast(),
            std::mem::size_of::<SecurityCapabilities>(),
            null_mut(),
            null_mut(),
        )
    } != 0;
    if !updated {
        revoke_standard_appcontainer_access(Some(&access));
        unsafe {
            DeleteProcThreadAttributeList(attribute_list);
            FreeSid(package_sid);
        }
        free_capability_sids(capability_sids);
        unsafe { DeleteAppContainerProfile(identity.as_ptr()) };
        return Err("sandbox_attribute_failed");
    }

    let mut inherited_handles = unsafe {
        [
            (*startup).std_input,
            (*startup).std_output,
            (*startup).std_error,
        ]
    };
    let updated = unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited_handles.as_mut_ptr().cast(),
            std::mem::size_of_val(&inherited_handles),
            null_mut(),
            null_mut(),
        )
    } != 0;
    if !updated {
        revoke_standard_appcontainer_access(Some(&access));
        unsafe {
            DeleteProcThreadAttributeList(attribute_list);
            FreeSid(package_sid);
        }
        free_capability_sids(capability_sids);
        unsafe { DeleteAppContainerProfile(identity.as_ptr()) };
        return Err("sandbox_attribute_failed");
    }

    let mut startup_ex = StartupInfoEx {
        startup: unsafe { std::ptr::read(startup) },
        attribute_list,
    };
    startup_ex.startup.cb = std::mem::size_of::<StartupInfoEx>() as u32;
    let created = unsafe {
        CreateProcessW(
            executable,
            fallback_command_line.as_mut_ptr(),
            null_mut(),
            null_mut(),
            1,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | EXTENDED_STARTUPINFO_PRESENT,
            fallback_environment.as_mut_ptr().cast(),
            cwd,
            &mut startup_ex.startup,
            information,
        )
    } != 0;
    let error = if created {
        0
    } else {
        unsafe { GetLastError() }
    };
    unsafe {
        DeleteProcThreadAttributeList(attribute_list);
        FreeSid(package_sid);
    }
    free_capability_sids(capability_sids);
    if !created {
        revoke_standard_appcontainer_access(Some(&access));
        unsafe { DeleteAppContainerProfile(identity.as_ptr()) };
        return Err(match error {
            5 => "sandbox_access_denied",
            87 => "sandbox_invalid_spec",
            _ => "sandbox_launch_failed",
        });
    }
    Ok(Some(WindowsAppContainerProfile {
        identity,
        access: Some(access),
    }))
}

#[cfg(windows)]
fn appcontainer_capabilities(
    network: bool,
) -> Result<(Vec<SidAndAttributes>, Option<CapabilitySidAllocation>), &'static str> {
    if !network {
        return Ok((Vec::new(), None));
    }
    let capability_name = wide_null("internetClient");
    let mut group_sids = null_mut();
    let mut group_count = 0_u32;
    let mut capability_sids = null_mut();
    let mut capability_count = 0_u32;
    let module = unsafe {
        LoadLibraryExW(
            wide_null("kernelbase.dll").as_ptr(),
            null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if module.is_null() {
        return Err("sandbox_capability_unavailable");
    }
    type DeriveCapabilitySids = unsafe extern "system" fn(
        *const u16,
        *mut *mut *mut c_void,
        *mut u32,
        *mut *mut *mut c_void,
        *mut u32,
    ) -> i32;
    let function = unsafe { GetProcAddress(module, b"DeriveCapabilitySidsFromName\0".as_ptr()) };
    let derived = if function.is_null() {
        false
    } else {
        unsafe {
            (std::mem::transmute::<*mut c_void, DeriveCapabilitySids>(function))(
                capability_name.as_ptr(),
                &mut group_sids,
                &mut group_count,
                &mut capability_sids,
                &mut capability_count,
            ) != 0
        }
    };
    unsafe { FreeLibrary(module) };
    free_sid_array(group_sids, group_count);
    if !derived || capability_sids.is_null() || capability_count == 0 {
        free_sid_array(capability_sids, capability_count);
        return Err("sandbox_capability_unavailable");
    }
    let capability_sid = unsafe { *capability_sids };
    let capabilities = vec![SidAndAttributes {
        sid: capability_sid,
        attributes: SE_GROUP_ENABLED,
    }];
    Ok((
        capabilities,
        Some(CapabilitySidAllocation {
            pointer: capability_sids,
            count: capability_count,
        }),
    ))
}

#[cfg(windows)]
fn free_capability_sids(capability_sids: Option<CapabilitySidAllocation>) {
    if let Some(capability_sids) = capability_sids {
        free_sid_array(capability_sids.pointer, capability_sids.count);
    }
}

#[cfg(windows)]
fn free_sid_array(sids: *mut *mut c_void, count: u32) {
    if sids.is_null() {
        return;
    }
    for index in 0..count as usize {
        let sid = unsafe { *sids.add(index) };
        if !sid.is_null() {
            unsafe { LocalFree(sid) };
        }
    }
    unsafe { LocalFree(sids.cast()) };
}

#[cfg(windows)]
fn delete_windows_appcontainer_profile(profile: Option<WindowsAppContainerProfile>) {
    if let Some(profile) = profile {
        revoke_standard_appcontainer_access(profile.access.as_ref());
        unsafe { DeleteAppContainerProfile(profile.identity.as_ptr()) };
    }
}

#[cfg(windows)]
fn grant_standard_appcontainer_access(
    package_sid: *mut c_void,
    paths: &CanonicalLaunchPaths,
) -> Result<WindowsAppContainerAccess, &'static str> {
    let sid_length = unsafe { GetLengthSid(package_sid) } as usize;
    if sid_length == 0 {
        return Err("sandbox_acl_failed");
    }
    let sid = unsafe { std::slice::from_raw_parts(package_sid.cast::<u8>(), sid_length) }.to_vec();
    let mut applied = Vec::<std::path::PathBuf>::new();
    let mut resource_roots = vec![paths.workspace.clone()];

    let mut _workspace_targets = Vec::new();
    collect_acl_targets(&paths.workspace, &mut _workspace_targets)?;
    if let Err(code) = update_path_acl(&paths.workspace, &sid, GRANT_ACCESS, workspace_access()) {
        revoke_acl_targets(&applied, &sid);
        return Err(code);
    }
    applied.push(paths.workspace.clone());

    for root in &paths.read_only_roots {
        let mut targets = Vec::new();
        if let Err(code) = collect_acl_targets(root, &mut targets) {
            revoke_acl_targets(&applied, &sid);
            return Err(code);
        }
        let access_mode = if resource_roots
            .iter()
            .any(|path| same_windows_path(path, root) || windows_path_is_within(root, path))
        {
            DENY_ACCESS
        } else {
            GRANT_ACCESS
        };
        let access_permissions = if access_mode == DENY_ACCESS {
            readonly_denied_access()
        } else {
            FILE_GENERIC_READ | FILE_GENERIC_EXECUTE
        };
        if let Err(code) = update_path_acl(root, &sid, access_mode, access_permissions) {
            revoke_acl_targets(&applied, &sid);
            return Err(code);
        }
        if access_mode == GRANT_ACCESS {
            resource_roots.push(root.clone());
            applied.push(root.clone());
        }
    }

    Ok(WindowsAppContainerAccess {
        paths: applied,
        sid,
    })
}

#[cfg(windows)]
fn collect_acl_targets(
    path: &std::path::Path,
    targets: &mut Vec<std::path::PathBuf>,
) -> Result<(), &'static str> {
    if has_reparse_component(path) {
        return Err("reparse_forbidden");
    }
    targets.push(path.to_path_buf());
    let metadata = fs::symlink_metadata(path).map_err(|_| "invalid_path")?;
    if !metadata.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|_| "sandbox_acl_failed")? {
        let entry = entry.map_err(|_| "sandbox_acl_failed")?;
        collect_acl_targets(&entry.path(), targets)?;
    }
    Ok(())
}

#[cfg(windows)]
fn workspace_access() -> u32 {
    // The worktree is writable data, not an executable search path. The
    // Explicit toolchain roots below carry FILE_GENERIC_EXECUTE for the
    // reviewed runtime/toolchain; granting generic execute here would let a
    // command run an arbitrary PE dropped into the worktree.
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS | FILE_DELETE_CHILD
}

#[cfg(windows)]
fn readonly_denied_access() -> u32 {
    FILE_GENERIC_WRITE | DELETE_ACCESS | FILE_DELETE_CHILD
}

#[cfg(windows)]
fn update_path_acl(
    path: &std::path::Path,
    sid: &[u8],
    access_mode: u32,
    access_permissions: u32,
) -> Result<(), &'static str> {
    update_path_acl_with_inheritance(
        path,
        sid,
        access_mode,
        access_permissions,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    )
}

#[cfg(windows)]
fn update_path_acl_with_inheritance(
    path: &std::path::Path,
    sid: &[u8],
    access_mode: u32,
    access_permissions: u32,
    inheritance: u32,
) -> Result<(), &'static str> {
    let mut path = wide_null(&path.to_string_lossy());
    let mut owner = null_mut();
    let mut group = null_mut();
    let mut old_dacl = null_mut();
    let mut sacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            path.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            &mut owner,
            &mut group,
            &mut old_dacl,
            &mut sacl,
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err("sandbox_acl_failed");
    }
    let mut entry = ExplicitAccess {
        access_permissions,
        access_mode,
        inheritance,
        trustee: Trustee {
            multiple_trustee: null_mut(),
            multiple_trustee_operation: 0,
            trustee_form: 0,
            trustee_type: 0,
            name: sid.as_ptr() as *mut u16,
        },
    };
    let mut new_dacl = null_mut();
    let status = unsafe { SetEntriesInAclW(1, &mut entry, old_dacl, &mut new_dacl) };
    if status != 0 {
        unsafe { LocalFree(descriptor) };
        return Err("sandbox_acl_failed");
    }
    let status = unsafe {
        SetNamedSecurityInfoW(
            path.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_dacl,
            null_mut(),
        )
    };
    unsafe {
        LocalFree(new_dacl);
        LocalFree(descriptor);
    }
    if status != 0 {
        return Err("sandbox_acl_failed");
    }
    Ok(())
}

#[cfg(windows)]
fn revoke_acl_targets(paths: &[std::path::PathBuf], sid: &[u8]) {
    for path in paths {
        let _ = update_path_acl(path, sid, REVOKE_ACCESS, 0);
    }
}

#[cfg(windows)]
fn revoke_standard_appcontainer_access(access: Option<&WindowsAppContainerAccess>) {
    if let Some(access) = access {
        revoke_acl_targets(&access.paths, &access.sid);
    }
}

#[cfg(windows)]
fn sandbox_identity(request_id: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in request_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("CandyTask_{hash:016x}")
}

#[cfg(windows)]
fn sandbox_specification(
    request: &RunRequest,
    paths: &CanonicalLaunchPaths,
) -> Result<Vec<u8>, &'static str> {
    let read_only_paths = request
        .process_exec_paths
        .iter()
        .chain(request.read_only_paths.iter())
        .map(|value| canonical_sandbox_path(value))
        .collect::<Result<Vec<_>, _>>()?;
    let mut read_only_paths = read_only_paths;
    read_only_paths.push(
        paths
            .executable
            .parent()
            .ok_or("invalid_path")?
            .to_path_buf(),
    );
    read_only_paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    read_only_paths.dedup_by(|left, right| same_windows_path(left, right));

    build_flatbuffer_sandbox_spec(
        &paths.workspace.to_string_lossy(),
        request.network,
        &read_only_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
    )
}

#[cfg(windows)]
fn canonical_sandbox_path(value: &str) -> Result<std::path::PathBuf, &'static str> {
    let path = Path::new(value);
    if !path.is_absolute() || has_reparse_component(path) {
        return Err("reparse_forbidden");
    }
    let canonical = fs::canonicalize(path).map_err(|_| "invalid_path")?;
    if has_reparse_component(&canonical) {
        return Err("reparse_forbidden");
    }
    Ok(canonical)
}

#[cfg(windows)]
fn build_flatbuffer_sandbox_spec(
    workspace: &str,
    network: bool,
    read_only_paths: &[String],
) -> Result<Vec<u8>, &'static str> {
    const VTABLE_POSITION: usize = 8;
    const TABLE_POSITION: usize = 32;
    const TABLE_SIZE: usize = 40;
    const VTABLE_SIZE: usize = 22;

    let mut bytes = vec![0_u8; TABLE_POSITION + TABLE_SIZE];
    write_u32(&mut bytes, 0, TABLE_POSITION as u32);
    bytes[4..8].copy_from_slice(b"SBOX");
    write_u16(&mut bytes, VTABLE_POSITION, VTABLE_SIZE as u16);
    write_u16(&mut bytes, VTABLE_POSITION + 2, TABLE_SIZE as u16);
    for (index, offset) in [4_u16, 8, 9, 10, 0, 24, 28, 32, 0].into_iter().enumerate() {
        write_u16(&mut bytes, VTABLE_POSITION + 4 + index * 2, offset);
    }
    write_i32(
        &mut bytes,
        TABLE_POSITION,
        (TABLE_POSITION - VTABLE_POSITION) as i32,
    );

    let version = append_flatbuffer_string(&mut bytes, "0.1.0")?;
    let capability = if network {
        Some(append_flatbuffer_string(&mut bytes, "internetClient")?)
    } else {
        None
    };
    let read_write = append_flatbuffer_string_vector(&mut bytes, &[workspace.to_owned()])?;
    let read_only = append_flatbuffer_string_vector(&mut bytes, read_only_paths)?;

    set_relative_uoffset(&mut bytes, TABLE_POSITION + 4, version)?;
    bytes[TABLE_POSITION + 8] = 1;
    bytes[TABLE_POSITION + 10] = 1;
    if let Some(capability) = capability {
        set_relative_uoffset(&mut bytes, TABLE_POSITION + 24, capability)?;
    }
    set_relative_uoffset(&mut bytes, TABLE_POSITION + 28, read_write)?;
    set_relative_uoffset(&mut bytes, TABLE_POSITION + 32, read_only)?;
    Ok(bytes)
}

#[cfg(windows)]
fn align_flatbuffer(bytes: &mut Vec<u8>, alignment: usize) {
    let padding = (alignment - bytes.len() % alignment) % alignment;
    bytes.resize(bytes.len() + padding, 0);
}

#[cfg(windows)]
fn append_flatbuffer_string(bytes: &mut Vec<u8>, value: &str) -> Result<usize, &'static str> {
    if value.contains('\0') || value.len() > u32::MAX as usize {
        return Err("invalid_message");
    }
    align_flatbuffer(bytes, 4);
    let position = bytes.len();
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
    bytes.extend_from_slice(value.as_bytes());
    bytes.push(0);
    Ok(position)
}

#[cfg(windows)]
fn append_flatbuffer_string_vector(
    bytes: &mut Vec<u8>,
    values: &[String],
) -> Result<usize, &'static str> {
    if values.len() > u32::MAX as usize {
        return Err("invalid_message");
    }
    align_flatbuffer(bytes, 4);
    let position = bytes.len();
    bytes.extend_from_slice(&(values.len() as u32).to_le_bytes());
    bytes.resize(bytes.len() + values.len() * 4, 0);
    for (index, value) in values.iter().enumerate() {
        let string_position = append_flatbuffer_string(bytes, value)?;
        set_relative_uoffset(bytes, position + 4 + index * 4, string_position)?;
    }
    Ok(position)
}

#[cfg(windows)]
fn set_relative_uoffset(
    bytes: &mut [u8],
    position: usize,
    target: usize,
) -> Result<(), &'static str> {
    if target <= position || target - position > u32::MAX as usize {
        return Err("invalid_message");
    }
    write_u32(bytes, position, (target - position) as u32);
    Ok(())
}

#[cfg(windows)]
fn write_u16(bytes: &mut [u8], position: usize, value: u16) {
    bytes[position..position + 2].copy_from_slice(&value.to_le_bytes());
}

#[cfg(windows)]
fn write_u32(bytes: &mut [u8], position: usize, value: u32) {
    bytes[position..position + 4].copy_from_slice(&value.to_le_bytes());
}

#[cfg(windows)]
fn write_i32(bytes: &mut [u8], position: usize, value: i32) {
    bytes[position..position + 4].copy_from_slice(&value.to_le_bytes());
}

#[cfg(windows)]
fn create_windows_process(
    request: &RunRequest,
    job: Handle,
    paths: &CanonicalLaunchPaths,
) -> Result<String, &'static str> {
    let executable = wide_null(&request.executable);
    let cwd = wide_null(&request.cwd);
    let mut command_line = wide_null(&command_line(&request.executable, &request.args));
    let mut environment = wide_environment(&request.environment)?;
    let mut startup = unsafe { std::mem::zeroed::<StartupInfo>() };
    startup.cb = std::mem::size_of::<StartupInfo>() as u32;
    startup.flags = STARTF_USESTDHANDLES;
    let (stdin_read, stdin_write) = create_pipe()?;
    let (stdout_read, stdout_write) = create_pipe()?;
    let (stderr_read, stderr_write) = create_pipe()?;
    for handle in [stdin_write, stdout_read, stderr_read] {
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            close_many([
                stdin_read,
                stdin_write,
                stdout_read,
                stdout_write,
                stderr_read,
                stderr_write,
            ]);
            return Err("process_pipe_failed");
        }
    }
    startup.std_input = stdin_read;
    startup.std_output = stdout_write;
    startup.std_error = stderr_write;
    let mut information = unsafe { std::mem::zeroed::<ProcessInformation>() };
    let created = create_process_in_windows_sandbox(
        request,
        executable.as_ptr(),
        command_line.as_mut_ptr(),
        environment.as_mut_ptr().cast(),
        cwd.as_ptr(),
        &mut startup,
        &mut information,
        paths,
    );
    unsafe {
        CloseHandle(stdin_read);
        CloseHandle(stdin_write);
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);
    }
    let mut profile = match created {
        Ok(profile) => profile,
        Err(code) => {
            close_many([stdout_read, stderr_read]);
            return Err(code);
        }
    };
    if unsafe { AssignProcessToJobObject(job, information.process) } == 0 {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(information.thread);
            CloseHandle(information.process);
        }
        delete_windows_appcontainer_profile(profile.take());
        close_many([stdout_read, stderr_read]);
        return Err("job_assignment_failed");
    }
    let parent_handle = if request.parent_pid == 0 {
        None
    } else {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, request.parent_pid) };
        if handle.is_null() {
            unsafe {
                TerminateJobObject(job, 1);
                CloseHandle(information.thread);
                CloseHandle(information.process);
            }
            delete_windows_appcontainer_profile(profile.take());
            close_many([stdout_read, stderr_read]);
            return Err("parent_unavailable");
        }
        Some(handle)
    };
    if let Some(code) = validate_launch_paths(request, paths) {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(information.thread);
            CloseHandle(information.process);
        }
        close_optional_handle(parent_handle);
        delete_windows_appcontainer_profile(profile.take());
        close_many([stdout_read, stderr_read]);
        return Err(code);
    }
    if parent_handle
        .is_some_and(|parent| unsafe { WaitForSingleObject(parent, 0) } == WAIT_OBJECT_0)
    {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(information.thread);
            CloseHandle(information.process);
        }
        close_optional_handle(parent_handle);
        delete_windows_appcontainer_profile(profile.take());
        close_many([stdout_read, stderr_read]);
        return Err("parent_lost");
    }
    if unsafe { ResumeThread(information.thread) } == u32::MAX {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(information.thread);
            CloseHandle(information.process);
        }
        close_optional_handle(parent_handle);
        delete_windows_appcontainer_profile(profile.take());
        close_many([stdout_read, stderr_read]);
        return Err("launch_failed");
    }

    let stdout = unsafe { File::from_raw_handle(stdout_read as RawHandle) };
    let stderr = unsafe { File::from_raw_handle(stderr_read as RawHandle) };
    let stdout_thread = thread::spawn(|| read_bounded(stdout));
    let stderr_thread = thread::spawn(|| read_bounded(stderr));
    let parent_lost = Arc::new(AtomicBool::new(false));
    let monitor_stop = Arc::new(AtomicBool::new(false));
    let parent_monitor = parent_handle.map(|parent| {
        let parent = parent as usize;
        let job = job as usize;
        let parent_lost = Arc::clone(&parent_lost);
        let monitor_stop = Arc::clone(&monitor_stop);
        thread::spawn(move || loop {
            if monitor_stop.load(Ordering::Relaxed) {
                break;
            }
            match unsafe { WaitForSingleObject(parent as Handle, 100) } {
                WAIT_OBJECT_0 => {
                    parent_lost.store(true, Ordering::Relaxed);
                    unsafe { TerminateJobObject(job as Handle, 1) };
                    break;
                }
                WAIT_TIMEOUT => continue,
                _ => break,
            }
        })
    });
    let waited = unsafe { WaitForSingleObject(information.process, INFINITE) } == WAIT_OBJECT_0;
    monitor_stop.store(true, Ordering::Relaxed);
    if let Some(monitor) = parent_monitor {
        let _ = monitor.join();
    }
    close_optional_handle(parent_handle);
    let mut exit_code = 1;
    let exited = waited && unsafe { GetExitCodeProcess(information.process, &mut exit_code) } != 0;
    unsafe {
        // A validator must not leave a task-owned descendant behind after its
        // direct process exits. The Job Object owns the complete tree.
        TerminateJobObject(job, 0);
        CloseHandle(information.thread);
        CloseHandle(information.process);
    }
    delete_windows_appcontainer_profile(profile.take());
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    if parent_lost.load(Ordering::Relaxed) && request.parent_pid != 0 {
        return Err("parent_lost");
    }
    if !waited || !exited {
        return Err("process_wait_failed");
    }
    Ok(serde_json::to_string(&CompletedResponse {
        v: PROTOCOL_VERSION,
        kind: "completed",
        request_id: request.request_id.clone(),
        code: Some(exit_code as i32),
        stdout,
        stderr,
        cancelled: false,
    })
    .unwrap_or_else(|_| error_response("runtime_error")))
}

#[cfg(windows)]
fn create_pipe() -> Result<(Handle, Handle), &'static str> {
    let mut read = null_mut();
    let mut write = null_mut();
    let mut attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor: null_mut(),
        inherit_handle: 1,
    };
    if unsafe { CreatePipe(&mut read, &mut write, &mut attributes, 0) } == 0 {
        return Err("process_pipe_failed");
    }
    Ok((read, write))
}

#[cfg(windows)]
fn close_many<const N: usize>(handles: [Handle; N]) {
    for handle in handles {
        if !handle.is_null() {
            unsafe { CloseHandle(handle) };
        }
    }
}

#[cfg(windows)]
fn close_optional_handle(handle: Option<Handle>) {
    if let Some(handle) = handle {
        unsafe { CloseHandle(handle) };
    }
}

#[cfg(any(target_os = "macos", windows))]
fn read_bounded<R: Read>(mut file: R) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match file.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..count.min(remaining)]);
            }
        }
    }
    bounded_utf8(bytes)
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(once(0))
        .collect()
}

#[cfg(windows)]
fn wide_environment(environment: &BTreeMap<String, String>) -> Result<Vec<u16>, &'static str> {
    let mut entries = environment.iter().collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| {
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(right))
    });
    let mut value = String::new();
    let mut previous_key = None;
    for (key, entry) in entries {
        if previous_key
            .as_deref()
            .is_some_and(|previous: &str| previous.eq_ignore_ascii_case(key))
        {
            continue;
        }
        previous_key = Some(key.clone());
        if entry.contains('\0') {
            return Err("invalid_message");
        }
        value.push_str(key);
        value.push('=');
        value.push_str(entry);
        value.push('\0');
    }
    value.push('\0');
    Ok(value.encode_utf16().collect())
}

#[cfg(windows)]
fn command_line(executable: &str, args: &[String]) -> String {
    std::iter::once(executable)
        .chain(args.iter().map(String::as_str))
        .map(quote_windows_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn quote_windows_arg(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        match character {
            '\\' => slashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(slashes * 2 + 1));
                quoted.push('"');
                slashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(slashes));
                quoted.push(character);
                slashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(windows)]
struct CanonicalLaunchPaths {
    workspace: std::path::PathBuf,
    cwd: std::path::PathBuf,
    executable: std::path::PathBuf,
    read_only_roots: Vec<std::path::PathBuf>,
}

#[cfg(windows)]
fn canonical_launch_paths(request: &RunRequest) -> Result<CanonicalLaunchPaths, &'static str> {
    let workspace = Path::new(&request.workspace);
    let cwd = Path::new(&request.cwd);
    let executable = Path::new(&request.executable);
    if !workspace.is_absolute() || !cwd.is_absolute() || !executable.is_absolute() {
        return Err("invalid_path");
    }
    if has_reparse_component(workspace) || has_reparse_component(cwd) {
        return Err("reparse_forbidden");
    }
    let Ok(workspace) = fs::canonicalize(workspace) else {
        return Err("invalid_path");
    };
    let Ok(cwd) = fs::canonicalize(cwd) else {
        return Err("invalid_path");
    };
    let Ok(executable) = fs::canonicalize(executable) else {
        return Err("invalid_path");
    };
    if executable.file_name().is_none() {
        return Err("invalid_path");
    }
    let read_only_roots = canonical_read_only_roots(request, &executable)?;
    Ok(CanonicalLaunchPaths {
        workspace,
        cwd,
        executable,
        read_only_roots,
    })
}

#[cfg(windows)]
fn canonical_read_only_roots(
    request: &RunRequest,
    executable: &Path,
) -> Result<Vec<std::path::PathBuf>, &'static str> {
    let mut roots = request
        .process_exec_paths
        .iter()
        .chain(request.read_only_paths.iter())
        .map(|value| canonical_sandbox_path(value))
        .collect::<Result<Vec<_>, _>>()?;
    roots.push(executable.parent().ok_or("invalid_path")?.to_path_buf());
    roots.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    roots.dedup_by(|left, right| same_windows_path(left, right));
    Ok(roots)
}

#[cfg(windows)]
fn validate_windows_request(
    _request: &RunRequest,
    paths: &CanonicalLaunchPaths,
) -> Option<&'static str> {
    let workspace = &paths.workspace;
    let cwd = &paths.cwd;
    if !windows_path_is_within(&cwd, &workspace) {
        return Some("workspace_escape");
    }
    if executable_is_reparse(&paths.executable) {
        return Some("reparse_forbidden");
    }
    if contains_reparse_tree(&workspace) {
        return Some("reparse_forbidden");
    }
    None
}

#[cfg(windows)]
fn executable_is_reparse(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_symlink()
}

/// Re-validate the canonical launch paths after CreateProcessW resolved them
/// but before the suspended process is resumed. This closes the window in which
/// a workspace or executable path component could be swapped for a reparse point
/// or outside-workspace target between the pre-flight check and process launch.
#[cfg(windows)]
fn validate_launch_paths(
    request: &RunRequest,
    expected: &CanonicalLaunchPaths,
) -> Option<&'static str> {
    let Ok(workspace) = fs::canonicalize(Path::new(&request.workspace)) else {
        return Some("invalid_path");
    };
    let Ok(cwd) = fs::canonicalize(Path::new(&request.cwd)) else {
        return Some("invalid_path");
    };
    let Ok(executable) = fs::canonicalize(Path::new(&request.executable)) else {
        return Some("invalid_path");
    };
    if has_reparse_component(&workspace)
        || has_reparse_component(&cwd)
        || contains_reparse_tree(&workspace)
        || !windows_path_is_within(&cwd, &workspace)
    {
        return Some("reparse_forbidden");
    }
    if !same_windows_path(&workspace, &expected.workspace)
        || !same_windows_path(&cwd, &expected.cwd)
        || !same_windows_path(&executable, &expected.executable)
        || executable_is_reparse(&executable)
    {
        return Some("reparse_forbidden");
    }
    let Ok(read_only_roots) = canonical_read_only_roots(request, &executable) else {
        return Some("invalid_path");
    };
    if read_only_roots.len() != expected.read_only_roots.len()
        || read_only_roots
            .iter()
            .zip(&expected.read_only_roots)
            .any(|(current, expected)| !same_windows_path(current, expected))
    {
        return Some("reparse_forbidden");
    }
    None
}

#[cfg(windows)]
fn same_windows_path(left: &Path, right: &Path) -> bool {
    normalize_windows_path(left) == normalize_windows_path(right)
}

#[cfg(windows)]
fn windows_path_is_within(candidate: &Path, root: &Path) -> bool {
    let candidate = normalize_windows_path(candidate);
    let root = normalize_windows_path(root);
    candidate == root || candidate.starts_with(&(root + "\\"))
}

#[cfg(windows)]
fn normalize_windows_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn has_reparse_component(path: &Path) -> bool {
    path.ancestors().any(|ancestor| {
        let wide = wide_null(&ancestor.to_string_lossy());
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    })
}

#[cfg(windows)]
fn contains_reparse_tree(path: &Path) -> bool {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(_) => return true,
    };
    if metadata.file_type().is_symlink() || has_reparse_component(path) {
        return true;
    }
    if !metadata.is_dir() {
        return false;
    }
    let entries = match fs::read_dir(path) {
        Ok(value) => value,
        Err(_) => return true,
    };
    entries
        .flatten()
        .any(|entry| contains_reparse_tree(&entry.path()))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::{read_bounded_line, response_for_line, BoundedLineError, MAX_LINE_BYTES};

    #[test]
    fn distinguishes_task_worktree_ids_from_credential_values() {
        let worktree = format!("/tmp/candy/worktrees/task-{}", "a".repeat(20));
        let credential = format!("sk-{}", "x".repeat(16));
        assert!(!super::contains_forbidden_secret_material(&worktree));
        assert!(super::contains_forbidden_secret_material(&credential));
        assert!(super::contains_forbidden_environment_key("CANDY_TOKEN"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_is_default_deny_and_scoped_to_validator_and_workspace() {
        let profile = super::sandbox_profile(
            "/private/var/folders/fixture/workspace",
            "/Users/fixture/node/bin/node",
            false,
            false,
            &[],
            &[],
        );
        assert!(profile.contains("(deny default)"));
        assert!(!profile.contains("(allow default)"));
        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains("(allow process-exec (literal \"/Users/fixture/node/bin/node\"))"));
        assert!(profile.contains("(literal \"/Users\")"));
        assert!(!profile.contains("(subpath \"/Users\")"));
        assert!(profile.contains("(subpath \"/private/tmp\")"));
        assert!(profile.contains("(subpath \"/private/var/folders/fixture/workspace\")"));
        assert!(profile.contains("(allow file-write*"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_network_capability_is_explicit_and_not_enabled_by_default() {
        let offline = super::sandbox_profile(
            "/private/var/folders/fixture/workspace",
            "/bin/bash",
            false,
            false,
            &[],
            &[],
        );
        let elevated = super::sandbox_profile(
            "/private/var/folders/fixture/workspace",
            "/bin/bash",
            true,
            false,
            &[],
            &[],
        );
        assert!(offline.contains("(deny network*)"));
        assert!(!offline.contains("/private/etc/ssl"));
        assert!(!elevated.contains("(deny network*)"));
        assert!(elevated.contains("(allow network-outbound)"));
        assert!(elevated.contains("(literal \"/private/etc/ssl/cert.pem\")"));
        assert!(elevated.contains("(literal \"/private/etc/ssl/openssl.cnf\")"));
        assert!(!elevated.contains("(subpath \"/private/etc/ssl\")"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_full_access_is_broad_but_keeps_keychain_ipc_denied() {
        let profile = super::full_access_sandbox_profile();
        assert!(profile.contains("(allow default)"));
        assert!(!profile.contains("(deny default)"));
        assert!(profile.contains("(deny mach-lookup (global-name \"com.apple.securityd\"))"));
        assert!(profile.contains("(deny mach-lookup (global-name \"com.apple.SecurityServer\"))"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn explicit_process_exec_paths_allow_bounded_helpers_without_wide_shell_policy() {
        let profile = super::sandbox_profile(
            "/private/var/folders/fixture/workspace",
            "/Library/Developer/CommandLineTools/usr/bin/git",
            true,
            false,
            &[
                "/Library/Developer/CommandLineTools/usr/libexec/git-core".to_owned(),
                "/Library/Developer/CommandLineTools/usr/lib".to_owned(),
            ],
            &[],
        );
        assert!(profile.contains(
            "(allow process-exec (literal \"/Library/Developer/CommandLineTools/usr/bin/git\"))"
        ));
        assert!(
            profile.contains("(allow process-exec (subpath \"/Library/Developer/CommandLineTools/usr/libexec/git-core\"))")
        );
        assert!(
            profile.contains("(allow file-read* file-map-executable (subpath \"/Library/Developer/CommandLineTools/usr/lib\"))")
        );
        // The wide offline shell policy must not appear for a network command.
        assert!(!profile.contains("(subpath \"/opt/homebrew\")"));
        assert!(!profile.contains(
            "(allow process-exec\n             (subpath \"/Library/Developer/CommandLineTools\"))"
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_control_characters_in_profile_paths() {
        assert!(!super::is_safe_profile_path(std::path::Path::new(
            "/private/var/folders/fixture/work\nspace",
        )));
        assert!(!super::is_safe_profile_path(std::path::Path::new(
            "/private/var/folders/fixture/work\rspace",
        )));
    }

    #[test]
    fn rejects_secrets_without_echoing_input() {
        let response = response_for_line(
            r#"{"v":1,"kind":"run","requestId":"fixture-request","executable":"/usr/bin/true","args":[],"cwd":"/tmp","workspace":"/tmp","network":false,"environment":{"CANDY_TOKEN":"fixture-value"}}"#,
        );
        assert!(response.contains("secret_forbidden"));
        assert!(!response.contains("fixture"));
    }

    #[test]
    fn rejects_oversized_lines_before_protocol_processing() {
        let line = "x".repeat(MAX_LINE_BYTES + 1);
        assert!(response_for_line(&line).contains("line_too_large"));
    }

    #[test]
    fn bounded_reader_rejects_unterminated_oversized_frames() {
        let mut input = Cursor::new(vec![b'x'; MAX_LINE_BYTES + 1]);
        assert!(matches!(
            read_bounded_line(&mut input),
            Err(BoundedLineError::TooLarge)
        ));
    }

    #[test]
    fn bounded_reader_preserves_split_frames() {
        let mut input = Cursor::new(b"abc\ndef".to_vec());
        assert_eq!(
            read_bounded_line(&mut input).unwrap().as_deref(),
            Some("abc")
        );
        assert_eq!(
            read_bounded_line(&mut input).unwrap().as_deref(),
            Some("def")
        );
        assert!(read_bounded_line(&mut input).unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_sandbox_spec_is_app_container_and_network_is_explicit() {
        let offline = super::build_flatbuffer_sandbox_spec(
            r"C:\workspace",
            false,
            &[r"C:\toolchain".to_owned()],
        )
        .expect("offline spec");
        assert_eq!(&offline[4..8], b"SBOX");
        assert_eq!(u32::from_le_bytes(offline[0..4].try_into().unwrap()), 32);
        assert_eq!(offline[40], 1, "app_container must be enabled");
        assert_eq!(offline[42], 1, "win32k must be disabled");
        assert!(!String::from_utf8_lossy(&offline).contains("internetClient"));

        let network =
            super::build_flatbuffer_sandbox_spec(r"C:\workspace", true, &[]).expect("network spec");
        assert!(String::from_utf8_lossy(&network).contains("internetClient"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_worktree_access_does_not_grant_file_execution() {
        assert_eq!(super::workspace_access() & super::FILE_EXECUTE, 0);
    }

    #[test]
    fn rejects_network_and_relative_paths_before_launch() {
        let response = response_for_line(
            r#"{"v":1,"kind":"run","requestId":"fixture","executable":"node","args":[],"cwd":"/tmp","workspace":"/tmp","network":true,"environment":{}}"#,
        );
        #[cfg(target_os = "macos")]
        assert!(response.contains("invalid_path"));
        #[cfg(all(not(target_os = "macos"), not(windows)))]
        assert!(response.contains("network_forbidden"));
        #[cfg(windows)]
        assert!(response.contains("invalid_path"));
        let response = response_for_line(
            r#"{"v":1,"kind":"run","requestId":"fixture","executable":"node","args":[],"cwd":"relative","workspace":"/tmp","network":false,"environment":{}}"#,
        );
        assert!(response.contains("invalid_path"));
    }
}
