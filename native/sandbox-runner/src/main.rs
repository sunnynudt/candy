use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::process::Command;

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
        let _ = request;
        error_response("unsupported_platform")
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
