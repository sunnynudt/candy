use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::fs::{self, File};
#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
use std::iter::once;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::io::{FromRawHandle, RawHandle};
#[cfg(windows)]
use std::ptr::{null, null_mut};
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
    network: bool,
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
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        let response = response_for_line(&line);
        if writeln!(stdout, "{}", response).is_err() {
            break;
        }
        let _ = stdout.flush();
    }
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
        || !request
            .environment
            .keys()
            .all(|key| is_safe_environment_key(key))
    {
        return error_response("invalid_message");
    }
    if request.network {
        return error_response("network_forbidden");
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
fn run_macos(request: RunRequest) -> String {
    let profile = sandbox_profile(&request.workspace, &request.executable);
    let output = Command::new("/usr/bin/sandbox-exec")
        .arg("-p")
        .arg(profile)
        .arg("--")
        .arg(&request.executable)
        .args(&request.args)
        .current_dir(&request.cwd)
        .env_clear()
        .envs(request.environment)
        .output();
    let response = match output {
        Ok(output) => CompletedResponse {
            v: PROTOCOL_VERSION,
            kind: "completed",
            request_id: request.request_id,
            code: output.status.code(),
            stdout: bounded_utf8(output.stdout),
            stderr: bounded_utf8(output.stderr),
            cancelled: false,
        },
        Err(_) => CompletedResponse {
            v: PROTOCOL_VERSION,
            kind: "completed",
            request_id: request.request_id,
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            cancelled: false,
        },
    };
    serde_json::to_string(&response).unwrap_or_else(|_| error_response("runtime_error"))
}

#[cfg(target_os = "macos")]
fn sandbox_profile(workspace: &str, executable: &str) -> String {
    let workspace = profile_string(workspace);
    let executable_parent = profile_string(
        Path::new(executable)
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_string_lossy()
            .as_ref(),
    );
    format!(
        "(version 1)\n\
         (allow default)\n\
         (deny network*)\n\
         ; File and symlink containment is enforced by Candy's TypeScript\
         ; workspace operations. This runner contributes OS no-network\
         ; containment until a stronger seatbelt profile passes G2 review.\n\
         (allow file-read* (subpath \"{}\"))\n\
         (allow file-write* (subpath \"{}\"))\n\
         (allow file-read* (subpath \"{}\"))",
        workspace, workspace, executable_parent
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
        && !contains_forbidden_secret_material(key)
}

#[cfg(target_os = "macos")]
fn profile_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn contains_forbidden_secret_material(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "api_key",
        "api-key",
        "authorization",
        "credential",
        "password",
        "secret",
        "token",
        "bearer ",
        "sk-",
        "ds-",
        "minimax-",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
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
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
#[cfg(windows)]
const WAIT_OBJECT_0: u32 = 0;
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
fn run_windows(request: RunRequest) -> String {
    if let Some(code) = validate_windows_request(&request) {
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

    let result = create_windows_process(&request, job);
    unsafe { CloseHandle(job) };
    match result {
        Ok(result) => result,
        Err(code) => error_response(code),
    }
}

#[cfg(windows)]
fn create_windows_process(request: &RunRequest, job: Handle) -> Result<String, &'static str> {
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
    let created = unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command_line.as_mut_ptr(),
            null_mut(),
            null_mut(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment.as_mut_ptr().cast(),
            cwd.as_ptr(),
            &mut startup,
            &mut information,
        )
    } != 0;
    unsafe {
        CloseHandle(stdin_read);
        CloseHandle(stdin_write);
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);
    }
    if !created {
        close_many([stdout_read, stderr_read]);
        return Err("launch_failed");
    }
    if unsafe { AssignProcessToJobObject(job, information.process) } == 0 {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(information.thread);
            CloseHandle(information.process);
        }
        close_many([stdout_read, stderr_read]);
        return Err("job_assignment_failed");
    }
    if unsafe { ResumeThread(information.thread) } == u32::MAX {
        unsafe {
            TerminateJobObject(job, 1);
            CloseHandle(information.thread);
            CloseHandle(information.process);
        }
        close_many([stdout_read, stderr_read]);
        return Err("launch_failed");
    }

    let stdout = unsafe { File::from_raw_handle(stdout_read as RawHandle) };
    let stderr = unsafe { File::from_raw_handle(stderr_read as RawHandle) };
    let stdout_thread = thread::spawn(|| read_bounded(stdout));
    let stderr_thread = thread::spawn(|| read_bounded(stderr));
    let waited = unsafe { WaitForSingleObject(information.process, INFINITE) } == WAIT_OBJECT_0;
    let mut exit_code = 1;
    let exited = waited && unsafe { GetExitCodeProcess(information.process, &mut exit_code) } != 0;
    unsafe {
        // A validator must not leave a task-owned descendant behind after its
        // direct process exits. The Job Object owns the complete tree.
        TerminateJobObject(job, 0);
        CloseHandle(information.thread);
        CloseHandle(information.process);
    }
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
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
fn read_bounded(mut file: File) -> String {
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
    let mut value = String::new();
    for (key, entry) in environment {
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
fn validate_windows_request(request: &RunRequest) -> Option<&'static str> {
    let workspace = Path::new(&request.workspace);
    let cwd = Path::new(&request.cwd);
    if !workspace.is_absolute()
        || !cwd.is_absolute()
        || !Path::new(&request.executable).is_absolute()
    {
        return Some("invalid_path");
    }
    if has_reparse_component(workspace) || has_reparse_component(cwd) {
        return Some("reparse_forbidden");
    }
    let Ok(workspace) = fs::canonicalize(workspace) else {
        return Some("invalid_path");
    };
    let Ok(cwd) = fs::canonicalize(cwd) else {
        return Some("invalid_path");
    };
    if !windows_path_is_within(&cwd, &workspace) {
        return Some("workspace_escape");
    }
    if contains_reparse_tree(&workspace) {
        return Some("reparse_forbidden");
    }
    None
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
    use super::{response_for_line, MAX_LINE_BYTES};

    #[test]
    fn rejects_secrets_without_echoing_input() {
        let response =
            response_for_line(r#"{"v":1,"environment":{"CANDY_TOKEN":"sk-fixture-secret"}}"#);
        assert!(response.contains("secret_forbidden"));
        assert!(!response.contains("fixture"));
    }

    #[test]
    fn rejects_oversized_lines_before_protocol_processing() {
        let line = "x".repeat(MAX_LINE_BYTES + 1);
        assert!(response_for_line(&line).contains("line_too_large"));
    }

    #[test]
    fn rejects_network_and_relative_paths_before_launch() {
        let response = response_for_line(
            r#"{"v":1,"kind":"run","requestId":"fixture","executable":"node","args":[],"cwd":"/tmp","workspace":"/tmp","network":true,"environment":{}}"#,
        );
        assert!(response.contains("network_forbidden"));
        let response = response_for_line(
            r#"{"v":1,"kind":"run","requestId":"fixture","executable":"node","args":[],"cwd":"relative","workspace":"/tmp","network":false,"environment":{}}"#,
        );
        assert!(response.contains("invalid_path"));
    }
}
