use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: u32 = 1;
const MAX_LINE_BYTES: usize = 1024 * 1024;

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
        return format!(
            "{{\"v\":{},\"kind\":\"error\",\"code\":\"line_too_large\"}}",
            PROTOCOL_VERSION
        );
    }
    if contains_forbidden_secret_material(line) {
        return format!(
            "{{\"v\":{},\"kind\":\"error\",\"code\":\"secret_forbidden\"}}",
            PROTOCOL_VERSION
        );
    }
    if !has_protocol_version(line) {
        return format!(
            "{{\"v\":{},\"kind\":\"error\",\"code\":\"unsupported_version\"}}",
            PROTOCOL_VERSION
        );
    }
    format!(
        "{{\"v\":{},\"kind\":\"unsupported\",\"reason\":\"native security backend is not enabled\"}}",
        PROTOCOL_VERSION
    )
}

fn has_protocol_version(line: &str) -> bool {
    line.contains("\"v\":1") || line.contains("\"v\": 1")
}

fn contains_forbidden_secret_material(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    [
        "\"api_key\"",
        "\"api-key\"",
        "\"authorization\"",
        "\"credential\"",
        "\"password\"",
        "\"secret\"",
        "\"token\"",
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
        let response = response_for_line(r#"{"v":1,"api_key":"sk-fixture-secret"}"#);
        assert!(response.contains("secret_forbidden"));
        assert!(!response.contains("fixture"));
    }

    #[test]
    fn rejects_oversized_lines_before_protocol_processing() {
        let line = "x".repeat(MAX_LINE_BYTES + 1);
        assert!(response_for_line(&line).contains("line_too_large"));
    }

    #[test]
    fn only_protocol_version_one_reaches_unsupported_backend_response() {
        assert!(response_for_line(r#"{"v":1,"kind":"run"}"#).contains("unsupported"));
        assert!(response_for_line(r#"{"v":2,"kind":"run"}"#).contains("unsupported_version"));
    }
}
