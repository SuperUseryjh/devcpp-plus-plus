import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor/monaco";
import {
  LspClient,
  normalizePath,
  uriToPath,
  type CompletionItem,
  type Diagnostic,
  type Hover,
  type Range,
} from "./lsp/client";
import type {
  BuildResult,
  FileData,
  FileEntry,
  LspInfo,
  ToolchainInfo,
  WorkspaceInfo,
} from "./types";
import "./App.css";

interface OpenedDoc {
  path: string;
  uri: string;
  model: monaco.editor.ITextModel;
  encoding: string;
  eol: string;
}

interface ProblemItem {
  uri: string;
  path: string;
  message: string;
  severity: number;
  line: number;
  character: number;
}

const COMPLETION_KINDS: monaco.languages.CompletionItemKind[] = [
  monaco.languages.CompletionItemKind.Text,
  monaco.languages.CompletionItemKind.Method,
  monaco.languages.CompletionItemKind.Function,
  monaco.languages.CompletionItemKind.Constructor,
  monaco.languages.CompletionItemKind.Field,
  monaco.languages.CompletionItemKind.Variable,
  monaco.languages.CompletionItemKind.Class,
  monaco.languages.CompletionItemKind.Interface,
  monaco.languages.CompletionItemKind.Module,
  monaco.languages.CompletionItemKind.Property,
  monaco.languages.CompletionItemKind.Unit,
  monaco.languages.CompletionItemKind.Value,
  monaco.languages.CompletionItemKind.Enum,
  monaco.languages.CompletionItemKind.Keyword,
  monaco.languages.CompletionItemKind.Snippet,
  monaco.languages.CompletionItemKind.Color,
  monaco.languages.CompletionItemKind.File,
  monaco.languages.CompletionItemKind.Reference,
  monaco.languages.CompletionItemKind.Folder,
  monaco.languages.CompletionItemKind.EnumMember,
  monaco.languages.CompletionItemKind.Constant,
  monaco.languages.CompletionItemKind.Struct,
  monaco.languages.CompletionItemKind.Event,
  monaco.languages.CompletionItemKind.Operator,
  monaco.languages.CompletionItemKind.TypeParameter,
];

function toMonacoRange(range: Range): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function toMarkerSeverity(severity?: number): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

function toMonacoCompletion(
  item: CompletionItem,
  defaultRange: monaco.Range,
): monaco.languages.CompletionItem {
  const edit = item.textEdit;
  const range = edit
    ? "range" in edit
      ? toMonacoRange(edit.range)
      : toMonacoRange(edit.replace)
    : defaultRange;
  const insertText = edit?.newText ?? item.insertText ?? item.label;
  return {
    label: item.label,
    kind:
      COMPLETION_KINDS[(item.kind ?? 1) - 1] ??
      monaco.languages.CompletionItemKind.Text,
    detail: item.detail,
    documentation:
      typeof item.documentation === "string"
        ? item.documentation
        : item.documentation?.value,
    insertText,
    range,
    sortText: item.sortText,
    filterText: item.filterText,
    additionalTextEdits: item.additionalTextEdits?.map((additional) => ({
      range: toMonacoRange(additional.range),
      text: additional.newText,
    })),
    commitCharacters: item.commitCharacters,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    tags: item.deprecated
      ? [monaco.languages.CompletionItemTag.Deprecated]
      : undefined,
  };
}

function shortVersion(version: string | undefined, fallback: string): string {
  if (!version) return fallback;
  const match = version.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : version;
}

function hoverText(contents: Hover["contents"]): string[] {
  if (typeof contents === "string") return [contents];
  if (Array.isArray(contents)) {
    return contents.map((part) =>
      typeof part === "string" ? part : part.value,
    );
  }
  return [contents.value];
}

function App() {
  const editorHostRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const lspRef = useRef<LspClient | null>(null);
  const docsRef = useRef(new Map<string, OpenedDoc>());
  const autoOpenedRef = useRef(false);

  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [output, setOutput] = useState("// DevCpp++ P0\n// 打开一个文件夹，然后点击 .cpp 文件开始。");
  const [problems, setProblems] = useState<ProblemItem[]>([]);
  const [status, setStatus] = useState("就绪");
  const [lspStatus, setLspStatus] = useState("LSP 未连接");
  const [toolchain, setToolchain] = useState<ToolchainInfo | null>(null);

  const ensureDocumentByPath = useCallback(
    async (path: string): Promise<OpenedDoc | null> => {
      const key = normalizePath(path);
      const existing = docsRef.current.get(key);
      if (existing) return existing;

      try {
        const data = await invoke<FileData>("read_text_file", { path });
        const uri = monaco.Uri.file(path);
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(data.content, "cpp", uri);
          model.setEOL(
            data.eol === "crlf"
              ? monaco.editor.EndOfLineSequence.CRLF
              : monaco.editor.EndOfLineSequence.LF,
          );
          lspRef.current?.didOpen(
            model.uri.toString(),
            "cpp",
            model.getValue(monaco.editor.EndOfLinePreference.LF),
          );
        }
        const doc: OpenedDoc = {
          path,
          uri: model.uri.toString(),
          model,
          encoding: data.encoding,
          eol: data.eol,
        };
        docsRef.current.set(key, doc);
        return doc;
      } catch (error) {
        setOutput(String(error));
        setStatus("打开文件失败");
        return null;
      }
    },
    [],
  );

  const openFile = useCallback(
    async (path: string) => {
      const doc = await ensureDocumentByPath(path);
      if (!doc) return;
      editorRef.current?.setModel(doc.model);
      setCurrentPath(path);
      setStatus(`打开 ${path}`);
    },
    [ensureDocumentByPath],
  );

  const handleDiagnostics = useCallback(
    (uri: string, diagnostics: Diagnostic[]) => {
      const path = uriToPath(uri);
      const doc = docsRef.current.get(normalizePath(path));
      if (doc) {
        monaco.editor.setModelMarkers(
          doc.model,
          "clangd",
          diagnostics.map((diagnostic) => ({
            severity: toMarkerSeverity(diagnostic.severity),
            message:
              diagnostic.message +
              (diagnostic.code ? ` [${diagnostic.code}]` : ""),
            startLineNumber: diagnostic.range.start.line + 1,
            startColumn: diagnostic.range.start.character + 1,
            endLineNumber: diagnostic.range.end.line + 1,
            endColumn: diagnostic.range.end.character + 1,
            source: diagnostic.source ?? "clangd",
          })),
        );
      }

      setProblems((previous) => [
        ...previous.filter((item) => item.uri !== uri),
        ...diagnostics.map((diagnostic) => ({
          uri,
          path,
          message: diagnostic.message,
          severity: diagnostic.severity ?? 1,
          line: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1,
        })),
      ]);
    },
    [],
  );

  useEffect(() => {
    if (!editorHostRef.current) return;
    const editor = monaco.editor.create(editorHostRef.current, {
      value: "",
      language: "cpp",
      theme: "vs-dark",
      fontSize: 14,
      fontFamily:
        "Consolas, 'Cascadia Code', 'Microsoft YaHei', monospace",
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      tabSize: 4,
    });
    editorRef.current = editor;

    const contentSubscription = editor.onDidChangeModelContent((event) => {
      const model = editor.getModel();
      if (!model) return;
      const path = uriToPath(model.uri.toString());
      const key = normalizePath(path);
      const doc = docsRef.current.get(key);
      if (!doc) return;

      setDirtyPaths((previous) => {
        const next = new Set(previous);
        next.add(key);
        return next;
      });

      const lsp = lspRef.current;
      if (!lsp) return;
      lsp.didChange(
        doc.uri,
        model.getVersionId(),
        event.changes.map((change) => ({
          range: {
            start: {
              line: change.range.startLineNumber - 1,
              character: change.range.startColumn - 1,
            },
            end: {
              line: change.range.endLineNumber - 1,
              character: change.range.endColumn - 1,
            },
          },
          rangeLength: change.rangeLength,
          text: change.text,
        })),
      );
    });

    const completions =
      monaco.languages.registerCompletionItemProvider("cpp", {
        triggerCharacters: [".", ">", ":", "(", ",", "<"],
        provideCompletionItems: async (model, position) => {
          const lsp = lspRef.current;
          if (!lsp) return { suggestions: [] };
          try {
            const result = await lsp.completion(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
            );
            const items = Array.isArray(result) ? result : result.items;
            const incomplete = Array.isArray(result)
              ? false
              : (result.isIncomplete ?? false);
            const word = model.getWordUntilPosition(position);
            const defaultRange = new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            );
            return {
              suggestions: items.map((item) =>
                toMonacoCompletion(item, defaultRange),
              ),
              incomplete,
            };
          } catch (error) {
            console.warn("[lsp] completion failed", error);
            return { suggestions: [] };
          }
        },
      });

    const hovers = monaco.languages.registerHoverProvider("cpp", {
      provideHover: async (model, position) => {
        const lsp = lspRef.current;
        if (!lsp) return null;
        try {
          const result = await lsp.hover(
            model.uri.toString(),
            position.lineNumber - 1,
            position.column - 1,
          );
          if (!result) return null;
          return {
            contents: hoverText(result.contents).map((value) => ({ value })),
            range: result.range ? toMonacoRange(result.range) : undefined,
          };
        } catch (error) {
          console.warn("[lsp] hover failed", error);
          return null;
        }
      },
    });

    const definitions = monaco.languages.registerDefinitionProvider("cpp", {
      provideDefinition: async (model, position) => {
        const lsp = lspRef.current;
        if (!lsp) return null;
        try {
          const result = await lsp.definition(
            model.uri.toString(),
            position.lineNumber - 1,
            position.column - 1,
          );
          if (!result) return null;
          const locations = Array.isArray(result) ? result : [result];
          const resolved: monaco.languages.Location[] = [];
          for (const location of locations) {
            const uri =
              "uri" in location ? location.uri : location.targetUri;
            const range =
              "range" in location
                ? location.range
                : location.targetSelectionRange;
            const path = uriToPath(uri);
            await ensureDocumentByPath(path);
            resolved.push({
              uri: monaco.Uri.file(path),
              range: toMonacoRange(range),
            });
          }
          return resolved;
        } catch (error) {
          console.warn("[lsp] definition failed", error);
          return null;
        }
      },
    });

    return () => {
      contentSubscription.dispose();
      completions.dispose();
      hovers.dispose();
      definitions.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [ensureDocumentByPath]);

  useEffect(() => {
    const pending = listen<string>("lsp:log", (event) => {
      console.log("[clangd]", event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!currentPath) return false;
    const key = normalizePath(currentPath);
    const doc = docsRef.current.get(key);
    if (!doc) return false;
    try {
      await invoke("save_text_file", {
        path: currentPath,
        content: doc.model.getValue(),
        encoding: doc.encoding,
      });
      setDirtyPaths((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
      setStatus("已保存");
      return true;
    } catch (error) {
      setOutput(String(error));
      setStatus("保存失败");
      return false;
    }
  }, [currentPath]);

  const buildAndRun = useCallback(async () => {
    if (!root || !currentPath) return;
    const saved = await saveCurrent();
    if (!saved) return;
    setOutput("编译中...");
    setStatus("编译中...");
    try {
      const result = await invoke<BuildResult>("build_and_run", {
        root,
        file: currentPath,
      });
      setOutput(result.output || "(无输出)");
      setStatus(
        result.success
          ? `运行结束 · 退出码 ${result.exitCode} · ${result.durationMs} ms`
          : `构建失败 · 退出码 ${result.exitCode}`,
      );
    } catch (error) {
      setOutput(String(error));
      setStatus("构建失败");
    }
  }, [root, currentPath, saveCurrent]);

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F11") {
        event.preventDefault();
        void buildAndRun();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        void saveCurrent();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buildAndRun, saveCurrent]);

  const openWorkspace = useCallback(
    async (selected: string) => {
      editorRef.current?.setModel(null);
      for (const doc of docsRef.current.values()) {
        doc.model.dispose();
      }
      docsRef.current.clear();
      if (lspRef.current) {
        lspRef.current.dispose();
        lspRef.current = null;
        await invoke("stop_lsp");
      }

      setRoot(selected);
      setCurrentPath(null);
      setDirtyPaths(new Set());
      setProblems([]);
      setDirs({});
      setExpanded(new Set());
      setOutput(`工作区: ${selected}`);
      setStatus("正在准备工作区...");

      try {
        const workspace = await invoke<WorkspaceInfo>("open_workspace", {
          root: selected,
        });
        const rootEntries = await invoke<FileEntry[]>("list_dir", {
          path: selected,
        });
        setEntries(rootEntries);
        const detected = await invoke<ToolchainInfo>("detect_toolchain");
        setToolchain(detected);
        setStatus(
          `工作区已打开 · ${workspace.sources} 个 C++ 源文件`,
        );

        try {
          const lspInfo = await invoke<LspInfo>("start_lsp", {
            root: selected,
          });
          const client = await LspClient.connect(lspInfo, selected);
          client.onDiagnostics(handleDiagnostics);
          lspRef.current = client;
          setLspStatus(
            `clangd ${shortVersion(detected.clangdVersion, "已连接")}`,
          );
        } catch (error) {
          setLspStatus("clangd 不可用");
          setOutput(
            `${String(error)}\n\n提示：设置 DEVCPP_CLANGD 或把 clangd.exe 放到 tools/clangd/bin/。`,
          );
        }

        const firstCpp = rootEntries.find(
          (entry) =>
            !entry.isDir && entry.name.toLowerCase().endsWith(".cpp"),
        );
        if (firstCpp) await openFile(firstCpp.path);
      } catch (error) {
        setStatus("打开工作区失败");
        setOutput(String(error));
      }
    },
    [handleDiagnostics, openFile],
  );

  const openFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "打开 C++ 项目文件夹",
    });
    if (typeof selected === "string") await openWorkspace(selected);
  }, [openWorkspace]);

  const openExample = useCallback(async () => {
    try {
      const path = await invoke<string | null>("example_workspace");
      if (path) {
        await openWorkspace(path);
      } else {
        setStatus("未找到 examples/hello 示例项目");
      }
    } catch (error) {
      setStatus("打开示例失败");
      setOutput(String(error));
    }
  }, [openWorkspace]);

  useEffect(() => {
    if (!import.meta.env.DEV || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    void invoke<string | null>("example_workspace").then((path) => {
      if (path) void openWorkspace(path);
    });
  }, [openWorkspace]);

  const toggleDir = useCallback(
    async (path: string) => {
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!dirs[path]) {
        try {
          const children = await invoke<FileEntry[]>("list_dir", {
            path,
          });
          setDirs((previous) => ({ ...previous, [path]: children }));
        } catch (error) {
          setOutput(String(error));
        }
      }
    },
    [dirs],
  );

  const renderTree = (items: FileEntry[], depth = 0): ReactNode =>
    items.map((item) => {
      const isActive =
        currentPath !== null &&
        normalizePath(currentPath) === normalizePath(item.path);
      return (
        <div key={item.path}>
          <button
            type="button"
            className={`tree-row${isActive ? " active" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() =>
              item.isDir ? void toggleDir(item.path) : void openFile(item.path)
            }
          >
            <span className="tree-caret">
              {item.isDir ? (expanded.has(item.path) ? "▾" : "▸") : ""}
            </span>
            <span className="tree-name">{item.name}</span>
          </button>
          {item.isDir &&
          expanded.has(item.path) &&
          dirs[item.path] ? (
            <div>{renderTree(dirs[item.path], depth + 1)}</div>
          ) : null}
        </div>
      );
    });

  const problemCount = problems.length;
  const isDirty =
    currentPath !== null && dirtyPaths.has(normalizePath(currentPath));

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          DevCpp++ <span className="badge">P0</span>
        </div>
        <button type="button" onClick={() => void openFolder()}>
          打开文件夹
        </button>
        <button type="button" onClick={() => void openExample()}>
          打开示例
        </button>
        <button
          type="button"
          disabled={!currentPath}
          onClick={() => void saveCurrent()}
        >
          保存
        </button>
        <button
          type="button"
          className="primary"
          disabled={!currentPath}
          onClick={() => void buildAndRun()}
        >
          编译运行 F11
        </button>
        <div className="toolbar-spacer" />
        <span className={`lsp-pill ${lspStatus.includes("不可用") ? "bad" : ""}`}>
          {lspStatus}
        </span>
        <span className="status-text">{status}</span>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="panel-title">资源管理器</div>
          {root ? <div className="root-path">{root}</div> : null}
          <div className="tree">
            {root ? (
              entries.length > 0 ? (
                renderTree(entries)
              ) : (
                <div className="empty">没有文件</div>
              )
            ) : (
              <div className="empty">打开一个 C++ 项目文件夹</div>
            )}
          </div>
        </aside>

        <main className="editor-pane">
          <div className="tabbar">
            {currentPath ? (
              <span className="tab">
                {currentPath.split(/[\\/]/).pop()}
                {isDirty ? " •" : ""}
              </span>
            ) : (
              <span className="tab muted">未打开文件</span>
            )}
          </div>
          <div className="editor-host" ref={editorHostRef} />
        </main>
      </div>

      <section className="bottom-panel">
        <div className="bottom-column">
          <div className="panel-title">
            问题 <span className="count">{problemCount}</span>
          </div>
          <div className="problems">
            {problems.length === 0 ? (
              <div className="empty">暂无诊断</div>
            ) : (
              problems.map((problem) => (
                <button
                  key={`${problem.uri}:${problem.line}:${problem.character}:${problem.message}`}
                  type="button"
                  className="problem-row"
                  onClick={() => {
                    void openFile(problem.path).then(() => {
                      editorRef.current?.revealPositionInCenter({
                        lineNumber: problem.line,
                        column: problem.character,
                      });
                    });
                  }}
                >
                  <span className={`severity s${problem.severity}`}>
                    {problem.severity === 1 ? "E" : "W"}
                  </span>
                  <span className="problem-message">{problem.message}</span>
                  <span className="problem-loc">
                    {problem.path.split(/[\\/]/).pop()}:{problem.line}:
                    {problem.character}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="bottom-column">
          <div className="panel-title">输出</div>
          <pre className="output" ref={outputRef}>
            {output}
          </pre>
        </div>
      </section>

      <footer className="statusbar">
        <span>g++ {shortVersion(toolchain?.gxxVersion, "未检测")}</span>
        <span>
          clangd {shortVersion(toolchain?.clangdVersion, "未检测")}
        </span>
        <span>{currentPath ?? "未打开文件"}</span>
        <span className="statusbar-spacer" />
        <span>{root ?? "未打开工作区"}</span>
      </footer>
    </div>
  );
}

export default App;
