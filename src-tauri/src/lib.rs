use std::{
    collections::hash_map::DefaultHasher,
    ffi::OsString,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::Instant,
};

use encoding_rs::{GBK, UTF_16BE, UTF_16LE, UTF_8};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
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
}

struct LspHandle {
    shutdown: oneshot::Sender<()>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildResult {
    success: bool,
    output: String,
    exit_code: i32,
    executable: Option<String>,
    duration_ms: u64,
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
            ".git" | ".devcpp" | "node_modules" | "target" | "dist"
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
fn detect_toolchain() -> ToolchainInfo {
    let gxx = find_gxx();
    let gdb = find_tool("gdb");
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
        },
    ))
}

#[tauri::command]
async fn stop_lsp(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.lsp.lock().await.take() {
        let _ = handle.shutdown.send(());
    }
    Ok(())
}

#[tauri::command]
async fn build_and_run(
    root: String,
    file: String,
    stdin: Option<String>,
) -> Result<BuildResult, String> {
    let root = normalize_existing_dir(&root)?;
    let file = PathBuf::from(file);
    if !file.is_file() {
        return Err(format!("文件不存在: {}", file.display()));
    }
    if root.join("CMakeLists.txt").is_file() {
        return build_and_run_cmake(&root, stdin).await;
    }
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
        .arg("-std=c++20")
        .arg("-g")
        .arg("-O0")
        .arg("-Wall")
        .arg("-Wextra")
        .arg("-static-libgcc")
        .arg("-static-libstdc++")
        .arg(&file)
        .arg("-o")
        .arg(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C")
        .env("LANG", "C");
    if let Some(path) = path_with_prefix(gxx.parent()) {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let compile = cmd
        .output()
        .await
        .map_err(|e| format!("启动 g++ 失败: {}", e))?;
    let mut output = String::new();
    output.push_str(&format!(
        "> {} -std=c++20 -g -O0 -Wall -Wextra {} -o {}\n",
        gxx.display(),
        file.display(),
        exe.display()
    ));
    output.push_str(&decode_output(&compile.stdout));
    output.push_str(&decode_output(&compile.stderr));

    if !compile.status.success() {
        return Ok(BuildResult {
            success: false,
            output,
            exit_code: compile.status.code().unwrap_or(-1),
            executable: None,
            duration_ms: start.elapsed().as_millis() as u64,
        });
    }

    let executed = run_program(&exe, &root, &gxx, stdin).await?;
    output.push_str("\n--- 程序输出 ---\n");
    output.push_str(&decode_output(&executed.stdout));
    output.push_str(&decode_output(&executed.stderr));

    Ok(BuildResult {
        success: true,
        output,
        exit_code: executed.status.code().unwrap_or(-1),
        executable: Some(exe.display().to_string()),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

async fn run_program(
    exe: &Path,
    root: &Path,
    gxx: &Path,
    stdin: Option<String>,
) -> Result<Output, String> {
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

async fn build_and_run_cmake(
    root: &Path,
    stdin: Option<String>,
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

    let build = cmd
        .output()
        .await
        .map_err(|e| format!("启动 cmake 失败: {}", e))?;
    let mut output = format!("> cmake --build {}\n", build_dir.display());
    output.push_str(&decode_output(&build.stdout));
    output.push_str(&decode_output(&build.stderr));
    if !build.status.success() {
        return Ok(BuildResult {
            success: false,
            output,
            exit_code: build.status.code().unwrap_or(-1),
            executable: None,
            duration_ms: start.elapsed().as_millis() as u64,
        });
    }

    let exe = find_cmake_executable(&build_dir).ok_or_else(|| {
        format!(
            "CMake 构建成功，但未在 {} 找到可执行文件",
            build_dir.display()
        )
    })?;
    let executed = run_program(&exe, root, &gxx, stdin).await?;
    output.push_str("\n--- 程序输出 ---\n");
    output.push_str(&decode_output(&executed.stdout));
    output.push_str(&decode_output(&executed.stderr));

    Ok(BuildResult {
        success: true,
        output,
        exit_code: executed.status.code().unwrap_or(-1),
        executable: Some(exe.display().to_string()),
        duration_ms: start.elapsed().as_millis() as u64,
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
                ".git" | ".devcpp" | "node_modules" | "target" | "dist" | "build"
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

    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(app) = &app {
                let _ = app.emit("lsp:log", line);
            } else {
                eprintln!("[clangd] {}", line);
            }
        }
    });

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            incoming = ws_rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        write_lsp(&mut stdin, text.as_str()).await?;
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws_tx.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
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
                    Ok(None) => break,
                    Err(err) => return Err(err),
                }
            }
        }
    }

    let _ = child.kill().await;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            list_dir,
            read_text_file,
            save_text_file,
            detect_toolchain,
            example_workspace,
            cmake_example_workspace,
            start_lsp,
            stop_lsp,
            build_and_run
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
        let root = example_root();
        let file = root.join("main.cpp");
        let result = build_and_run(
            root.display().to_string(),
            file.display().to_string(),
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
        if find_cmake().is_none() || find_ninja().is_none() {
            eprintln!("skipping CMake test: cmake/ninja not found");
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

    #[tokio::test]
    async fn lsp_bridge_initializes_and_publishes_diagnostics() {
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
