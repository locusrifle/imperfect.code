//! A window around the same loopback machine `start.mjs` already runs.
//! This is not a second product and not the hosted door.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

const DEFAULT_PORT: u16 = 5067;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("desktop/src-tauri lives two levels under the repo")
        .to_path_buf()
}

fn prefix() -> PathBuf {
    if let Ok(given) = std::env::var("IMPERFECT_PREFIX") {
        return PathBuf::from(given);
    }
    let home = std::env::var("HOME").expect("HOME");
    PathBuf::from(home).join(".imperfect")
}

fn port() -> u16 {
    std::env::var("IMPERFECT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn health_ok(port: u16) -> bool {
    let mut stream = match TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(400),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = stream.read_to_string(&mut body);
    body.contains("native-gui")
}

fn wait_ready(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline {
        if health_ok(port) {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
    panic!("the machine did not become ready on 127.0.0.1:{port}");
}

fn spawn_machine(root: &Path, prefix: &Path, port: u16) -> Child {
    if !prefix.join("machine.json").is_file() {
        panic!(
            "missing {} — run desktop/install.sh first",
            prefix.join("machine.json").display()
        );
    }
    let start = root.join("start.mjs");
    if !start.is_file() {
        panic!("missing {}", start.display());
    }
    let _ = port;
    Command::new("node")
        .arg(&start)
        .env("IMPERFECT_PREFIX", prefix)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| panic!("could not start node: {e}"))
}

fn main() {
    let root = repo_root();
    let prefix = prefix();
    let port = port();
    let child = Mutex::new(if health_ok(port) {
        None
    } else {
        Some(spawn_machine(&root, &prefix, port))
    });
    wait_ready(port);

    let url = format!("http://127.0.0.1:{port}/");
    tauri::Builder::default()
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.navigate(url.parse().expect("loopback url"));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri failed to build")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut slot) = child.lock() {
                    if let Some(proc) = slot.as_mut() {
                        let _ = proc.kill();
                    }
                }
            }
        });
}
