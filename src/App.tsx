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
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Command,
  FileCode2,
  FileText,
  Files,
  Folder,
  FolderOpen,
  Hammer,
  PanelBottom,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { monaco } from "./editor/monaco";
import {
  isLspLanguage,
  languageForPath,
  type EditorLanguage,
} from "./editor/language";
import {
  LspClient,
  normalizePath,
  uriToPath,
  type CompletionItem,
  type Diagnostic,
  type DocumentSymbol,
  type FoldingRange,
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
  language: EditorLanguage;
}

interface ProblemItem {
  uri: string;
  path: string;
  message: string;
  severity: number;
  line: number;
  character: number;
}

type SidebarView = "explorer" | "search" | "problems" | "run" | "settings";
type PanelTab = "problems" | "output";

interface OutlineItem {
  name: string;
  detail?: string;
  kind: number;
  line: number;
  character: number;
  depth: number;
}

interface CommandItem {
  id: string;
  label: string;
  keybinding?: string;
  run: () => void;
}

function flattenSymbols(
  symbols: DocumentSymbol[],
  depth = 0,
): OutlineItem[] {
  return symbols.flatMap((symbol) => [
    {
      name: symbol.name,
      detail: symbol.detail,
      kind: symbol.kind,
      line: symbol.selectionRange.start.line + 1,
      character: symbol.selectionRange.start.character + 1,
      depth,
    },
    ...(symbol.children ? flattenSymbols(symbol.children, depth + 1) : []),
  ]);
}

function languageLabel(language: EditorLanguage): string {
  switch (language) {
    case "cpp":
      return "C++";
    case "c":
      return "C";
    case "cmake":
      return "CMake";
    default:
      return "Plain Text";
  }
}

function fileIcon(name: string): ReactNode {
  const language = languageForPath(name);
  if (language === "cpp" || language === "c") {
    return <FileCode2 size={14} className="icon-cpp" />;
  }
  if (language === "cmake") {
    return <FileText size={14} className="icon-cmake" />;
  }
  return <FileText size={14} className="icon-text" />;
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

const SYMBOL_KINDS: monaco.languages.SymbolKind[] = [
  monaco.languages.SymbolKind.File,
  monaco.languages.SymbolKind.Module,
  monaco.languages.SymbolKind.Namespace,
  monaco.languages.SymbolKind.Package,
  monaco.languages.SymbolKind.Class,
  monaco.languages.SymbolKind.Method,
  monaco.languages.SymbolKind.Property,
  monaco.languages.SymbolKind.Field,
  monaco.languages.SymbolKind.Constructor,
  monaco.languages.SymbolKind.Enum,
  monaco.languages.SymbolKind.Interface,
  monaco.languages.SymbolKind.Function,
  monaco.languages.SymbolKind.Variable,
  monaco.languages.SymbolKind.Constant,
  monaco.languages.SymbolKind.String,
  monaco.languages.SymbolKind.Number,
  monaco.languages.SymbolKind.Boolean,
  monaco.languages.SymbolKind.Array,
  monaco.languages.SymbolKind.Object,
  monaco.languages.SymbolKind.Key,
  monaco.languages.SymbolKind.Null,
  monaco.languages.SymbolKind.EnumMember,
  monaco.languages.SymbolKind.Struct,
  monaco.languages.SymbolKind.Event,
  monaco.languages.SymbolKind.Operator,
  monaco.languages.SymbolKind.TypeParameter,
];

function toMonacoSymbol(
  symbol: DocumentSymbol,
): monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind:
      SYMBOL_KINDS[(symbol.kind ?? 1) - 1] ??
      monaco.languages.SymbolKind.Variable,
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange),
    tags: [],
    children: symbol.children?.map(toMonacoSymbol),
  };
}

function toFoldingRange(range: FoldingRange): monaco.languages.FoldingRange {
  let kind: monaco.languages.FoldingRangeKind | undefined;
  if (range.kind === "comment") {
    kind = monaco.languages.FoldingRangeKind.Comment;
  } else if (range.kind === "imports") {
    kind = monaco.languages.FoldingRangeKind.Imports;
  } else if (range.kind === "region") {
    kind = monaco.languages.FoldingRangeKind.Region;
  }
  return {
    start: range.startLine + 1,
    end: range.endLine + 1,
    kind,
  };
}

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
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [output, setOutput] = useState("// DevCpp++ P0\n// 打开一个文件夹，然后点击 .cpp 文件开始。");
  const [stdinText, setStdinText] = useState("");
  const [problems, setProblems] = useState<ProblemItem[]>([]);
  const [status, setStatus] = useState("就绪");
  const [lspStatus, setLspStatus] = useState("LSP 未连接");
  const [toolchain, setToolchain] = useState<ToolchainInfo | null>(null);
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("devcpp.recent");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const [sidebarView, setSidebarView] = useState<SidebarView>("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [panelVisible, setPanelVisible] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("problems");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);

  const rememberRecent = useCallback((path: string) => {
    setRecent((previous) => {
      const next = [
        path,
        ...previous.filter(
          (item) => normalizePath(item) !== normalizePath(path),
        ),
      ].slice(0, 8);
      try {
        localStorage.setItem("devcpp.recent", JSON.stringify(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }, []);

  const ensureDocumentByPath = useCallback(
    async (path: string): Promise<OpenedDoc | null> => {
      const key = normalizePath(path);
      const existing = docsRef.current.get(key);
      if (existing) return existing;

      try {
        const data = await invoke<FileData>("read_text_file", { path });
        const language = languageForPath(path);
        const uri = monaco.Uri.file(path);
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(data.content, language, uri);
          model.setEOL(
            data.eol === "crlf"
              ? monaco.editor.EndOfLineSequence.CRLF
              : monaco.editor.EndOfLineSequence.LF,
          );
          if (isLspLanguage(language)) {
            lspRef.current?.didOpen(
              model.uri.toString(),
              language,
              model.getValue(monaco.editor.EndOfLinePreference.LF),
            );
          }
        }
        const doc: OpenedDoc = {
          path,
          uri: model.uri.toString(),
          model,
          encoding: data.encoding,
          eol: data.eol,
          language,
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
      setOpenTabs((previous) =>
        previous.some((tab) => normalizePath(tab) === normalizePath(path))
          ? previous
          : [...previous, path],
      );
      setStatus(`打开 ${path}`);
    },
    [ensureDocumentByPath],
  );

  const openProblem = useCallback(
    async (problem: ProblemItem) => {
      await openFile(problem.path);
      editorRef.current?.setPosition({
        lineNumber: problem.line,
        column: problem.character,
      });
      editorRef.current?.revealPositionInCenter({
        lineNumber: problem.line,
        column: problem.character,
      });
    },
    [openFile],
  );

  const closeTab = useCallback(
    (path: string) => {
      const key = normalizePath(path);
      if (
        dirtyPaths.has(key) &&
        !window.confirm("文件未保存，确定关闭？")
      ) {
        return;
      }
      const nextTabs = openTabs.filter(
        (tab) => normalizePath(tab) !== key,
      );
      const closingCurrent =
        currentPath !== null && normalizePath(currentPath) === key;
      const fallback = closingCurrent
        ? nextTabs[nextTabs.length - 1] ?? null
        : null;
      const fallbackDoc = fallback
        ? docsRef.current.get(normalizePath(fallback))
        : null;

      if (closingCurrent) {
        editorRef.current?.setModel(fallbackDoc?.model ?? null);
        setCurrentPath(fallback);
      }

      const doc = docsRef.current.get(key);
      if (doc) {
        lspRef.current?.didClose(doc.uri);
        doc.model.dispose();
        docsRef.current.delete(key);
      }
      setOpenTabs(nextTabs);
      setDirtyPaths((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    },
    [currentPath, dirtyPaths, openTabs],
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
      minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      renderLineHighlight: "all",
      cursorBlinking: "smooth",
      smoothScrolling: true,
      stickyScroll: { enabled: true },
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: true },
      tabSize: 4,
    });
    editorRef.current = editor;

    const cursorSubscription = editor.onDidChangeCursorPosition((event) => {
      setCursor({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });

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

      if (!isLspLanguage(doc.language)) return;
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

    const references = monaco.languages.registerReferenceProvider("cpp", {
      provideReferences: async (model, position, context) => {
        const lsp = lspRef.current;
        if (!lsp) return [];
        try {
          const locations = await lsp.references(
            model.uri.toString(),
            position.lineNumber - 1,
            position.column - 1,
            context.includeDeclaration,
          );
          const resolved: monaco.languages.Location[] = [];
          for (const location of locations) {
            const path = uriToPath(location.uri);
            await ensureDocumentByPath(path);
            resolved.push({
              uri: monaco.Uri.file(path),
              range: toMonacoRange(location.range),
            });
          }
          return resolved;
        } catch (error) {
          console.warn("[lsp] references failed", error);
          return [];
        }
      },
    });

    const formatting =
      monaco.languages.registerDocumentFormattingEditProvider("cpp", {
        provideDocumentFormattingEdits: async (model, options) => {
          const lsp = lspRef.current;
          if (!lsp) return [];
          try {
            const edits = await lsp.formatting(
              model.uri.toString(),
              options.tabSize,
              options.insertSpaces,
            );
            return edits.map((edit) => ({
              range: toMonacoRange(edit.range),
              text: edit.newText,
            }));
          } catch (error) {
            console.warn("[lsp] formatting failed", error);
            return [];
          }
        },
      });

    const documentSymbols =
      monaco.languages.registerDocumentSymbolProvider("cpp", {
        provideDocumentSymbols: async (model) => {
          const lsp = lspRef.current;
          if (!lsp) return [];
          try {
            const symbols = await lsp.documentSymbols(
              model.uri.toString(),
            );
            return symbols.map(toMonacoSymbol);
          } catch (error) {
            console.warn("[lsp] document symbols failed", error);
            return [];
          }
        },
      });

    const foldingRanges = monaco.languages.registerFoldingRangeProvider(
      "cpp",
      {
        provideFoldingRanges: async (model) => {
          const lsp = lspRef.current;
          if (!lsp) return [];
          try {
            const ranges = await lsp.foldingRanges(model.uri.toString());
            return ranges.map(toFoldingRange);
          } catch (error) {
            console.warn("[lsp] folding ranges failed", error);
            return [];
          }
        },
      },
    );

    return () => {
      cursorSubscription.dispose();
      contentSubscription.dispose();
      completions.dispose();
      hovers.dispose();
      definitions.dispose();
      references.dispose();
      formatting.dispose();
      documentSymbols.dispose();
      foldingRanges.dispose();
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

  useEffect(() => {
    let cancelled = false;
    const doc = currentPath
      ? docsRef.current.get(normalizePath(currentPath))
      : undefined;
    if (
      !doc ||
      !isLspLanguage(doc.language) ||
      !lspRef.current
    ) {
      setOutline([]);
      return;
    }
    void lspRef.current
      .documentSymbols(doc.uri)
      .then((symbols) => {
        if (!cancelled) setOutline(flattenSymbols(symbols));
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath, lspStatus]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = () => setMenuOpen(null);
    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [menuOpen]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery, paletteOpen]);

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

  const formatCurrent = useCallback(async () => {
    if (!currentPath) return;
    await editorRef.current
      ?.getAction("editor.action.formatDocument")
      ?.run();
    setStatus("已格式化");
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
        stdin: stdinText,
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
  }, [root, currentPath, saveCurrent, stdinText]);

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && event.shiftKey && key === "p") {
        event.preventDefault();
        setMenuOpen(null);
        setPaletteOpen(true);
        return;
      }
      if (ctrl && event.shiftKey && key === "m") {
        event.preventDefault();
        setSidebarView("problems");
        setSidebarVisible(true);
        setPanelTab("problems");
        setPanelVisible(true);
        return;
      }
      if (ctrl && key === "p" && !event.shiftKey) {
        event.preventDefault();
        setMenuOpen(null);
        setPaletteOpen(true);
        return;
      }
      if (ctrl && key === "b") {
        event.preventDefault();
        setSidebarVisible((visible) => !visible);
        return;
      }
      if (ctrl && key === "j") {
        event.preventDefault();
        setPanelVisible((visible) => !visible);
        return;
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setMenuOpen(null);
        return;
      }
      if (event.key === "F11") {
        event.preventDefault();
        void buildAndRun();
      }
      if (ctrl && key === "s") {
        event.preventDefault();
        void saveCurrent();
      }
      if (ctrl && key === "w" && currentPath) {
        event.preventDefault();
        closeTab(currentPath);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buildAndRun, saveCurrent, currentPath, closeTab]);

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
      rememberRecent(selected);
      setCurrentPath(null);
      setOpenTabs([]);
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
        if (firstCpp) {
          await openFile(firstCpp.path);
        } else {
          const srcDir = rootEntries.find(
            (entry) => entry.isDir && entry.name === "src",
          );
          if (srcDir) {
            const srcEntries = await invoke<FileEntry[]>("list_dir", {
              path: srcDir.path,
            });
            setDirs((previous) => ({
              ...previous,
              [srcDir.path]: srcEntries,
            }));
            setExpanded((previous) => {
              const next = new Set(previous);
              next.add(srcDir.path);
              return next;
            });
            const srcCpp = srcEntries.find(
              (entry) =>
                !entry.isDir &&
                entry.name.toLowerCase().endsWith(".cpp"),
            );
            if (srcCpp) await openFile(srcCpp.path);
          }
        }
      } catch (error) {
        setStatus("打开工作区失败");
        setOutput(String(error));
      }
    },
    [handleDiagnostics, openFile, rememberRecent],
  );

  const openFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "打开 C++ 项目文件夹",
    });
    if (typeof selected === "string") await openWorkspace(selected);
  }, [openWorkspace]);

  const openExampleCommand = useCallback(
    async (command: string, label: string) => {
      try {
        const path = await invoke<string | null>(command);
        if (path) {
          await openWorkspace(path);
        } else {
          setStatus(`未找到 ${label} 示例项目`);
        }
      } catch (error) {
        setStatus("打开示例失败");
        setOutput(String(error));
      }
    },
    [openWorkspace],
  );

  const openExample = useCallback(
    () => openExampleCommand("example_workspace", "examples/hello"),
    [openExampleCommand],
  );

  const openCmakeExample = useCallback(
    () =>
      openExampleCommand(
        "cmake_example_workspace",
        "examples/cmake-hello",
      ),
    [openExampleCommand],
  );

  const refreshRoot = useCallback(async () => {
    if (!root) return;
    try {
      setEntries(await invoke<FileEntry[]>("list_dir", { path: root }));
      setDirs({});
      setExpanded(new Set());
    } catch (error) {
      setOutput(String(error));
    }
  }, [root]);

  const runEditorAction = useCallback((action: string) => {
    editorRef.current?.trigger("menu", action, null);
  }, []);

  const showPanel = useCallback((tab: PanelTab) => {
    setPanelTab(tab);
    setPanelVisible(true);
  }, []);

  const selectView = useCallback(
    (view: SidebarView) => {
      if (sidebarView === view && sidebarVisible) {
        setSidebarVisible(false);
        return;
      }
      setSidebarView(view);
      setSidebarVisible(true);
    },
    [sidebarView, sidebarVisible],
  );

  const showView = useCallback((view: SidebarView) => {
    setSidebarView(view);
    setSidebarVisible(true);
  }, []);

  const about = useCallback(() => {
    setOutput(
      [
        "DevCpp++ 0.1.0 (P0)",
        "",
        "Tauri 2 + React + Monaco Editor + clangd + GCC",
        "计划书: PLAN.md",
        "P0 报告: docs/P0_REPORT.md",
      ].join("\n"),
    );
    showPanel("output");
  }, [showPanel]);

  const commands: CommandItem[] = [
    {
      id: "file.openFolder",
      label: "文件: 打开文件夹...",
      run: () => void openFolder(),
    },
    {
      id: "file.openExample",
      label: "文件: 打开示例项目",
      run: () => void openExample(),
    },
    {
      id: "file.openCmakeExample",
      label: "文件: 打开 CMake 示例项目",
      run: () => void openCmakeExample(),
    },
    {
      id: "file.save",
      label: "文件: 保存",
      keybinding: "Ctrl+S",
      run: () => void saveCurrent(),
    },
    {
      id: "file.close",
      label: "文件: 关闭编辑器",
      keybinding: "Ctrl+W",
      run: () => {
        if (currentPath) closeTab(currentPath);
      },
    },
    {
      id: "edit.undo",
      label: "编辑: 撤销",
      keybinding: "Ctrl+Z",
      run: () => runEditorAction("undo"),
    },
    {
      id: "edit.redo",
      label: "编辑: 重做",
      keybinding: "Ctrl+Y",
      run: () => runEditorAction("redo"),
    },
    {
      id: "edit.find",
      label: "编辑: 查找",
      keybinding: "Ctrl+F",
      run: () => runEditorAction("actions.find"),
    },
    {
      id: "edit.replace",
      label: "编辑: 替换",
      keybinding: "Ctrl+H",
      run: () => runEditorAction("editor.action.startFindReplaceAction"),
    },
    {
      id: "view.explorer",
      label: "查看: 资源管理器",
      keybinding: "Ctrl+B",
      run: () => showView("explorer"),
    },
    {
      id: "view.search",
      label: "查看: 搜索",
      run: () => showView("search"),
    },
    {
      id: "view.problems",
      label: "查看: 问题",
      keybinding: "Ctrl+Shift+M",
      run: () => {
        showView("problems");
        showPanel("problems");
      },
    },
    {
      id: "view.output",
      label: "查看: 输出",
      run: () => showPanel("output"),
    },
    {
      id: "view.palette",
      label: "查看: 命令面板",
      keybinding: "Ctrl+Shift+P",
      run: () => setPaletteOpen(true),
    },
    {
      id: "view.toggleSidebar",
      label: "查看: 切换侧边栏",
      keybinding: "Ctrl+B",
      run: () => setSidebarVisible((visible) => !visible),
    },
    {
      id: "view.togglePanel",
      label: "查看: 切换底部面板",
      keybinding: "Ctrl+J",
      run: () => setPanelVisible((visible) => !visible),
    },
    {
      id: "run.build",
      label: "运行: 编译并运行",
      keybinding: "F11",
      run: () => void buildAndRun(),
    },
    {
      id: "run.format",
      label: "运行: 格式化当前文件",
      keybinding: "Shift+Alt+F",
      run: () => void formatCurrent(),
    },
    {
      id: "help.about",
      label: "帮助: 关于 DevCpp++",
      run: about,
    },
  ];

  const menuDefs: Array<{
    id: string;
    label: string;
    items: string[];
  }> = [
    {
      id: "file",
      label: "文件",
      items: [
        "file.openFolder",
        "file.openExample",
        "file.openCmakeExample",
        "file.save",
        "file.close",
      ],
    },
    {
      id: "edit",
      label: "编辑",
      items: ["edit.undo", "edit.redo", "edit.find", "edit.replace"],
    },
    {
      id: "view",
      label: "查看",
      items: [
        "view.explorer",
        "view.search",
        "view.problems",
        "view.output",
        "view.palette",
        "view.toggleSidebar",
        "view.togglePanel",
      ],
    },
    {
      id: "run",
      label: "运行",
      items: ["run.build", "run.format"],
    },
    {
      id: "help",
      label: "帮助",
      items: ["help.about"],
    },
  ];

  const runCommand = useCallback(
    (id: string) => {
      setMenuOpen(null);
      setPaletteOpen(false);
      commands.find((command) => command.id === id)?.run();
    },
    [commands],
  );

  const normalizedPaletteQuery = paletteQuery.trim().toLowerCase();
  const filteredCommands = normalizedPaletteQuery
    ? commands.filter((command) =>
        command.label.toLowerCase().includes(normalizedPaletteQuery),
      )
    : commands;

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
      const isOpen = expanded.has(item.path);
      return (
        <div key={item.path}>
          <button
            type="button"
            className={`tree-row${isActive ? " active" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={item.path}
            onClick={() =>
              item.isDir ? void toggleDir(item.path) : void openFile(item.path)
            }
          >
            <span className="tree-caret">
              {item.isDir ? (
                isOpen ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : null}
            </span>
            <span className="tree-icon">
              {item.isDir ? (
                isOpen ? (
                  <FolderOpen size={14} className="icon-folder" />
                ) : (
                  <Folder size={14} className="icon-folder" />
                )
              ) : (
                fileIcon(item.name)
              )}
            </span>
            <span className="tree-name">{item.name}</span>
          </button>
          {item.isDir && isOpen && dirs[item.path] ? (
            <div>{renderTree(dirs[item.path], depth + 1)}</div>
          ) : null}
        </div>
      );
    });

  const renderProblemList = (): ReactNode =>
    problems.length === 0 ? (
      <div className="empty">暂无问题</div>
    ) : (
      problems.map((problem) => (
        <button
          key={`${problem.uri}:${problem.line}:${problem.character}:${problem.message}`}
          type="button"
          className="problem-row"
          onClick={() => void openProblem(problem)}
        >
          {problem.severity === 2 ? (
            <TriangleAlert size={14} className="icon-warning" />
          ) : (
            <CircleAlert size={14} className="icon-error" />
          )}
          <span className="problem-message">{problem.message}</span>
          <span className="problem-loc">
            {problem.path.split(/[\\/]/).pop()}:{problem.line}:
            {problem.character}
          </span>
        </button>
      ))
    );

  const renderSidebar = (): ReactNode => {
    if (sidebarView === "search") {
      return (
        <>
          <div className="sidebar-header">
            <span>搜索</span>
          </div>
          <div className="sidebar-body">
            <input
              className="search-input"
              placeholder="搜索（P1 接入）"
              disabled
            />
            <div className="empty">工作区搜索将在 P1 接入。</div>
          </div>
        </>
      );
    }
    if (sidebarView === "problems") {
      return (
        <>
          <div className="sidebar-header">
            <span>问题</span>
            <span className="sidebar-count">{problemCount}</span>
          </div>
          <div className="sidebar-body">{renderProblemList()}</div>
        </>
      );
    }
    if (sidebarView === "run") {
      return (
        <>
          <div className="sidebar-header">
            <span>运行和调试</span>
          </div>
          <div className="sidebar-body run-view">
            <button
              type="button"
              className="side-button primary"
              disabled={!currentPath}
              onClick={() => void buildAndRun()}
            >
              <Play size={15} /> 编译并运行
              <kbd>F11</kbd>
            </button>
            <button
              type="button"
              className="side-button"
              disabled={!currentPath}
              onClick={() => void saveCurrent()}
            >
              <Save size={15} /> 保存
            </button>
            <button
              type="button"
              className="side-button"
              disabled={!currentPath}
              onClick={() => void formatCurrent()}
            >
              <Hammer size={15} /> 格式化
            </button>
            <label className="field-label" htmlFor="run-stdin">
              标准输入
            </label>
            <textarea
              id="run-stdin"
              className="side-stdin"
              value={stdinText}
              onChange={(event) => setStdinText(event.target.value)}
              placeholder="程序运行前写入 stdin"
              spellCheck={false}
            />
            <div className="side-meta">
              {currentPath
                ? currentPath.split(/[\\/]/).pop()
                : "未打开文件"}
            </div>
            <div className="side-note">
              调试器尚未接入；当前支持编译运行与 stdin。
            </div>
          </div>
        </>
      );
    }
    if (sidebarView === "settings") {
      const rows: Array<[string, string | undefined]> = [
        ["g++", toolchain?.gxx],
        ["gdb", toolchain?.gdb],
        ["clangd", toolchain?.clangd],
        ["CMake", toolchain?.cmake],
        ["Ninja", toolchain?.ninja],
      ];
      return (
        <>
          <div className="sidebar-header">
            <span>设置</span>
          </div>
          <div className="sidebar-body settings-view">
            <div className="settings-title">工具链</div>
            {rows.map(([label, value]) => (
              <div className="setting-row" key={label}>
                <span className="setting-label">{label}</span>
                <span className="setting-value" title={value}>
                  {value ?? "未检测到"}
                </span>
              </div>
            ))}
            <div className="side-note">
              运行 <code>scripts/fetch-toolchain.ps1</code> 下载
              clangd/CMake/Ninja，或设置 DEVCPP_* 环境变量。
            </div>
            <div className="settings-title">快捷键</div>
            <div className="setting-row">
              <span className="setting-label">命令面板</span>
              <span className="setting-value">Ctrl+Shift+P</span>
            </div>
            <div className="setting-row">
              <span className="setting-label">编译运行</span>
              <span className="setting-value">F11</span>
            </div>
            <div className="setting-row">
              <span className="setting-label">格式化</span>
              <span className="setting-value">Shift+Alt+F</span>
            </div>
          </div>
        </>
      );
    }
    return (
      <>
        <div className="sidebar-header">
          <span>资源管理器</span>
          <div className="sidebar-actions">
            <button
              type="button"
              className="icon-button"
              title="打开文件夹"
              onClick={() => void openFolder()}
            >
              <FolderOpen size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="刷新"
              onClick={() => void refreshRoot()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
        <div className="sidebar-body">
          {root ? (
            <div className="root-path" title={root}>
              {root}
            </div>
          ) : null}
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
          {root && outline.length > 0 ? (
            <>
              <div className="section-title">大纲</div>
              <div className="outline">
                {outline.map((item, index) => (
                  <button
                    type="button"
                    key={`${item.name}:${item.line}:${index}`}
                    className="outline-item"
                    style={{ paddingLeft: 10 + item.depth * 14 }}
                    onClick={() => {
                      editorRef.current?.setPosition({
                        lineNumber: item.line,
                        column: item.character,
                      });
                      editorRef.current?.revealPositionInCenter({
                        lineNumber: item.line,
                        column: item.character,
                      });
                    }}
                  >
                    <span className="outline-kind">●</span>
                    <span className="outline-name">{item.name}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </>
    );
  };

  const problemCount = problems.length;
  const errorCount = problems.filter((problem) => problem.severity === 1).length;
  const warningCount = problemCount - errorCount;
  const activeDoc = currentPath
    ? docsRef.current.get(normalizePath(currentPath))
    : undefined;
  const activeLanguage = currentPath
    ? languageForPath(currentPath)
    : ("plaintext" as EditorLanguage);
  const activeEncoding = activeDoc?.encoding.toUpperCase() ?? "UTF-8";
  const activeEol = activeDoc?.eol === "crlf" ? "CRLF" : "LF";
  let breadcrumbPath = currentPath ?? "";
  if (
    root &&
    breadcrumbPath.toLowerCase().startsWith(root.toLowerCase())
  ) {
    breadcrumbPath = breadcrumbPath.slice(root.length);
  }
  const breadcrumbParts = breadcrumbPath
    .split(/[\\/]/)
    .filter(Boolean);

  return (
    <div className="app">
      <div
        className="menubar"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="menu-group">
          {menuDefs.map((menu) => (
            <div className="menu" key={menu.id}>
              <button
                type="button"
                className={`menu-button${
                  menuOpen === menu.id ? " active" : ""
                }`}
                onClick={() =>
                  setMenuOpen(menuOpen === menu.id ? null : menu.id)
                }
              >
                {menu.label}
              </button>
              {menuOpen === menu.id ? (
                <div className="menu-dropdown">
                  {menu.items.map((id) => {
                    const command = commands.find((item) => item.id === id);
                    if (!command) return null;
                    return (
                      <button
                        type="button"
                        className="menu-item"
                        key={id}
                        onClick={() => runCommand(id)}
                      >
                        <span>
                          {command.label.replace(/^[^:]+:\s*/, "")}
                        </span>
                        {command.keybinding ? (
                          <span className="menu-shortcut">
                            {command.keybinding}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="command-center"
          onClick={() => {
            setMenuOpen(null);
            setPaletteOpen(true);
          }}
        >
          <Search size={13} />
          <span>搜索或运行命令</span>
          <span className="command-center-hint">Ctrl+Shift+P</span>
        </button>
        <div className="menubar-right">
          <span className="p0-badge">P0</span>
        </div>
      </div>

      <div className="main">
        <nav className="activitybar">
          <button
            type="button"
            className={`activity-item${
              sidebarView === "explorer" && sidebarVisible ? " active" : ""
            }`}
            title="资源管理器"
            onClick={() => selectView("explorer")}
          >
            <Files size={22} />
          </button>
          <button
            type="button"
            className={`activity-item${
              sidebarView === "search" && sidebarVisible ? " active" : ""
            }`}
            title="搜索"
            onClick={() => selectView("search")}
          >
            <Search size={22} />
          </button>
          <button
            type="button"
            className={`activity-item${
              sidebarView === "problems" && sidebarVisible ? " active" : ""
            }`}
            title="问题"
            onClick={() => selectView("problems")}
          >
            <CircleAlert size={22} />
            {problemCount > 0 ? (
              <span className="activity-badge">{problemCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            className={`activity-item${
              sidebarView === "run" && sidebarVisible ? " active" : ""
            }`}
            title="运行和调试"
            onClick={() => selectView("run")}
          >
            <Play size={22} />
          </button>
          <div className="activity-spacer" />
          <button
            type="button"
            className={`activity-item${
              sidebarView === "settings" && sidebarVisible ? " active" : ""
            }`}
            title="设置"
            onClick={() => selectView("settings")}
          >
            <Settings size={22} />
          </button>
        </nav>

        {sidebarVisible ? (
          <aside className="sidebar">{renderSidebar()}</aside>
        ) : null}

        <section className="editor-group">
          <div className="tabbar">
            {openTabs.length === 0 ? (
              <div className="tabbar-empty">无打开的编辑器</div>
            ) : (
              openTabs.map((path) => {
                const active =
                  currentPath !== null &&
                  normalizePath(currentPath) === normalizePath(path);
                const dirty = dirtyPaths.has(normalizePath(path));
                const name = path.split(/[\\/]/).pop() ?? path;
                return (
                  <div
                    key={path}
                    className={`tab${active ? " active" : ""}`}
                    title={path}
                    onClick={() => void openFile(path)}
                  >
                    <span className="tab-icon">{fileIcon(name)}</span>
                    <span className="tab-label">{name}</span>
                    {dirty ? <span className="tab-dirty">●</span> : null}
                    <button
                      type="button"
                      className="tab-close"
                      title="关闭"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(path);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })
            )}
            <div className="tabbar-spacer" />
          </div>

          {breadcrumbParts.length > 0 ? (
            <div className="breadcrumbs">
              {breadcrumbParts.map((part, index) => (
                <span className="breadcrumb" key={`${part}:${index}`}>
                  {index > 0 ? <ChevronRight size={12} /> : null}
                  {index === breadcrumbParts.length - 1 ? (
                    fileIcon(part)
                  ) : (
                    <Folder size={13} />
                  )}
                  <span>{part}</span>
                </span>
              ))}
            </div>
          ) : null}

          <div className="editor-container">
            <div className="editor-host" ref={editorHostRef} />
            {openTabs.length === 0 ? (
              <div className="welcome">
                <div className="welcome-logo">DevCpp++</div>
                <div className="welcome-subtitle">
                  轻量、现代、Windows 优先的 C++ IDE
                </div>
                <div className="welcome-actions">
                  <button
                    type="button"
                    className="welcome-button primary"
                    onClick={() => void openFolder()}
                  >
                    <FolderOpen size={16} /> 打开文件夹
                  </button>
                  <button
                    type="button"
                    className="welcome-button"
                    onClick={() => void openExample()}
                  >
                    <Play size={16} /> 打开示例
                  </button>
                  <button
                    type="button"
                    className="welcome-button"
                    onClick={() => void openCmakeExample()}
                  >
                    <Hammer size={16} /> CMake 示例
                  </button>
                </div>
                {recent.length > 0 ? (
                  <div className="welcome-recent">
                    <div className="welcome-recent-title">最近</div>
                    {recent.map((path) => (
                      <button
                        type="button"
                        className="welcome-recent-row"
                        key={path}
                        title={path}
                        onClick={() => void openWorkspace(path)}
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="welcome-hint">
                  Ctrl+Shift+P 命令面板 · Ctrl+J 切换面板 · F11
                  编译运行
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {panelVisible ? (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-tabs">
              <button
                type="button"
                className={`panel-tab${
                  panelTab === "problems" ? " active" : ""
                }`}
                onClick={() => setPanelTab("problems")}
              >
                问题 <span className="badge">{problemCount}</span>
              </button>
              <button
                type="button"
                className={`panel-tab${
                  panelTab === "output" ? " active" : ""
                }`}
                onClick={() => setPanelTab("output")}
              >
                输出
              </button>
              <button type="button" className="panel-tab" disabled>
                <Terminal size={13} /> 终端
              </button>
              <button type="button" className="panel-tab" disabled>
                调试控制台
              </button>
            </div>
            <div className="panel-actions">
              <button
                type="button"
                className="icon-button panel-action-text"
                title="清空输出"
                onClick={() => setOutput("")}
              >
                清空
              </button>
              <button
                type="button"
                className="icon-button"
                title="关闭面板"
                onClick={() => setPanelVisible(false)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="panel-content">
            {panelTab === "problems" ? (
              renderProblemList()
            ) : (
              <div className="output-wrap">
                <pre className="output" ref={outputRef}>
                  {output}
                </pre>
                <textarea
                  className="stdin-input"
                  value={stdinText}
                  onChange={(event) => setStdinText(event.target.value)}
                  placeholder="标准输入（可选）：程序运行前写入 stdin，例如 21"
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        </section>
      ) : null}

      <footer className="statusbar">
        <button
          type="button"
          className="status-item"
          onClick={() => {
            showView("problems");
            showPanel("problems");
          }}
        >
          <CircleAlert size={13} /> {errorCount}
          <TriangleAlert size={13} /> {warningCount}
        </button>
        <button
          type="button"
          className="status-item"
          onClick={() => showView("run")}
        >
          <Play size={13} /> 运行
        </button>
        <button
          type="button"
          className={`status-item${
            lspStatus.includes("不可用") ? " error" : ""
          }`}
          onClick={() => showView("settings")}
        >
          {lspStatus}
        </button>
        <span className="status-item status-message">{status}</span>
        <span className="status-spacer" />
        <button
          type="button"
          className="status-item"
          title="切换面板"
          onClick={() => setPanelVisible((visible) => !visible)}
        >
          <PanelBottom size={13} />
        </button>
        <span className="status-item">
          Ln {cursor.line}, Col {cursor.column}
        </span>
        <span className="status-item">空格: 4</span>
        <span className="status-item">{activeEncoding}</span>
        <span className="status-item">{activeEol}</span>
        <span className="status-item">
          {languageLabel(activeLanguage)}
        </span>
        <span className="status-item">
          g++ {shortVersion(toolchain?.gxxVersion, "未检测")}
        </span>
      </footer>

      {paletteOpen ? (
        <div
          className="palette-backdrop"
          onMouseDown={() => setPaletteOpen(false)}
        >
          <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
            <div className="palette-input-row">
              <Command size={15} />
              <input
                autoFocus
                value={paletteQuery}
                onChange={(event) => setPaletteQuery(event.target.value)}
                placeholder="输入命令..."
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPaletteOpen(false);
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setPaletteIndex((index) =>
                      Math.min(index + 1, filteredCommands.length - 1),
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setPaletteIndex((index) => Math.max(index - 1, 0));
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const command = filteredCommands[paletteIndex];
                    if (command) runCommand(command.id);
                  }
                }}
              />
            </div>
            <div className="palette-list">
              {filteredCommands.length === 0 ? (
                <div className="empty">没有匹配的命令</div>
              ) : (
                filteredCommands.map((command, index) => (
                  <button
                    type="button"
                    key={command.id}
                    className={`palette-item${
                      index === paletteIndex ? " active" : ""
                    }`}
                    onMouseEnter={() => setPaletteIndex(index)}
                    onClick={() => runCommand(command.id)}
                  >
                    <span>{command.label}</span>
                    {command.keybinding ? (
                      <span className="palette-keybinding">
                        {command.keybinding}
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
