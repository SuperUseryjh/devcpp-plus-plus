use std::{
    collections::hash_map::DefaultHasher,
    ffi::OsString,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Instant,
};

use encoding_rs::{GBK, UTF_16BE, UTF_16LE, UTF_8};
use futures_util::{SinkExt, StreamExt};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::{
        Child, ChildStderr, ChildStdin, ChildStdout, Command as TokioCommand,
    },
    sync::{oneshot, Mutex},
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        Message,
    },
};
use uuid::Uuid;

#[derive(Default)]
struct AppState {
    lsp: Mutex<Option<LspHandle>>,
    dap: Mutex<Option<DapHandle>>,
    terminal: Mutex<Option<TerminalHandle>>,
    watcher: StdMutex<Option<RecommendedWatcher>>,
    build_cancel: Mutex<Option<oneshot::Sender<()>>>,
}

struct LspHandle {
    shutdown: oneshot::Sender<()>,
    intentional: Arc<AtomicBool>,
}

struct DapHandle {
    shutdown: oneshot::Sender<()>,
}

struct TerminalHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    child: Box<dyn PtyChild + Send>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspStopped {
    intentional: bool,
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    root: String,
    compile_commands_dir: Option<String>,
    sources: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileData {
    path: String,
    content: String,
    encoding: String,
    eol: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolchainInfo {
    gxx: Option<String>,
    gdb: Option<String>,
    clangd: Option<String>,
    cmake: Option<String>,
    ninja: Option<String>,
    gxx_version: Option<String>,
    clangd_version: Option<String>,
    cmake_version: Option<String>,
    ninja_version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspInfo {
    port: u16,
    token: String,
    clangd_path: String,
    gxx_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DapInfo {
    port: u16,
    token: String,
    gdb_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DapStopped {
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildDiagnostic {
    path: String,
    line: u32,
    character: u32,
    severity: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildResult {
    success: bool,
    output: String,
    exit_code: i32,
    executable: Option<String>,
    duration_ms: u64,
    diagnostics: Vec<BuildDiagnostic>,
    cancelled: bool,
}

struct BuildCommandOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
    cancelled: bool,
}

async fn stream_build_output<R>(
    reader: R,
    stream: &'static str,
    app: AppHandle,
    buffer: Arc<Mutex<String>>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let text = format!("{}
", line);
        buffer.lock().await.push_str(&text);
        let _ = app.emit(
            "build:event",
            json!({ "kind": "output", "stream": stream, "text": text }),
        );
    }
}

fn kill_process_tree(pid: Option<u32>) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000);
        let _ = command.output();
    }
    #[cfg(not(windows))]
    let _ = pid;
}

async fn run_build_command(
    mut cmd: TokioCommand,
    app: Option<AppHandle>,
    cancel: Option<oneshot::Receiver<()>>,
) -> Result<BuildCommandOutput, String> {
    let Some(app) = app else {
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("启动构建进程失败: {}", e))?;
        return Ok(BuildCommandOutput {
            status: output.status,
            stdout: decode_output(&output.stdout),
            stderr: decode_output(&output.stderr),
            cancelled: false,
        });
    };

    let _ = app.emit(
        "build:event",
        json!({ "kind": "started", "text": "正在构建..." }),
    );
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动构建进程失败: {}", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法获取构建 stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法获取构建 stderr".to_string())?;
    let stdout_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stdout_task = tokio::spawn(stream_build_output(
        stdout,
        "stdout",
        app.clone(),
        stdout_buffer.clone(),
    ));
    let stderr_task = tokio::spawn(stream_build_output(
        stderr,
        "stderr",
        app,
        stderr_buffer.clone(),
    ));

    let cancel_fut = async move {
        if let Some(receiver) = cancel {
            let _ = receiver.await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    let (status, cancelled) = tokio::select! {
        status = child.wait() => (
            status.map_err(|e| format!("等待构建进程失败: {}", e))?,
            false,
        ),
        _ = cancel_fut => {
            kill_process_tree(child.id());
            let status = child
                .wait()
                .await
                .map_err(|e| format!("等待构建进程失败: {}", e))?;
            (status, true)
        }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let stdout = stdout_buffer.lock().await.clone();
    let stderr = stderr_buffer.lock().await.clone();
    Ok(BuildCommandOutput {
        status,
        stdout,
        stderr,
        cancelled,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangeEvent {
    path: String,
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    path: String,
    line: u32,
    character: u32,
    preview: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorSettings {
    font_size: u32,
    tab_size: u32,
    minimap: bool,
    word_wrap: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            tab_size: 4,
            minimap: true,
            word_wrap: false,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BuildSettings {
    cxx_flags: Vec<String>,
    static_runtime: bool,
    external_console: bool,
}

impl Default for BuildSettings {
    fn default() -> Self {
        Self {
            cxx_flags: vec![
                "-std=c++20".to_string(),
                "-g".to_string(),
                "-O0".to_string(),
                "-Wall".to_string(),
                "-Wextra".to_string(),
            ],
            static_runtime: true,
            external_console: false,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
    schema_version: u32,
    editor: EditorSettings,
    build: BuildSettings,
    #[serde(default)]
    trusted_workspaces: Vec<String>,
    #[serde(default)]
    onboarding_completed: bool,
    #[serde(default = "default_terminal_shell")]
    terminal_shell: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            editor: EditorSettings::default(),
            build: BuildSettings::default(),
            trusted_workspaces: Vec::new(),
            onboarding_completed: false,
            terminal_shell: default_terminal_shell(),
        }
    }
}

fn default_terminal_shell() -> String {
    "cmd".to_string()
}

#[tauri::command]
async fn open_workspace(root: String) -> Result<WorkspaceInfo, String> {
    let root = normalize_existing_dir(&root)?;
    let db = if root.join("CMakeLists.txt").is_file() {
        match configure_cmake(&root).await {
            Ok(dir) => Some(dir),
            Err(err) => {
                eprintln!("[cmake] {}", err);
                compile_commands_dir(&root)
            }
        }
    } else {
        ensure_compile_commands(&root)?
    };
    let sources = collect_sources(&root).len();
    Ok(WorkspaceInfo {
        root: root.display().to_string(),
        compile_commands_dir: db.map(|p| p.display().to_string()),
        sources,
    })
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(path);
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| format!("读取目录失败: {}", e))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(
            name.as_str(),
            ".git"
                | ".devcpp"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".cache"
                | ".idea"
                | ".vs"
                | "out"
        ) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        entries.push(FileEntry {
            name,
            path: entry.path().display().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<FileData, String> {
    let path = PathBuf::from(path);
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    let (encoding, content) = decode_bytes(&bytes);
    let eol = if content.contains("\r\n") { "crlf" } else { "lf" };
    Ok(FileData {
        path: path.display().to_string(),
        content,
        encoding,
        eol: eol.to_string(),
    })
}

#[tauri::command]
fn save_text_file(path: String, content: String, encoding: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let bytes = match encoding.as_str() {
        "gbk" => {
            let (bytes, _, had_errors) = GBK.encode(&content);
            if had_errors {
                return Err("内容包含 GBK 无法表示的字符，请另存为 UTF-8".to_string());
            }
            bytes.into_owned()
        }
        "utf-16le" => {
            let mut out = vec![0xFF, 0xFE];
            let (bytes, _, _) = UTF_16LE.encode(&content);
            out.extend_from_slice(&bytes);
            out
        }
        "utf-16be" => {
            let mut out = vec![0xFE, 0xFF];
            let (bytes, _, _) = UTF_16BE.encode(&content);
            out.extend_from_slice(&bytes);
            out
        }
        _ => content.into_bytes(),
    };

    let parent = path
        .parent()
        .ok_or_else(|| "无效文件路径".to_string())?;
    let tmp = parent.join(format!(".devcpp-save-{}.tmp", Uuid::new_v4()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("替换文件失败: {}", e))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存文件失败: {}", e)
    })?;
    Ok(())
}

#[tauri::command]
fn create_file(root: String, path: String) -> Result<(), String> {
    let root_path = normalize_existing_dir(&root)?;
    let target = PathBuf::from(path);
    ensure_inside_root(&root_path, &target)?;
    if target.exists() {
        return Err(format!("文件已存在: {}", target.display()));
    }
    std::fs::write(&target, b"").map_err(|e| format!("创建文件失败: {}", e))
}

#[tauri::command]
fn create_directory(root: String, path: String) -> Result<(), String> {
    let root_path = normalize_existing_dir(&root)?;
    let target = PathBuf::from(path);
    ensure_inside_root(&root_path, &target)?;
    if target.exists() {
        return Err(format!("路径已存在: {}", target.display()));
    }
    std::fs::create_dir(&target).map_err(|e| format!("创建文件夹失败: {}", e))
}

#[tauri::command]
fn rename_path(root: String, from: String, to: String) -> Result<(), String> {
    let root_path = normalize_existing_dir(&root)?;
    let source = PathBuf::from(from);
    let target = PathBuf::from(to);
    ensure_inside_root(&root_path, &source)?;
    ensure_inside_root(&root_path, &target)?;
    if !source.exists() {
        return Err(format!("路径不存在: {}", source.display()));
    }
    if target.exists() {
        return Err(format!("目标已存在: {}", target.display()));
    }
    if source.is_dir() {
        let source_key = normalize_path_for_compare(&source);
        let target_key = normalize_path_for_compare(&target);
        let source_key = source_key.strip_prefix(r"\\?\").unwrap_or(&source_key);
        let target_key = target_key.strip_prefix(r"\\?\").unwrap_or(&target_key);
        if target_key == source_key || target_key.starts_with(&format!("{source_key}\\")) {
            return Err("不能把文件夹移动到自身或其子目录".to_string());
        }
    }
    std::fs::rename(&source, &target).map_err(|e| format!("重命名失败: {}", e))
}

#[tauri::command]
fn delete_path(root: String, path: String, permanent: bool) -> Result<(), String> {
    let root_path = normalize_existing_dir(&root)?;
    let target = PathBuf::from(path);
    ensure_inside_root(&root_path, &target)?;
    if normalize_path_for_compare(&root_path) == normalize_path_for_compare(&target) {
        return Err("不能删除工作区根目录".to_string());
    }
    if permanent {
        if target.is_dir() {
            std::fs::remove_dir_all(&target).map_err(|e| format!("删除文件夹失败: {}", e))
        } else {
            std::fs::remove_file(&target).map_err(|e| format!("删除文件失败: {}", e))
        }
    } else {
        trash::delete(&target).map_err(|e| format!("移入回收站失败: {}", e))
    }
}

#[tauri::command]
fn list_files(root: String) -> Result<Vec<FileEntry>, String> {
    let root = normalize_existing_dir(&root)?;
    let mut files = Vec::new();
    collect_files(&root, &mut files, 0, 5000);
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

#[tauri::command]
async fn search_workspace(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_blocking(root, query, max_results)
    })
    .await
    .map_err(|e| format!("搜索任务失败: {}", e))?
}

fn search_workspace_blocking(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    let root = normalize_existing_dir(&root)?;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = max_results.unwrap_or(200).clamp(1, 1000);
    let mut files = Vec::new();
    collect_files(&root, &mut files, 0, 5000);
    let mut matches = Vec::new();
    for entry in files {
        if matches.len() >= limit {
            break;
        }
        let path = PathBuf::from(&entry.path);
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.len() > 2 * 1024 * 1024 {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if bytes.contains(&0) {
            continue;
        }
        let (_, text) = decode_bytes(&bytes);
        for (line_index, line) in text.lines().enumerate() {
            let haystack = line.to_lowercase();
            let mut offset = 0;
            while let Some(found) = haystack[offset..].find(&query) {
                let byte_index = offset + found;
                let character = line[..byte_index].encode_utf16().count() as u32 + 1;
                let preview = if line.chars().count() > 240 {
                    let mut shortened: String = line.chars().take(240).collect();
                    shortened.push('…');
                    shortened
                } else {
                    line.trim().to_string()
                };
                matches.push(SearchMatch {
                    path: entry.path.clone(),
                    line: line_index as u32 + 1,
                    character,
                    preview,
                });
                if matches.len() >= limit {
                    break;
                }
                offset = byte_index + query.len().max(1);
            }
            if matches.len() >= limit {
                break;
            }
        }
    }
    Ok(matches)
}

#[tauri::command]
fn watch_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<(), String> {
    let root = normalize_existing_dir(&root)?;
    let app_handle = app.clone();
    let root_for_watcher = root.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let event = match result {
            Ok(event) => event,
            Err(err) => {
                eprintln!("[watcher] {}", err);
                return;
            }
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let kind = match event.kind {
            EventKind::Create(_) => "create",
            EventKind::Modify(_) => "modify",
            EventKind::Remove(_) => "remove",
            _ => "other",
        };
        for path in event.paths {
            if is_ignored_relative(&root_for_watcher, &path) {
                continue;
            }
            let _ = app_handle.emit(
                "file:changed",
                FileChangeEvent {
                    path: path.display().to_string(),
                    kind: kind.to_string(),
                },
            );
        }
    })
    .map_err(|e| format!("创建文件监视器失败: {}", e))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("监视工作区失败: {}", e))?;
    *state
        .watcher
        .lock()
        .map_err(|_| "文件监视器锁失败".to_string())? = Some(watcher);
    Ok(())
}

#[tauri::command]
fn unwatch_workspace(state: State<'_, AppState>) -> Result<(), String> {
    *state
        .watcher
        .lock()
        .map_err(|_| "文件监视器锁失败".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.is_file() {
        return Ok(AppSettings::default());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取设置失败: {}", e))?;
    match serde_json::from_str::<AppSettings>(&text) {
        Ok(settings) => Ok(settings),
        Err(err) => {
            eprintln!("[settings] 解析失败，使用默认设置: {}", err);
            Ok(AppSettings::default())
        }
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let mut settings = settings;
    settings.schema_version = 1;
    settings.editor.font_size = settings.editor.font_size.clamp(10, 32);
    settings.editor.tab_size = settings.editor.tab_size.clamp(1, 8);
    if settings.build.cxx_flags.iter().any(|flag| flag.contains('\0')) {
        return Err("编译参数包含非法字符".to_string());
    }
    let path = settings_path(&app)?;
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化设置失败: {}", e))?;
    let parent = path.parent().ok_or_else(|| "无效设置路径".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建设置目录失败: {}", e))?;
    let tmp = parent.join(format!(".settings-{}.tmp", Uuid::new_v4()));
    std::fs::write(&tmp, text).map_err(|e| format!("写入设置失败: {}", e))?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("替换设置失败: {}", e))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存设置失败: {}", e)
    })?;
    Ok(settings)
}

#[tauri::command]
fn detect_toolchain() -> ToolchainInfo {
    let gxx = find_gxx();
    let gdb = find_gdb();
    let clangd = find_clangd();
    let cmake = find_cmake();
    let ninja = find_ninja();
    ToolchainInfo {
        gxx_version: gxx.as_ref().and_then(|path| version_of(path)),
        clangd_version: clangd.as_ref().and_then(|path| version_of(path)),
        cmake_version: cmake.as_ref().and_then(|path| version_of(path)),
        ninja_version: ninja.as_ref().and_then(|path| version_of(path)),
        gxx: gxx.map(|path| path.display().to_string()),
        gdb: gdb.map(|path| path.display().to_string()),
        clangd: clangd.map(|path| path.display().to_string()),
        cmake: cmake.map(|path| path.display().to_string()),
        ninja: ninja.map(|path| path.display().to_string()),
    }
}

#[tauri::command]
fn example_workspace() -> Option<String> {
    example_path("examples/hello")
}

#[tauri::command]
fn cmake_example_workspace() -> Option<String> {
    example_path("examples/cmake-hello")
}

fn example_path(relative: &str) -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join(relative);
    if path.is_dir() {
        Some(path.display().to_string())
    } else {
        None
    }
}

#[tauri::command]
async fn start_lsp(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<LspInfo, String> {
    let root = normalize_existing_dir(&root)?;
    if let Some(old) = state.lsp.lock().await.take() {
        old.intentional.store(true, Ordering::SeqCst);
        let _ = old.shutdown.send(());
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    let (info, handle) = start_lsp_session(&root, Some(app)).await?;
    *state.lsp.lock().await = Some(handle);
    Ok(info)
}

async fn start_lsp_session(
    root: &Path,
    app: Option<AppHandle>,
) -> Result<(LspInfo, LspHandle), String> {
    ensure_compile_commands(root)?;

    let clangd = find_clangd().ok_or_else(|| {
        "未找到 clangd。请设置 DEVCPP_CLANGD，或把 clangd.exe 放到 tools/clangd/bin/".to_string()
    })?;
    let gxx = find_gxx().ok_or_else(|| "未找到 g++.exe，请检查 PATH".to_string())?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("无法监听本地 LSP 端口: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取 LSP 端口失败: {}", e))?
        .port();
    let token = format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );

    let mut cmd = TokioCommand::new(&clangd);
    cmd.arg("--background-index");
    if let Some(db) = compile_commands_dir(root) {
        cmd.arg(format!("--compile-commands-dir={}", db.display()));
    }
    // clangd 的 --query-driver 在 Windows 上对正斜杠更友好。
    cmd.arg(format!(
        "--query-driver={}",
        gxx.display().to_string().replace('\\', "/")
    ));
    cmd.current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C")
        .env("LANG", "C");
    if let Some(path) = path_with_prefix(gxx.parent()) {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 clangd 失败: {}", e))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法获取 clangd stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法获取 clangd stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法获取 clangd stderr".to_string())?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let token_for_bridge = token.clone();
    let intentional = Arc::new(AtomicBool::new(false));
    let intentional_for_bridge = intentional.clone();
    tokio::spawn(async move {
        if let Err(err) = run_bridge(
            listener,
            token_for_bridge,
            stdin,
            stdout,
            stderr,
            child,
            app,
            shutdown_rx,
            intentional_for_bridge,
        )
        .await
        {
            eprintln!("[lsp] bridge stopped: {}", err);
        }
    });

    Ok((
        LspInfo {
            port,
            token,
            clangd_path: clangd.display().to_string(),
            gxx_path: gxx.display().to_string(),
        },
        LspHandle {
            shutdown: shutdown_tx,
            intentional,
        },
    ))
}

#[tauri::command]
async fn stop_lsp(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.lsp.lock().await.take() {
        handle.intentional.store(true, Ordering::SeqCst);
        let _ = handle.shutdown.send(());
    }
    Ok(())
}

#[tauri::command]
async fn start_dap(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<DapInfo, String> {
    let root = normalize_existing_dir(&root)?;
    if let Some(old) = state.dap.lock().await.take() {
        let _ = old.shutdown.send(());
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
    let (info, handle) = start_dap_session(&root, Some(app)).await?;
    *state.dap.lock().await = Some(handle);
    Ok(info)
}

async fn start_dap_session(
    root: &Path,
    app: Option<AppHandle>,
) -> Result<(DapInfo, DapHandle), String> {
    let gdb = find_gdb().ok_or_else(|| {
        "未找到可用的 gdb.exe。请安装 MinGW-w64 GDB 14+，或设置 DEVCPP_GDB".to_string()
    })?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("无法监听调试端口: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取调试端口失败: {}", e))?
        .port();
    let token = format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );

    let mut cmd = TokioCommand::new(&gdb);
    cmd.arg("--interpreter=dap")
        .arg("--quiet")
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(gxx) = find_gxx() {
        if let Some(path) = path_with_prefix(gxx.parent()) {
            cmd.env("PATH", path);
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 gdb DAP 失败: {}", e))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法获取 gdb stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法获取 gdb stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法获取 gdb stderr".to_string())?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let token_for_bridge = token.clone();
    tokio::spawn(async move {
        if let Err(err) = run_dap_bridge(
            listener,
            token_for_bridge,
            stdin,
            stdout,
            stderr,
            child,
            app,
            shutdown_rx,
        )
        .await
        {
            eprintln!("[dap] bridge stopped: {}", err);
        }
    });
    Ok((
        DapInfo {
            port,
            token,
            gdb_path: gdb.display().to_string(),
        },
        DapHandle {
            shutdown: shutdown_tx,
        },
    ))
}

#[tauri::command]
async fn stop_dap(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.dap.lock().await.take() {
        let _ = handle.shutdown.send(());
    }
    Ok(())
}

async fn run_dap_bridge(
    listener: TcpListener,
    token: String,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    mut child: Child,
    app: Option<AppHandle>,
    mut shutdown_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let (stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("接受调试 WebSocket 连接失败: {}", e))?;
    let ws = accept_hdr_async(stream, move |request: &Request, response: Response| {
        authorize(request, response, &token)
    })
    .await
    .map_err(|e| format!("调试 WebSocket 握手失败: {}", e))?;
    let (mut ws_tx, mut ws_rx) = ws.split();
    let mut stdin = stdin;
    let mut stdout = BufReader::new(stdout);
    let log_app = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(app) = &log_app {
                let _ = app.emit("dap:log", line);
            } else {
                eprintln!("[gdb] {}", line);
            }
        }
    });

    let stop_reason: String;
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                stop_reason = "调试已停止".to_string();
                break;
            }
            status = child.wait() => {
                stop_reason = match status {
                    Ok(status) => format!("gdb 已退出: {}", status),
                    Err(err) => format!("等待 gdb 退出失败: {}", err),
                };
                break;
            }
            incoming = ws_rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        write_lsp(&mut stdin, text.as_str()).await?;
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws_tx.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        stop_reason = "调试 WebSocket 已断开".to_string();
                        break;
                    }
                    Some(Err(err)) => return Err(format!("调试 WebSocket 读取失败: {}", err)),
                    _ => {}
                }
            }
            outgoing = read_lsp(&mut stdout) => {
                match outgoing {
                    Ok(Some(body)) => {
                        ws_tx
                            .send(Message::text(body))
                            .await
                            .map_err(|e| format!("发送调试消息失败: {}", e))?;
                    }
                    Ok(None) => {
                        stop_reason = "gdb 输出已关闭".to_string();
                        break;
                    }
                    Err(err) => return Err(err),
                }
            }
        }
    }
    let _ = child.kill().await;
    if let Some(app) = &app {
        let _ = app.emit("dap:stopped", DapStopped { reason: stop_reason });
    }
    Ok(())
}

#[tauri::command]
async fn start_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    root: Option<String>,
    shell: Option<String>,
) -> Result<(), String> {
    if let Some(mut old) = state.terminal.lock().await.take() {
        let _ = old.child.kill();
    }
    let cwd = match root {
        Some(root) => Some(normalize_existing_dir(&root)?),
        None => None,
    };
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建终端失败: {}", e))?;
    let shell_kind = shell.unwrap_or_else(|| "cmd".to_string());
    let mut command = if shell_kind.eq_ignore_ascii_case("powershell") {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command.arg("-NoProfile");
        command.arg("-NoExit");
        command.arg("-Command");
        command.arg("[Console]::OutputEncoding=[Text.Encoding]::UTF8");
        command
    } else {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut command = CommandBuilder::new(shell);
        command.arg("/Q");
        command.arg("/K");
        command.arg("chcp 65001>nul");
        command
    };
    if let Some(cwd) = cwd.as_ref() {
        command.cwd(cwd);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("启动终端 shell 失败: {}", e))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("读取终端失败: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("写入终端失败: {}", e))?;
    let master = pair.master;
    let data_app = app.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let text = String::from_utf8_lossy(&buffer[..count]).to_string();
                    let _ = data_app.emit("terminal:data", text);
                }
                Err(_) => break,
            }
        }
        let _ = data_app.emit("terminal:exit", ());
    });
    *state.terminal.lock().await = Some(TerminalHandle {
        master,
        writer,
        child,
    });
    Ok(())
}

#[tauri::command]
async fn write_terminal(state: State<'_, AppState>, data: String) -> Result<(), String> {
    if let Some(terminal) = state.terminal.lock().await.as_mut() {
        use std::io::Write;
        terminal
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("写入终端失败: {}", e))?;
        terminal
            .writer
            .flush()
            .map_err(|e| format!("刷新终端失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn resize_terminal(
    state: State<'_, AppState>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    if let Some(terminal) = state.terminal.lock().await.as_mut() {
        terminal
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整终端大小失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn stop_terminal(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(mut terminal) = state.terminal.lock().await.take() {
        let _ = terminal.child.kill();
    }
    Ok(())
}

#[tauri::command]
async fn build_and_run(
    root: String,
    file: String,
    stdin: Option<String>,
    cxx_flags: Option<Vec<String>>,
    static_runtime: Option<bool>,
) -> Result<BuildResult, String> {
    build_and_run_core(
        root,
        file,
        stdin,
        cxx_flags,
        static_runtime,
        None,
        None,
        false,
        true,
    )
    .await
}

#[tauri::command]
async fn build_and_run_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    file: String,
    stdin: Option<String>,
    cxx_flags: Option<Vec<String>>,
    static_runtime: Option<bool>,
    external_console: Option<bool>,
    run: Option<bool>,
) -> Result<BuildResult, String> {
    let settings = load_settings(app.clone())?;
    let normalized_root = normalize_path_for_compare(Path::new(&root));
    let trusted = settings
        .trusted_workspaces
        .iter()
        .any(|path| normalize_path_for_compare(Path::new(path)) == normalized_root);
    if !trusted {
        return Err("工作区未信任：请先在受限模式横幅中信任此工作区".to_string());
    }
    let (cancel_tx, cancel_rx) = oneshot::channel();
    *state.build_cancel.lock().await = Some(cancel_tx);
    let result = build_and_run_core(
        root,
        file,
        stdin,
        cxx_flags,
        static_runtime,
        Some(app),
        Some(cancel_rx),
        external_console.unwrap_or(false),
        run.unwrap_or(true),
    )
    .await;
    *state.build_cancel.lock().await = None;
    result
}

#[tauri::command]
async fn cancel_build(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state.build_cancel.lock().await.take() {
        let _ = cancel.send(());
    }
    Ok(())
}

async fn build_and_run_core(
    root: String,
    file: String,
    stdin: Option<String>,
    cxx_flags: Option<Vec<String>>,
    static_runtime: Option<bool>,
    app: Option<AppHandle>,
    cancel: Option<oneshot::Receiver<()>>,
    external_console: bool,
    should_run: bool,
) -> Result<BuildResult, String> {
    let root = normalize_existing_dir(&root)?;
    let file = PathBuf::from(file);
    if !file.is_file() {
        return Err(format!("文件不存在: {}", file.display()));
    }
    if root.join("CMakeLists.txt").is_file() {
        return build_and_run_cmake(
            &root,
            stdin,
            cxx_flags,
            static_runtime,
            app,
            cancel,
            external_console,
            should_run,
        )
        .await;
    }
    let flags = cxx_flags.unwrap_or_else(|| BuildSettings::default().cxx_flags);
    if flags.iter().any(|flag| flag.contains('\0')) {
        return Err("编译参数包含非法字符".to_string());
    }
    let use_static_runtime = static_runtime.unwrap_or(true);
    let gxx = find_gxx().ok_or_else(|| "未找到 g++.exe，请检查 PATH".to_string())?;
    let out_dir = build_output_dir(&root);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建构建目录失败: {}", e))?;
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "main".to_string());
    let exe = out_dir.join(format!("{}.exe", stem));

    let start = Instant::now();
    let mut cmd = TokioCommand::new(&gxx);
    cmd.current_dir(&root)
        .args(&flags)
        .arg(&file)
        .arg("-o")
        .arg(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C")
        .env("LANG", "C");
    if use_static_runtime {
        cmd.arg("-static-libgcc").arg("-static-libstdc++");
    }
    if let Some(path) = path_with_prefix(gxx.parent()) {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let compile = run_build_command(cmd, app, cancel).await?;
    let compile_status = compile.status;
    let compile_stdout = compile.stdout;
    let compile_stderr = compile.stderr;
    let diagnostics = parse_build_diagnostics(
        &format!("{}{}", compile_stdout, compile_stderr),
        &root,
    );
    let mut output = String::new();
    output.push_str(&format!(
        "> {} {} {} -o {}\n",
        gxx.display(),
        flags.join(" "),
        file.display(),
        exe.display()
    ));
    output.push_str(&compile_stdout);
    output.push_str(&compile_stderr);

    if compile.cancelled {
        return Ok(BuildResult {
            success: false,
            output,
            exit_code: -1,
            executable: None,
            duration_ms: start.elapsed().as_millis() as u64,
            diagnostics,
            cancelled: true,
        });
    }

    if !compile_status.success() {
        return Ok(BuildResult {
            success: false,
            output,
            exit_code: compile_status.code().unwrap_or(-1),
            executable: None,
            duration_ms: start.elapsed().as_millis() as u64,
            diagnostics,
            cancelled: false,
        });
    }

    if !should_run {
        return Ok(BuildResult {
            success: true,
            output,
            exit_code: 0,
            executable: Some(exe.display().to_string()),
            duration_ms: start.elapsed().as_millis() as u64,
            diagnostics,
            cancelled: false,
        });
    }

    let executed = run_program(&exe, &root, &gxx, stdin, external_console).await?;
    output.push_str("\n--- 程序输出 ---\n");
    output.push_str(&decode_output(&executed.stdout));
    output.push_str(&decode_output(&executed.stderr));

    Ok(BuildResult {
        success: true,
        output,
        exit_code: executed.status.code().unwrap_or(-1),
        executable: Some(exe.display().to_string()),
        duration_ms: start.elapsed().as_millis() as u64,
        diagnostics,
        cancelled: false,
    })
}

async fn run_program(
    exe: &Path,
    root: &Path,
    gxx: &Path,
    stdin: Option<String>,
    external_console: bool,
) -> Result<Output, String> {
    if external_console {
        return run_program_external(exe, root, gxx).await;
    }
    let mut run = TokioCommand::new(exe);
    run.current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        run.stdin(Stdio::piped());
    } else {
        run.stdin(Stdio::null());
    }
    if let Some(path) = path_with_prefix(gxx.parent()) {
        run.env("PATH", path);
    }
    #[cfg(windows)]
    run.creation_flags(0x0800_0000);

    let mut child = run
        .spawn()
        .map_err(|e| format!("运行程序失败: {}", e))?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input.as_bytes())
                .await
                .map_err(|e| format!("写入程序 stdin 失败: {}", e))?;
            pipe.shutdown()
                .await
                .map_err(|e| format!("关闭程序 stdin 失败: {}", e))?;
        }
    }
    child
        .wait_with_output()
        .await
        .map_err(|e| format!("等待程序结束失败: {}", e))
}

pub fn run_external_runner(args: &[String]) -> i32 {
    #[cfg(windows)]
    unsafe {
        if windows::Win32::System::Console::GetConsoleWindow().0.is_null() {
            let _ = windows::Win32::System::Console::AllocConsole();
        }
    }
    let Some(program) = args.first() else {
        return 1;
    };
    let mut command = std::process::Command::new(program);
    if let Some(cwd) = args.get(1) {
        command.current_dir(cwd);
    }
    command
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
    let code = command
        .status()
        .map(|status| status.code().unwrap_or(1))
        .unwrap_or(1);
    println!("
程序已退出，按回车关闭窗口...");
    use std::io::Write;
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    code
}

async fn run_program_external(exe: &Path, root: &Path, gxx: &Path) -> Result<Output, String> {
    let helper = std::env::current_exe()
        .map_err(|e| format!("定位 DevCpp++ 运行器失败: {}", e))?;
    let mut run = TokioCommand::new(helper);
    run.current_dir(root)
        .arg("--external-runner")
        .arg(exe)
        .arg(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(path) = path_with_prefix(gxx.parent()) {
        run.env("PATH", path);
    }
    #[cfg(windows)]
    run.creation_flags(0x0000_0010);
    let status = run
        .status()
        .await
        .map_err(|e| format!("在外部控制台运行程序失败: {}", e))?;
    Ok(Output {
        status,
        stdout: Vec::new(),
        stderr: Vec::new(),
    })
}

async fn build_and_run_cmake(
    root: &Path,
    stdin: Option<String>,
    _cxx_flags: Option<Vec<String>>,
    _static_runtime: Option<bool>,
    app: Option<AppHandle>,
    cancel: Option<oneshot::Receiver<()>>,
    external_console: bool,
    should_run: bool,
) -> Result<BuildResult, String> {
    let start = Instant::now();
    let gxx = find_gxx().ok_or_else(|| "未找到 g++.exe，请检查 PATH".to_string())?;
    let build_dir = match configure_cmake(root).await {
        Ok(dir) => dir,
        Err(err) => {
            return Ok(BuildResult {
                success: false,
                output: err,
                exit_code: -1,
                executable: None,
                duration_ms: start.elapsed().as_millis() as u64,
                diagnostics: Vec::new(),
                cancelled: false,
            });
        }
    };
    let cmake = find_cmake().ok_or_else(|| "未找到 cmake.exe".to_string())?;
    let mut cmd = TokioCommand::new(&cmake);
    cmd.current_dir(root)
        .arg("--build")
        .arg(&build_dir)
        .arg("--parallel")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("CLICOLOR", "0")
        .env("NO_COLOR", "1");
    if let Some(path) = path_with_prefix(gxx.parent()) {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let build = run_build_command(cmd, app, cancel).await?;
    let build_status = build.status;
    let build_stdout = build.stdout;
    let build_stderr = build.stderr;
    let diagnostics = parse_build_diagnostics(
        &format!("{}{}", build_stdout, build_stderr),
        root,
    );
    let mut output = format!("> cmake --build {}\n", build_dir.display());
    output.push_str(&build_stdout);
    output.push_str(&build_stderr);
    if build.cancelled {
        return Ok(BuildResult {
            success: false,
            output,
            exit_code: -1,
            executable: None,
            duration_ms: start.elapsed().as_millis() as u64,
            diagnostics,
            cancelled: true,
        });
    }

    if !build_status.success() {
        return Ok(BuildResult {
            success: false,
            output,
            exit_code: build_status.code().unwrap_or(-1),
            executable: None,
            duration_ms: start.elapsed().as_millis() as u64,
            diagnostics,
            cancelled: false,
        });
    }

    let exe = find_cmake_executable(&build_dir).ok_or_else(|| {
        format!(
            "CMake 构建成功，但未在 {} 找到可执行文件",
            build_dir.display()
        )
    })?;
    if !should_run {
        return Ok(BuildResult {
            success: true,
            output,
            exit_code: 0,
            executable: Some(exe.display().to_string()),
            duration_ms: start.elapsed().as_millis() as u64,
            diagnostics,
            cancelled: false,
        });
    }

    let executed = run_program(&exe, root, &gxx, stdin, external_console).await?;
    output.push_str("\n--- 程序输出 ---\n");
    output.push_str(&decode_output(&executed.stdout));
    output.push_str(&decode_output(&executed.stderr));

    Ok(BuildResult {
        success: true,
        output,
        exit_code: executed.status.code().unwrap_or(-1),
        executable: Some(exe.display().to_string()),
        duration_ms: start.elapsed().as_millis() as u64,
        diagnostics,
        cancelled: false,
    })
}

async fn configure_cmake(root: &Path) -> Result<PathBuf, String> {
    let build_dir = cmake_build_dir(root);
    if build_dir.join("CMakeCache.txt").is_file() {
        return Ok(build_dir);
    }
    std::fs::create_dir_all(&build_dir)
        .map_err(|e| format!("创建 CMake 构建目录失败: {}", e))?;
    let cmake = find_cmake().ok_or_else(|| "未找到 cmake.exe".to_string())?;
    let gxx = find_gxx().ok_or_else(|| "未找到 g++.exe".to_string())?;
    let gcc = find_gcc().unwrap_or_else(|| gxx.with_file_name("gcc.exe"));
    let bin_dir = build_dir.join("bin");

    let mut cmd = TokioCommand::new(&cmake);
    cmd.current_dir(root)
        .arg("-S")
        .arg(root)
        .arg("-B")
        .arg(&build_dir)
        .arg("-DCMAKE_BUILD_TYPE=Debug")
        .arg("-DCMAKE_EXPORT_COMPILE_COMMANDS=ON")
        .arg("-DCMAKE_COLOR_DIAGNOSTICS=OFF")
        .arg(format!(
            "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY={}",
            bin_dir.display()
        ))
        .arg(format!("-DCMAKE_C_COMPILER={}", gcc.display()))
        .arg(format!("-DCMAKE_CXX_COMPILER={}", gxx.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("CLICOLOR", "0")
        .env("NO_COLOR", "1");
    if let Some(ninja) = find_ninja() {
        cmd.arg("-G").arg("Ninja");
        cmd.arg(format!("-DCMAKE_MAKE_PROGRAM={}", ninja.display()));
    } else if let Some(make) = find_tool("mingw32-make").or_else(|| find_tool("make")) {
        cmd.arg("-G").arg("MinGW Makefiles");
        cmd.arg(format!("-DCMAKE_MAKE_PROGRAM={}", make.display()));
    } else {
        return Err("未找到 Ninja 或 mingw32-make，无法配置 CMake 项目".to_string());
    }
    if let Some(path) = path_with_prefix(gxx.parent()) {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let configured = cmd
        .output()
        .await
        .map_err(|e| format!("启动 cmake 配置失败: {}", e))?;
    if !configured.status.success() {
        return Err(format!(
            "CMake 配置失败 (exit {}):\n{}\n{}",
            configured.status.code().unwrap_or(-1),
            decode_output(&configured.stdout),
            decode_output(&configured.stderr)
        ));
    }
    Ok(build_dir)
}

fn cmake_build_dir(root: &Path) -> PathBuf {
    build_output_dir(root).join("cmake")
}

fn find_cmake_executable(build_dir: &Path) -> Option<PathBuf> {
    let bin = build_dir.join("bin");
    let base = if bin.is_dir() { bin.as_path() } else { build_dir };
    let mut executables = Vec::new();
    collect_executables(base, &mut executables, 0);
    executables.sort_by_key(|path| {
        std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    executables.pop()
}

fn collect_executables(dir: &Path, executables: &mut Vec<PathBuf>, depth: usize) {
    if depth > 4 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name == "CMakeFiles")
                .unwrap_or(false)
            {
                continue;
            }
            collect_executables(&path, executables, depth + 1);
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
        {
            executables.push(path);
        }
    }
}

fn normalize_existing_dir(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("不是有效文件夹: {}", path.display()));
    }
    Ok(path)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取设置目录失败: {}", e))?;
    Ok(dir.join("settings.json"))
}

fn normalize_path_for_compare(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn ensure_inside_root(root: &Path, target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("路径必须是绝对路径".to_string());
    }
    let root_canon = std::fs::canonicalize(root)
        .map_err(|e| format!("工作区路径无效: {}", e))?;
    let target_abs = if target.exists() {
        std::fs::canonicalize(target)
            .map_err(|e| format!("目标路径无效: {}", e))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| "目标路径没有父目录".to_string())?;
        let name = target
            .file_name()
            .ok_or_else(|| "目标路径没有文件名".to_string())?;
        if name == ".." {
            return Err("目标路径不能越过工作区".to_string());
        }
        std::fs::canonicalize(parent)
            .map_err(|e| format!("目标父目录无效: {}", e))?
            .join(name)
    };
    if !target_abs.starts_with(&root_canon) {
        return Err("目标路径不在工作区内".to_string());
    }
    Ok(())
}

fn is_ignored_name(name: &str) -> bool {
    if name.to_lowercase().starts_with(".devcpp-save-") {
        return true;
    }
    matches!(
        name.to_lowercase().as_str(),
        ".git"
            | ".devcpp"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".cache"
            | ".idea"
            | ".vs"
            | "out"
    )
}

fn is_ignored_relative(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .any(|component| {
            component
                .as_os_str()
                .to_str()
                .map(is_ignored_name)
                .unwrap_or(false)
        })
}

fn collect_files(dir: &Path, files: &mut Vec<FileEntry>, depth: usize, limit: usize) {
    if depth > 12 || files.len() >= limit {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if files.len() >= limit {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            collect_files(&path, files, depth + 1, limit);
        } else {
            files.push(FileEntry {
                name,
                path: path.display().to_string(),
                is_dir: false,
            });
        }
    }
}

fn parse_build_diagnostics(text: &str, root: &Path) -> Vec<BuildDiagnostic> {
    let re = match Regex::new(
        r"(?m)^(.+?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$",
    ) {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    let mut diagnostics = Vec::new();
    for captures in re.captures_iter(text) {
        let raw_path = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let path = PathBuf::from(raw_path);
        let path = if path.is_absolute() {
            path
        } else {
            root.join(path)
        };
        let severity = match captures.get(4).map(|m| m.as_str()).unwrap_or("") {
            "warning" => "warning",
            "note" => "info",
            _ => "error",
        };
        diagnostics.push(BuildDiagnostic {
            path: path.display().to_string(),
            line: captures
                .get(2)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(1),
            character: captures
                .get(3)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(1),
            severity: severity.to_string(),
            message: captures
                .get(5)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default(),
        });
    }
    diagnostics
}

fn decode_bytes(bytes: &[u8]) -> (String, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (text, _, _) = UTF_8.decode(&bytes[3..]);
        return ("utf-8".to_string(), text.into_owned());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = UTF_16LE.decode(&bytes[2..]);
        return ("utf-16le".to_string(), text.into_owned());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = UTF_16BE.decode(&bytes[2..]);
        return ("utf-16be".to_string(), text.into_owned());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return ("utf-8".to_string(), text.to_string());
    }
    let (text, _, _) = GBK.decode(bytes);
    ("gbk".to_string(), text.into_owned())
}

fn decode_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let (text, _, _) = GBK.decode(bytes);
    text.into_owned()
}

fn ensure_compile_commands(root: &Path) -> Result<Option<PathBuf>, String> {
    if root.join("CMakeLists.txt").is_file() {
        return Ok(compile_commands_dir(root));
    }
    if root.join("compile_commands.json").is_file() {
        return Ok(Some(root.to_path_buf()));
    }
    let devcpp = root.join(".devcpp");
    let db = devcpp.join("compile_commands.json");
    if db.is_file() {
        return Ok(Some(devcpp));
    }

    let sources = collect_sources(root);
    if sources.is_empty() {
        return Ok(None);
    }
    let gxx = find_gxx().ok_or_else(|| "未找到 g++，无法生成 compile_commands.json".to_string())?;
    std::fs::create_dir_all(&devcpp).map_err(|e| format!("创建 .devcpp 失败: {}", e))?;

    let include = root.join("include");
    let mut entries: Vec<Value> = Vec::new();
    for source in sources {
        let mut arguments = vec![
            gxx.display().to_string(),
            "-std=c++20".to_string(),
            "-g".to_string(),
            "-O0".to_string(),
            "-Wall".to_string(),
            "-Wextra".to_string(),
        ];
        if include.is_dir() {
            arguments.push(format!("-I{}", include.display()));
        }
        arguments.push("-c".to_string());
        arguments.push(source.display().to_string());
        entries.push(json!({
            "directory": root.display().to_string(),
            "file": source.display().to_string(),
            "arguments": arguments,
        }));
    }

    let text = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化 compile_commands 失败: {}", e))?;
    std::fs::write(&db, text).map_err(|e| format!("写入 compile_commands 失败: {}", e))?;
    Ok(Some(devcpp))
}

fn compile_commands_dir(root: &Path) -> Option<PathBuf> {
    if root.join("compile_commands.json").is_file() {
        return Some(root.to_path_buf());
    }
    let cmake = cmake_build_dir(root);
    if cmake.join("compile_commands.json").is_file() {
        return Some(cmake);
    }
    if root.join("build/compile_commands.json").is_file() {
        return Some(root.join("build"));
    }
    if root.join(".devcpp/compile_commands.json").is_file() {
        return Some(root.join(".devcpp"));
    }
    None
}

fn collect_sources(root: &Path) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    collect_sources_inner(root, &mut sources, 0);
    sources.sort();
    sources
}

fn collect_sources_inner(dir: &Path, sources: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if matches!(
                name.as_str(),
                ".git"
                    | ".devcpp"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".cache"
                    | ".idea"
                    | ".vs"
                    | "out"
            ) {
                continue;
            }
            collect_sources_inner(&path, sources, depth + 1);
        } else if matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("cpp" | "cc" | "cxx" | "c++")
        ) {
            sources.push(path);
        }
    }
}

fn build_output_dir(root: &Path) -> PathBuf {
    if root.to_string_lossy().is_ascii() {
        return root.join(".devcpp").join("build");
    }
    // GCC 13 在“中文输出路径 + 正斜杠”下有已知问题；非 ASCII 工作区使用 ASCII 构建目录。
    let base = std::env::var_os("PUBLIC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"));
    base.join("devcpp-plus-plus")
        .join("build")
        .join(path_hash(root))
}

fn path_hash(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn find_clangd() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DEVCPP_CLANGD") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }

    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tools/clangd/bin/clangd.exe");
    if dev_path.is_file() {
        return Some(dev_path);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("tools/clangd/bin/clangd.exe");
            if bundled.is_file() {
                return Some(bundled);
            }
            let alongside = dir.join("clangd.exe");
            if alongside.is_file() {
                return Some(alongside);
            }
        }
    }

    which::which("clangd")
        .ok()
        .or_else(|| which::which("clangd.exe").ok())
}

fn find_cmake() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DEVCPP_CMAKE") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    let dev_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/cmake/bin/cmake.exe");
    if dev_path.is_file() {
        return Some(dev_path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("tools/cmake/bin/cmake.exe");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }
    which::which("cmake")
        .ok()
        .or_else(|| which::which("cmake.exe").ok())
}

fn find_ninja() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DEVCPP_NINJA") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    let dev_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/ninja/ninja.exe");
    if dev_path.is_file() {
        return Some(dev_path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("tools/ninja/ninja.exe");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }
    which::which("ninja")
        .ok()
        .or_else(|| which::which("ninja.exe").ok())
}

fn find_gcc() -> Option<PathBuf> {
    if let Some(gxx) = find_gxx() {
        if let Some(parent) = gxx.parent() {
            let gcc = parent.join("gcc.exe");
            if gcc.is_file() {
                return Some(gcc);
            }
        }
    }
    which::which("gcc.exe")
        .ok()
        .or_else(|| which::which("gcc").ok())
}

fn find_gxx() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DEVCPP_GXX") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    which::which("g++.exe")
        .ok()
        .or_else(|| which::which("g++").ok())
}

fn find_tool(name: &str) -> Option<PathBuf> {
    which::which(name)
        .ok()
        .or_else(|| which::which(format!("{}.exe", name)).ok())
}

fn find_gdb() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DEVCPP_GDB") {
        let path = PathBuf::from(value);
        if path.is_file() && version_of(&path).is_some() {
            return Some(path);
        }
    }
    let common = PathBuf::from("C:/ProgramData/mingw64/mingw64/bin/gdb.exe");
    if common.is_file() && version_of(&common).is_some() {
        return Some(common);
    }
    let mut candidates = Vec::new();
    if let Ok(paths) = which::which_all("gdb.exe") {
        candidates.extend(paths);
    }
    if let Ok(paths) = which::which_all("gdb") {
        candidates.extend(paths);
    }
    candidates.into_iter().find(|path| path.is_file() && version_of(path).is_some())
}

fn version_of(exe: &Path) -> Option<String> {
    let mut command = std::process::Command::new(exe);
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
}

fn path_with_prefix(dir: Option<&Path>) -> Option<OsString> {
    let current = std::env::var_os("PATH")?;
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(dir) = dir {
        paths.push(dir.to_path_buf());
    }
    paths.extend(std::env::split_paths(&current));
    std::env::join_paths(paths).ok()
}

async fn run_bridge(
    listener: TcpListener,
    token: String,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    mut child: Child,
    app: Option<AppHandle>,
    mut shutdown_rx: oneshot::Receiver<()>,
    intentional: Arc<AtomicBool>,
) -> Result<(), String> {
    let (stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("接受 WebSocket 连接失败: {}", e))?;
    let ws = accept_hdr_async(stream, move |request: &Request, response: Response| {
        authorize(request, response, &token)
    })
    .await
    .map_err(|e| format!("WebSocket 握手失败: {}", e))?;

    let (mut ws_tx, mut ws_rx) = ws.split();
    let mut stdin = stdin;
    let mut stdout = BufReader::new(stdout);

    let log_app = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(app) = &log_app {
                let _ = app.emit("lsp:log", line);
            } else {
                eprintln!("[clangd] {}", line);
            }
        }
    });

    let stop_reason: String;
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                stop_reason = "LSP 已主动停止".to_string();
                break;
            }
            status = child.wait() => {
                stop_reason = match status {
                    Ok(status) => format!("clangd 已退出: {}", status),
                    Err(err) => format!("等待 clangd 退出失败: {}", err),
                };
                break;
            }
            incoming = ws_rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        write_lsp(&mut stdin, text.as_str()).await?;
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws_tx.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        stop_reason = "WebSocket 已断开".to_string();
                        break;
                    }
                    Some(Err(err)) => return Err(format!("WebSocket 读取失败: {}", err)),
                    _ => {}
                }
            }
            outgoing = read_lsp(&mut stdout) => {
                match outgoing {
                    Ok(Some(body)) => {
                        ws_tx
                            .send(Message::text(body))
                            .await
                            .map_err(|e| format!("发送 WebSocket 消息失败: {}", e))?;
                    }
                    Ok(None) => {
                        stop_reason = "clangd 输出已关闭".to_string();
                        break;
                    }
                    Err(err) => return Err(err),
                }
            }
        }
    }

    let _ = child.kill().await;
    let intentional = intentional.load(Ordering::SeqCst);
    if let Some(app) = &app {
        let _ = app.emit(
            "lsp:stopped",
            LspStopped {
                intentional,
                reason: stop_reason,
            },
        );
    }
    Ok(())
}

fn authorize(
    request: &Request,
    response: Response,
    token: &str,
) -> Result<Response, ErrorResponse> {
    let expected = format!("token={}", token);
    let authorized = request
        .uri()
        .query()
        .map(|query| query.split('&').any(|part| part == expected))
        .unwrap_or(false);
    if authorized {
        Ok(response)
    } else {
        Err(ErrorResponse::new(Some("unauthorized".to_string())))
    }
}

async fn read_lsp(reader: &mut BufReader<ChildStdout>) -> Result<Option<String>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("读取 clangd 输出失败: {}", e))?;
        if read == 0 {
            return Ok(None);
        }
        let line = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "clangd 返回了非法 Content-Length".to_string())?,
            );
        }
    }

    let length = content_length.ok_or_else(|| "clangd 消息缺少 Content-Length".to_string())?;
    if length > 64 * 1024 * 1024 {
        return Err("clangd 消息超过 64 MB 上限".to_string());
    }
    let mut buffer = vec![0u8; length];
    reader
        .read_exact(&mut buffer)
        .await
        .map_err(|e| format!("读取 clangd 消息失败: {}", e))?;
    String::from_utf8(buffer)
        .map(Some)
        .map_err(|e| format!("clangd 消息不是 UTF-8: {}", e))
}

async fn write_lsp(stdin: &mut ChildStdin, body: &str) -> Result<(), String> {
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("写入 clangd stdin 失败: {}", e))?;
    stdin
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("写入 clangd stdin 失败: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("刷新 clangd stdin 失败: {}", e))?;
    Ok(())
}

#[cfg(windows)]
fn apply_window_chrome(window: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_ROUND,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let corner = DWMWCP_ROUND;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&corner) as u32,
        )
    };
    let border: u32 = 0xFFFF_FFFE;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &border as *const _ as *const std::ffi::c_void,
            4,
        )
    };
}

#[tauri::command]
fn apply_window_chrome_command(app: AppHandle) {
    #[cfg(windows)]
    if let Some(window) = app.get_webview_window("main") {
        apply_window_chrome(&window);
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // The HWND is not fully realized during setup; re-apply DWM
                // attributes during the first second until the window is shown.
                for _ in 0..5 {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    if let Some(window) = handle.get_webview_window("main") {
                        #[cfg(windows)]
                        apply_window_chrome(&window);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            list_dir,
            list_files,
            read_text_file,
            save_text_file,
            create_file,
            create_directory,
            rename_path,
            delete_path,
            search_workspace,
            watch_workspace,
            unwatch_workspace,
            load_settings,
            save_settings,
            detect_toolchain,
            example_workspace,
            cmake_example_workspace,
            start_lsp,
            stop_lsp,
            start_dap,
            stop_dap,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
            build_and_run,
            build_and_run_stream,
            cancel_build,
            apply_window_chrome_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio_tungstenite::connect_async;

    fn example_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri parent")
            .join("examples/hello")
    }

    fn test_file_uri(path: &Path) -> String {
        format!(
            "file:///{}",
            path.display().to_string().replace('\\', "/")
        )
    }

    #[tokio::test]
    async fn build_and_run_example() {
        if find_gxx().is_none() {
            eprintln!("skipping build test: g++ not found");
            return;
        }
        let root = example_root();
        let file = root.join("main.cpp");
        let result = build_and_run(
            root.display().to_string(),
            file.display().to_string(),
            None,
            None,
            None,
        )
        .await
        .expect("build_and_run should not fail at the command boundary");

        assert!(result.success, "build failed:\n{}", result.output);
        assert!(
            result.output.contains("Hello from DevCpp++"),
            "program output missing:\n{}",
            result.output
        );
        assert_eq!(result.exit_code, 0);
    }

    #[tokio::test]
    async fn build_and_run_in_chinese_path() {
        if find_gxx().is_none() {
            eprintln!("skipping chinese path test: g++ not found");
            return;
        }
        let base = std::env::temp_dir().join(format!(
            "devcpp-测试-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&base).expect("create chinese temp dir");
        std::fs::copy(example_root().join("main.cpp"), base.join("main.cpp"))
            .expect("copy main.cpp");
        std::fs::copy(example_root().join("math.h"), base.join("math.h"))
            .expect("copy math.h");

        let result = build_and_run(
            base.display().to_string(),
            base.join("main.cpp").display().to_string(),
            None,
            None,
            None,
        )
        .await
        .expect("build_and_run in chinese path");

        assert!(result.success, "build failed:\n{}", result.output);
        assert!(
            result.output.contains("Hello from DevCpp++"),
            "program output missing:\n{}",
            result.output
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn build_and_run_with_stdin() {
        if find_gxx().is_none() {
            eprintln!("skipping stdin test: g++ not found");
            return;
        }
        let base = std::env::temp_dir().join(format!(
            "devcpp-stdin-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&base).expect("create stdin temp dir");
        std::fs::write(
            base.join("main.cpp"),
            r#"#include <iostream>
int main() {
    int value = 0;
    if (std::cin >> value) {
        std::cout << (value * 2) << "\n";
    }
    return 0;
}
"#,
        )
        .expect("write stdin program");

        let result = build_and_run(
            base.display().to_string(),
            base.join("main.cpp").display().to_string(),
            Some("21\n".to_string()),
            None,
            None,
        )
        .await
        .expect("build_and_run with stdin");

        assert!(result.success, "build failed:\n{}", result.output);
        assert!(
            result.output.contains("42"),
            "stdin was not forwarded:\n{}",
            result.output
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn build_and_run_cmake_example() {
        if find_gxx().is_none() || find_cmake().is_none() || find_ninja().is_none() {
            eprintln!("skipping CMake test: g++/cmake/ninja not found");
            return;
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri parent")
            .join("examples/cmake-hello");
        let result = build_and_run(
            root.display().to_string(),
            root.join("src/main.cpp").display().to_string(),
            None,
            None,
            None,
        )
        .await
        .expect("build_and_run CMake example");

        assert!(result.success, "CMake build failed:
{}", result.output);
        assert!(
            result.output.contains("Hello from CMake"),
            "CMake program output missing:
{}",
            result.output
        );
        assert!(
            cmake_build_dir(&root).join("compile_commands.json").is_file(),
            "CMake did not generate compile_commands.json"
        );
        assert_eq!(
            compile_commands_dir(&root),
            Some(cmake_build_dir(&root)),
            "compile_commands_dir should point at the CMake build directory"
        );
    }

    #[test]
    fn rename_rejects_moving_folder_into_its_child() {
        let base = std::env::temp_dir().join(format!(
            "devcpp-move-check-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(base.join("a").join("b")).expect("create nested dirs");
        let root = base.display().to_string();
        let error = rename_path(
            root,
            base.join("a").display().to_string(),
            base.join("a").join("b").join("a").display().to_string(),
        )
        .expect_err("moving a folder into its child must fail");
        assert!(error.contains("自身"), "unexpected error: {error}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn file_operations_stay_inside_workspace() {
        let base = std::env::temp_dir().join(format!(
            "devcpp-fileops-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&base).expect("create temp workspace");
        let root = base.display().to_string();

        create_file(root.clone(), base.join("main.cpp").display().to_string())
            .expect("create file");
        create_directory(root.clone(), base.join("src").display().to_string())
            .expect("create directory");
        assert!(base.join("main.cpp").is_file());
        assert!(base.join("src").is_dir());

        let files = list_files(root.clone()).expect("list files");
        assert!(files.iter().any(|entry| entry.name == "main.cpp"));

        rename_path(
            root.clone(),
            base.join("main.cpp").display().to_string(),
            base.join("app.cpp").display().to_string(),
        )
        .expect("rename file");
        assert!(base.join("app.cpp").is_file());

        delete_path(
            root.clone(),
            base.join("app.cpp").display().to_string(),
            true,
        )
        .expect("delete file");
        assert!(!base.join("app.cpp").exists());

        let outside = std::env::temp_dir().join("devcpp-outside.txt");
        assert!(create_file(root, outside.display().to_string()).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn search_workspace_finds_chinese_and_ascii() {
        let base = std::env::temp_dir().join(format!(
            "devcpp-search-{}",
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&base).expect("create temp workspace");
        std::fs::write(
            base.join("main.cpp"),
            "// 你好，世界\nint main() { return 42; }\n",
        )
        .expect("write search fixture");
        let matches = search_workspace_blocking(
            base.display().to_string(),
            "你好".to_string(),
            Some(10),
        )
        .expect("search workspace");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 1);
        assert_eq!(matches[0].character, 4);

        let matches = search_workspace_blocking(
            base.display().to_string(),
            "return 42".to_string(),
            Some(10),
        )
        .expect("search ascii");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 2);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn build_diagnostic_parser_handles_windows_paths() {
        let root = PathBuf::from(r"D:\work\hello");
        let text = r"D:\work\hello\main.cpp:12:5: error: expected ';' before '}'
D:\work\hello\main.cpp:20:1: warning: unused variable 'x'
";
        let diagnostics = parse_build_diagnostics(text, &root);
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].line, 12);
        assert_eq!(diagnostics[0].character, 5);
        assert_eq!(diagnostics[0].severity, "error");
        assert_eq!(diagnostics[1].severity, "warning");
    }

    #[tokio::test]
    async fn lsp_bridge_initializes_and_publishes_diagnostics() {
        if find_clangd().is_none() || find_gxx().is_none() {
            eprintln!("skipping LSP test: clangd/g++ not found");
            return;
        }
        let root = example_root();
        let (info, handle) = start_lsp_session(&root, None)
            .await
            .expect("start LSP session");

        let (mut ws, _) = connect_async(format!(
            "ws://127.0.0.1:{}/lsp?token={}",
            info.port, info.token
        ))
        .await
        .expect("connect to LSP websocket");

        let root_uri = test_file_uri(&root);
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": null,
                "clientInfo": { "name": "DevCpp++ test", "version": "0.1.0" },
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "hello" }],
                "capabilities": {
                    "general": { "positionEncodings": ["utf-16"] },
                    "textDocument": {
                        "synchronization": { "didSave": true },
                        "completion": {},
                        "hover": {},
                        "definition": {}
                    }
                },
                "initializationOptions": { "clangdFileStatus": true }
            }
        });
        ws.send(Message::text(initialize.to_string()))
            .await
            .expect("send initialize");

        let mut initialized = false;
        for _ in 0..20 {
            let message = tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .expect("initialize timeout")
                .expect("websocket closed")
                .expect("websocket error");
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if value.get("id") == Some(&json!(1)) {
                    assert!(
                        value.get("result").is_some(),
                        "initialize returned an error: {}",
                        value
                    );
                    initialized = true;
                    break;
                }
            }
        }
        assert!(initialized, "did not receive initialize response");

        ws.send(Message::text(
            json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} })
                .to_string(),
        ))
        .await
        .expect("send initialized");

        let source = std::fs::read_to_string(root.join("main.cpp")).unwrap();
        let file_uri = test_file_uri(&root.join("main.cpp"));
        ws.send(Message::text(
            json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {
                        "uri": file_uri.clone(),
                        "languageId": "cpp",
                        "version": 1,
                        "text": source
                    }
                }
            })
            .to_string(),
        ))
        .await
        .expect("send didOpen");

        let mut got_diagnostics = false;
        for _ in 0..60 {
            let message = tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .expect("diagnostics timeout")
                .expect("websocket closed")
                .expect("websocket error");
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if value.get("method")
                    == Some(&json!("textDocument/publishDiagnostics"))
                {
                    got_diagnostics = true;
                    break;
                }
            }
        }
        assert!(got_diagnostics, "did not receive publishDiagnostics");

        tokio::time::sleep(Duration::from_secs(2)).await;

        ws.send(Message::text(
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "textDocument/completion",
                "params": {
                    "textDocument": { "uri": file_uri.clone() },
                    "position": { "line": 9, "character": 10 }
                }
            })
            .to_string(),
        ))
        .await
        .expect("send completion request");

        let mut labels: Vec<String> = Vec::new();
        for _ in 0..60 {
            let message = tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .expect("completion timeout")
                .expect("websocket closed")
                .expect("websocket error");
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if value.get("id") != Some(&json!(2)) {
                    continue;
                }
                let result = value.get("result").expect("completion result");
                let items = result
                    .as_array()
                    .or_else(|| result.get("items").and_then(|v| v.as_array()))
                    .cloned()
                    .unwrap_or_default();
                labels = items
                    .iter()
                    .filter_map(|item| item.get("label").and_then(|v| v.as_str()))
                    .map(|label| label.to_string())
                    .collect();
                break;
            }
        }
        assert!(
            labels.iter().any(|label| {
                label.contains("vector") || label.contains("size") || label.contains("string")
            }),
            "unexpected completion labels: {:?}",
            labels
        );

        for (id, method, params) in [
            (
                3,
                "textDocument/formatting",
                json!({
                    "textDocument": { "uri": file_uri.clone() },
                    "options": { "tabSize": 4, "insertSpaces": true }
                }),
            ),
            (
                4,
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": file_uri.clone() } }),
            ),
            (
                5,
                "textDocument/foldingRange",
                json!({ "textDocument": { "uri": file_uri.clone() } }),
            ),
        ] {
            ws.send(Message::text(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params
                })
                .to_string(),
            ))
            .await
            .expect("send LSP feature request");

            let mut result: Option<Value> = None;
            for _ in 0..60 {
                let message = tokio::time::timeout(Duration::from_secs(10), ws.next())
                    .await
                    .expect("LSP feature timeout")
                    .expect("websocket closed")
                    .expect("websocket error");
                if let Message::Text(text) = message {
                    let value: Value = serde_json::from_str(text.as_str()).unwrap();
                    if value.get("id") == Some(&json!(id)) {
                        result = value.get("result").cloned();
                        break;
                    }
                }
            }
            let result = result.unwrap_or_else(|| panic!("missing result for {}", method));
            assert!(
                result.is_array(),
                "expected array result for {}, got {}",
                method,
                result
            );
        }

        let _ = handle.shutdown.send(());
    }
}
