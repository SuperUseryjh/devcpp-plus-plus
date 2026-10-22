# DevCpp++

轻量化、现代化、Windows 优先的 C++ IDE（P0 原型）。

技术栈：**Tauri 2 + React + Monaco Editor + clangd + GCC (MinGW-w64)**

> 当前状态：P0 最小闭环已跑通。编辑、clangd 诊断/补全、g++ 编译运行、中文路径构建均已验证。
> 完整计划见 [`PLAN.md`](./PLAN.md)，实测记录见 [`docs/P0_REPORT.md`](./docs/P0_REPORT.md)。

## 已实现（P0）

- Tauri 桌面窗口 + React 布局 + Monaco C++ 编辑器
- 打开文件夹 / 文件树 / 多标签页 / 保存 / 最近工作区
- 工作区扫描 + 自动生成 `.devcpp/compile_commands.json`
- clangd 20.1.8 LSP over loopback WebSocket
  - 诊断（Problems + Monaco markers）
  - 补全、悬停、跳转定义
- g++ 单文件编译 + 运行；CMake 项目配置/构建/运行
- 输出面板显示 stdout/stderr
- 标准输入文本框（运行前写入 stdin）
- 格式化（clangd）、引用查找、文档符号/面包屑、代码折叠
- 工具链检测（g++ / gdb / clangd / cmake / ninja 版本）
- 编码检测（UTF-8 / UTF-16 BOM / GBK 回退）
- 中文路径构建：原生路径分隔符 + ASCII 构建目录
- `F11` 编译运行，`Ctrl+S` 保存
- 可选的“打开示例”/“CMake 示例”按钮（`examples/hello`、`examples/cmake-hello`）

## 快速开始（Windows）

前置：

- Node.js 22+
- Rust stable（MSVC toolchain）
- Visual Studio 2022 + “使用 C++ 的桌面开发”
- WebView2 Runtime（Win10/11 通常已安装）
- MinGW-w64 GCC/G++ 在 `PATH` 中（本机为 MSYS2 UCRT64）
- clangd 20+（推荐 20.1.8；不要用 clangd 10，会与 GCC 13 的 libstdc++ 不兼容）
- CMake 4.x + Ninja（由脚本下载到 `tools/`，也可使用系统安装）

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts\fetch-toolchain.ps1
npm run tauri dev
```

`tauri dev` 会在开发模式下自动打开 `examples/hello` 示例，便于验证闭环。

构建可执行文件：

```powershell
npm run tauri build -- --debug --no-bundle
.\src-tauri\target\debug\devcpp-plus-plus.exe
```

## 验证

```powershell
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
```

Rust 测试覆盖：

- g++ 编译 + 运行（ASCII 路径）
- g++ 编译 + 运行（中文路径）
- stdin 转发
- CMake 配置 / 构建 / 运行
- clangd LSP initialize / diagnostics / completion / formatting / symbols
- CMake 配置 / 构建 / 运行

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `F11` | 编译并运行当前文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Space` | 触发补全（由 Monaco/clangd 提供） |
| `Ctrl+W` | 关闭当前标签页 |
| `Shift+Alt+F` | 格式化当前文件 |
| `F12` | 跳转定义（Monaco 默认） |
| `Shift+F12` | 查找引用 |

## 目录

```text
src/                 React + Monaco 前端
src/lsp/             轻量 LSP 客户端（vscode-jsonrpc/browser）
src-tauri/           Rust 后端（Tauri commands、clangd 桥、构建运行）
src-tauri/app.manifest  Windows 清单（Common Controls v6 / DPI / long path）
examples/hello/      示例 C++ 单文件项目
examples/cmake-hello/ CMake 示例项目
scripts/             clangd 下载、开发、检查脚本
docs/P0_REPORT.md    P0 实测报告
PLAN.md              项目计划书
tools/clangd/        本地 clangd（git 忽略，由脚本下载）
tools/cmake/         本地 CMake（git 忽略）
tools/ninja/         本地 Ninja（git 忽略）
```

## 已知限制（P0）

- 没有调试器、集成终端、Git、设置 UI、搜索、重命名/代码操作
- CMake 模式为基础实现：单 target、自动选择一个 exe；多 target/运行目标选择后续完善
- Monaco 目前全量引入，前端产物约 4 MB gzip 1.1 MB，后续按需裁剪
- clangd 使用 `--background-index`，大项目索引会占用 CPU/内存
- 中文输入法（IME）组合输入仍需人工回归测试
- 安装包/签名/自动更新尚未接入

## 文档

- [项目计划书](./PLAN.md)
- [P0 实测报告](./docs/P0_REPORT.md)
