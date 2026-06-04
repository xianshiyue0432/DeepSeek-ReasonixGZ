use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
#[cfg(not(debug_assertions))]
use tauri::Manager;
use which::which_all;

#[derive(Default)]
pub struct RpcState {
    inner: Arc<Mutex<Option<RpcHandle>>>,
}

struct RpcHandle {
    stdin: ChildStdin,
    /// Shared with the natural-exit watcher thread. `rpc_kill` takes the
    /// Child on app shutdown so it can poll try_wait synchronously and then
    /// tree-kill on timeout — Tauri's stock `child.kill()` only hits the
    /// direct Node child and leaves vite / http-server descendants orphaned
    /// past app shutdown (#907).
    child: Arc<parking_lot::Mutex<Option<Child>>>,
    child_pid: u32,
}

#[derive(Clone, Serialize)]
struct LineEvent {
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    code: Option<i32>,
}

/// Collect all places we might find the bundled dist/cli/index.js,
/// in priority order. Returns the first path that actually exists.
fn find_cli_entry(app: &AppHandle) -> Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Tauri resource_dir (NSIS / MSI install layout) — searched first
    //    because the install layout puts `dist/` there.
    #[cfg(not(debug_assertions))]
    if let Ok(res_dir_raw) = app.path().resource_dir() {
        // canonicalize to defend against bare-drive paths; skip if the
        // canonicalized form is still a bare drive.
        if let Ok(res_dir) = res_dir_raw.canonicalize() {
            if res_dir.components().count() > 1 {
                candidates.push(res_dir.join("dist").join("cli").join("index.js"));
            }
        }
        // Also try the un-canonicalized form (e.g. before first launch).
        if res_dir_raw.components().count() > 1 {
            candidates.push(res_dir_raw.join("dist").join("cli").join("index.js"));
        }
    }

    // 2. EXE-sibling (portable: dist/ + Reasonix.exe in the same folder).
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist").join("cli").join("index.js"));
            candidates.push(dir.join("..").join("dist").join("cli").join("index.js"));
        }
    }

    // 3. cwd-relative (dev / repo-root invocation).
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("dist").join("cli").join("index.js"));
        candidates.push(cwd.join("..").join("dist").join("cli").join("index.js"));
        candidates.push(cwd.join("..").join("..").join("dist").join("cli").join("index.js"));
    }

    for p in &candidates {
        if p.exists() {
            return Ok(p.clone());
        }
    }
    Err(anyhow!(
        "dist/cli/index.js not found. Searched: {:?}",
        candidates
    ))
}

/// Look for a bundled `node` binary shipped with the installer.
/// Search order: Tauri resource_dir → EXE sibling → EXE's dist/ → cwd's dist/ .
fn find_bundled_node(app: &AppHandle) -> Option<PathBuf> {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut tries: Vec<PathBuf> = Vec::new();

    // Resource dir (NSIS / MSI install layout).
    #[cfg(not(debug_assertions))]
    if let Ok(res_dir) = app.path().resource_dir() {
        tries.push(res_dir.join(node_name));
        if let Some(parent) = res_dir.parent() {
            tries.push(parent.join(node_name));
        }
    }

    // EXE sibling + dist (portable layout: dist/cli + dist/node).
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            tries.push(dir.join(node_name));
            tries.push(dir.join("dist").join(node_name));
        }
    }

    // cwd relative dist (dev mode).
    if let Ok(cwd) = env::current_dir() {
        tries.push(cwd.join("dist").join(node_name));
        tries.push(cwd.join("..").join("dist").join(node_name));
    }

    for p in tries {
        if let Ok(md) = std::fs::metadata(&p) {
            if md.len() > 1_000_000 {
                return Some(p);
            }
        }
    }
    None
}

fn resolve_cli(app: &AppHandle) -> Result<(String, Vec<String>)> {
    if let Ok(custom) = env::var("REASONIX_CLI") {
        let mut parts = custom.split_whitespace().map(String::from);
        let program = parts
            .next()
            .ok_or_else(|| anyhow!("REASONIX_CLI is empty"))?;
        return Ok((program, parts.collect()));
    }

    let entry = find_cli_entry(app)?;
    // Pre-validate the entry exists and is a file (not a directory).
    let entry_md = std::fs::metadata(&entry)
        .map_err(|e| anyhow!("metadata on entry: {e}"))?;
    if !entry_md.is_file() {
        return Err(anyhow!("entry is not a regular file: {}", entry.display()));
    }
    let entry_abs = if entry.is_absolute() {
        entry
    } else {
        std::path::absolute(&entry).unwrap_or(entry)
    };
    // Verify it has >1 path component (i.e. not a bare drive letter).
    if entry_abs.components().count() < 2 {
        return Err(anyhow!("entry resolved to a bare drive: {}", entry_abs.display()));
    }

    let program = match find_bundled_node(app) {
        Some(p) => {
            eprintln!("[reasonix] using bundled node: {}", p.display());
            p.to_string_lossy().into_owned()
        }
        None => {
            let p = find_real_node().context("node not found in PATH")?;
            eprintln!("[reasonix] using system node: {}", p.display());
            p.to_string_lossy().into_owned()
        }
    };

    let entry_str = entry_abs.to_string_lossy().into_owned();
    eprintln!("[reasonix] cli entry: {}", entry_str);
    eprintln!("[reasonix] cli entry parent (child CWD): {}",
        entry_abs.parent().map(|p| p.display().to_string()).unwrap_or_default());

    Ok((
        program,
        vec![entry_str, "desktop".to_string()],
    ))
}

/// Walk every PATH match for `node` and return the first one that is
/// (a) a real file > 50 KB on macOS/Linux, or > 100 KB on Windows, and
/// (b) NOT inside Windows' App Execution Alias directory.
/// Threshold must accommodate Homebrew Node ~68 KB on arm64 macOS.
fn find_real_node() -> Result<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    let min_size: u64 = if cfg!(windows) { 100_000 } else { 50_000 };
    let mut tried: Vec<String> = Vec::new();
    for name in names {
        if let Ok(iter) = which_all(*name) {
            for p in iter {
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let lower = p.to_string_lossy().to_lowercase();
                let is_ms_store_shim = lower.contains("windowsapps");
                let too_small = size < min_size;
                if !too_small && !is_ms_store_shim {
                    return Ok(p);
                }
                tried.push(format!(
                    "{} ({} bytes{})",
                    p.display(),
                    size,
                    if is_ms_store_shim { ", MS Store shim" } else { "" },
                ));
            }
        }
    }
    Err(anyhow!(
        "node not found in PATH or only stub binaries present.{}\nInstall Node 22 from nodejs.org and reopen Reasonix.",
        if tried.is_empty() {
            String::new()
        } else {
            format!(" Skipped: {}.", tried.join("; "))
        }
    ))
}

#[tauri::command]
pub fn rpc_spawn(app: AppHandle, state: State<'_, RpcState>) -> Result<(), String> {
    let mut guard = state.inner.lock();
    if guard.is_some() {
        // Idempotent — a second call (effect re-run, WebView reload) keeps the
        // existing Node child. The frontend follows up with `desktop_resync`
        // so a reloaded React app catches up on bootstrap events it missed.
        return Ok(());
    }

    let (program, args) = resolve_cli(&app).map_err(|e| e.to_string())?;
    eprintln!("[reasonix] spawning: {} {:?}", program, args);

    // Determine child CWD: use the entry point's parent directory (i.e. the
    // `dist/cli/` folder's parent = `dist/`). This is always a real,
    // absolute, non-bare-drive directory the moment we found the entry —
    // and it matches where `index.js`'s `import` graph is anchored, so
    // Node's module resolver never has to deal with bare drives.
    let child_cwd = Path::new(&args[0])
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "entry path has no parent directory".to_string())?;
    if child_cwd.components().count() < 2 {
        return Err(format!(
            "child CWD resolved to a bare drive: {}",
            child_cwd.display()
        ));
    }
    // Verify the CWD actually exists.
    if !child_cwd.is_dir() {
        return Err(format!(
            "child CWD is not an existing directory: {}",
            child_cwd.display()
        ));
    }
    eprintln!("[reasonix] child cwd: {}", child_cwd.display());

    // Build the command. We use `raw_arg` on Windows so Rust's standard
    // args-quoting layer can't accidentally re-interpret or truncate the
    // entry path (e.g. it once mangled a path into a bare `D:` form,
    // causing Node to lstat the drive root and fail with EISDIR).
    let mut cmd = Command::new(&program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // First arg: the entry script. Quote it to defend against spaces,
        // even though we already validated the path is absolute and clean.
        let entry_quoted = format!("\"{}\"", args[0].replace('"', "\\\""));
        cmd.raw_arg(entry_quoted);
        // Second arg: literal "desktop".
        cmd.raw_arg("desktop".to_string());
    }
    #[cfg(not(windows))]
    {
        cmd.arg(&args[0]);
        cmd.arg(&args[1]);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.current_dir(&child_cwd);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    eprintln!("[reasonix] spawning: program={} args={:?} cwd={}", program, args, child_cwd.display());
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let child_pid = child.id();

    let child_shared = Arc::new(parking_lot::Mutex::new(Some(child)));
    *guard = Some(RpcHandle {
        stdin,
        child: child_shared.clone(),
        child_pid,
    });
    drop(guard);

    let app_for_stdout = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_for_stdout.emit("rpc:event", LineEvent { data: line });
        }
    });

    let app_for_stderr = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_for_stderr.emit("rpc:stderr", LineEvent { data: line });
        }
    });

    // Natural-exit watcher: emits rpc:exit if Node dies on its own (crash,
    // explicit process.exit). rpc_kill owns the active-shutdown path; this
    // thread bails the moment that path takes the Child.
    let app_for_exit = app.clone();
    let inner_for_exit = state.inner.clone();
    let child_for_wait = child_shared;
    thread::spawn(move || loop {
        let status = {
            let mut guard = child_for_wait.lock();
            match guard.as_mut() {
                Some(c) => c.try_wait(),
                None => return,
            }
        };
        match status {
            Ok(Some(s)) => {
                child_for_wait.lock().take();
                let _ = inner_for_exit.lock().take();
                let _ = app_for_exit.emit("rpc:exit", ExitEvent { code: s.code() });
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(500)),
            Err(_) => {
                let _ = inner_for_exit.lock().take();
                return;
            }
        }
    });

    Ok(())
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
        let _ = Command::new("pkill")
            .args(["-KILL", "-P", &pid.to_string()])
            .status();
    }
}

/// Drop the spawned Node child cleanly. Used by Tauri-side teardown.
/// Closes Node's stdin (which trips its readline `close` → graceful job
/// shutdown), polls the child for up to 3 s, then tree-kills any survivors
/// so dev-server grandchildren don't outlive the desktop (#907).
#[tauri::command]
pub fn rpc_kill(state: State<'_, RpcState>) -> Result<(), String> {
    let handle_opt = state.inner.lock().take();
    let Some(handle) = handle_opt else { return Ok(()) };

    drop(handle.stdin);

    let deadline = Instant::now() + Duration::from_secs(3);
    let exited = loop {
        let done = {
            let mut guard = handle.child.lock();
            match guard.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(_)) => {
                        guard.take();
                        true
                    }
                    Ok(None) => false,
                    Err(_) => {
                        guard.take();
                        true
                    }
                },
                None => true,
            }
        };
        if done {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        thread::sleep(Duration::from_millis(50));
    };

    if !exited {
        kill_process_tree(handle.child_pid);
        if let Some(mut c) = handle.child.lock().take() {
            let _ = c.wait();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn rpc_send(state: State<'_, RpcState>, line: String) -> Result<(), String> {
    let mut guard = state.inner.lock();
    let handle = guard.as_mut().ok_or("rpc not spawned")?;
    writeln!(handle.stdin, "{line}").map_err(|e| format!("write: {e}"))?;
    handle.stdin.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}
