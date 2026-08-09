use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: u32 = 1;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        let response = if line.contains(&format!("\"v\":{}", PROTOCOL_VERSION)) {
            format!(
                "{{\"v\":{},\"kind\":\"unsupported\",\"reason\":\"native security backend is not enabled\"}}",
                PROTOCOL_VERSION
            )
        } else {
            format!(
                "{{\"v\":{},\"kind\":\"error\",\"code\":\"unsupported_version\"}}",
                PROTOCOL_VERSION
            )
        };
        if writeln!(stdout, "{}", response).is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}
