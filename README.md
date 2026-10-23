# DevCpp++

轻量化、现代化、Windows 优先的 C++ IDE（MVP 硬化版）。

技术栈：**Tauri 2 + React + Monaco Editor + clangd + GCC (MinGW-w64)**

> 当前状态：MVP 硬化收尾；品牌图标、无边框窗口、clangd 自恢复、流式构建/取消、首次引导与工作区信任已接入。
> 完整计划见 [`PLAN.md`](./PLAN.md)。

## 已实现（P0 + M1/M2/P1 部分）

- 原创 D++ Logo 与全套应用图标（标题栏 / exe / NSIS）
- 无边框一体化窗口 + 自定义标题栏，Windows 11 圆角，保留拖动/缩放/Snap/最小化/最大化/关闭
- 关闭未保存文件时弹确认
- VS Code 风格布局：菜单栏、活动栏、资源管理器、标签页/面包屑、命令面板、底部面板、状态栏
- Tauri 桌面窗口 + React + Monaco C++ 编辑器
- CMakeLists.txt 使用独立 CMake 语法高亮，不会发送给 clangd 检查
- 打开文件夹 / 文件树 / 多标签页 / 保存 / 最近工作区 / 新建控制台项目向导
- 新建文件/文件夹、重命名、拖拽移动到文件夹/工作区根目录、移入回收站；外部文件变更自动刷新/重载
- 设置界面与持久化（字体、Tab、Minimap、自动换行、g++ 参数、静态运行库、外部控制台）
- 首次启动工具链引导；工作区信任与受限模式
- 工作区扫描 + 自动生成 `.devcpp/compile_commands.json`
- clangd 20.1.8 LSP over loopback WebSocket
  - 诊断（Problems + Monaco markers）
  - 补全、悬停、跳转定义
  - 引用、文档符号、格式化、折叠
  - 重命名、代码操作/快速修复、签名帮助、文档高亮
  - 工作区符号（Ctrl+T）
  - clangd 语义高亮（semantic tokens）
  - 编辑时实时 `didChange` 同步与诊断（独立 LSP 版本号）
- g++ 单文件编译 + 运行；CMake 项目配置/构建/运行
- 构建输出流式显示；可取消构建并回收进程树
- 输出面板显示 stdout/stderr；GCC/CMake 错误解析到 Problems
- 外部控制台运行选项
- 工作区文本搜索（中文/大小写不敏感）
- 快速打开文件（Ctrl+P）
- clangd 崩溃自动恢复（退避 + 上限）与手动重启
- 标准输入文本框（运行前写入 stdin）
- 格式化（clangd）、引用查找、文档符号/面包屑、代码折叠、代码操作
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

发布安装包（NSIS）：

```powershell
npm run tauri build -- --bundles nsis
# 产物：src-tauri\target\release\bundle\nsis\DevCpp++_0.1.0_x64-setup.exe
```

构建实测：安装包约 **4.9 MiB**，应用 exe 约 **8 MiB**。
安装包不包含 clangd / CMake / Ninja（保持轻量）；最终用户需安装 LLVM/CMake/Ninja，
或把 `tools/` 放到应用目录旁。首次运行下载/内置工具包属于 P1。

## 验证

```powershell
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
```

Rust 测试 **8/8** 通过，覆盖：

- g++ 编译 + 运行（ASCII 路径）
- g++ 编译 + 运行（中文路径）
- stdin 转发
- CMake 配置 / 构建 / 运行
- clangd LSP initialize / diagnostics / completion / formatting / symbols
- 文件创建/重命名/删除与路径边界
- 工作区搜索（中文/ASCII）
- GCC 构建诊断解析

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `F11` | 编译并运行当前文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Space` | 触发补全（由 Monaco/clangd 提供） |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+Shift+P` | 命令面板 |
| `Ctrl+P` | 快速打开文件 |
| `Ctrl+T` | 工作区符号 |
| `F2` | 重命名符号 |
| `Ctrl+.` | 快速修复 |
| `Ctrl+Shift+F` | 工作区搜索 |
| `Ctrl+B` / `Ctrl+J` | 切换侧边栏 / 底部面板 |
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
PLAN.md              项目计划书
tools/clangd/        本地 clangd（git 忽略，由脚本下载）
tools/cmake/         本地 CMake（git 忽略）
tools/ninja/         本地 Ninja（git 忽略）
```

## 已知限制

- 没有调试器、集成终端、Git
- CMake 模式为基础实现：单 target、自动选择一个 exe；多 target/运行目标选择后续完善
- 英文 UI、自动更新尚未完成
- 文件树拖拽移动已支持（拖到文件夹或工作区根路径）
- Monaco 目前全量引入，前端产物约 4 MB gzip 1.1 MB，后续按需裁剪
- clangd 使用 `--background-index`，大项目索引会占用 CPU/内存
- 中文输入法（IME）组合输入仍需人工回归测试
- 代码签名/自动更新尚未接入

## 文档

- [项目计划书](./PLAN.md)
