import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { confirm as confirmDialog, open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Command,
  FileCode2,
  FilePlus,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  Hammer,
  Pencil,
  PanelBottom,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldAlert,
  Terminal,
  Trash2,
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
  type CodeAction,
  type CompletionItem,
  type Diagnostic,
  type DocumentSymbol,
  type FoldingRange,
  type Hover,
  type Range,
  type SymbolInformation,
  type TextEdit,
  type WorkspaceEdit,
  type WorkspaceSymbol,
} from "./lsp/client";
import type {
  AppSettings,
  BuildEvent,
  BuildResult,
  FileChangeEvent,
  FileData,
  FileEntry,
  LspInfo,
  LspStopped,
  SearchMatch,
  ToolchainInfo,
  WorkspaceInfo,
} from "./types";
import "./App.css";

interface OpenedDoc {
  path: string;
  uri: string;
  version: number;
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
  source: "clangd" | "build";
}

type SidebarView = "explorer" | "search" | "problems" | "run" | "settings";
type PanelTab = "problems" | "output";
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const RESIZE_HANDLES: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "North", className: "north" },
  { direction: "South", className: "south" },
  { direction: "East", className: "east" },
  { direction: "West", className: "west" },
  { direction: "NorthEast", className: "north-east" },
  { direction: "NorthWest", className: "north-west" },
  { direction: "SouthEast", className: "south-east" },
  { direction: "SouthWest", className: "south-west" },
];

type PaletteMode = "commands" | "files" | "symbols";

interface TreeContextMenu {
  path: string;
  isDir: boolean;
  x: number;
  y: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  editor: {
    fontSize: 14,
    tabSize: 4,
    minimap: true,
    wordWrap: false,
  },
  build: {
    cxxFlags: ["-std=c++20", "-g", "-O0", "-Wall", "-Wextra"],
    staticRuntime: true,
    externalConsole: false,
  },
  trustedWorkspaces: [],
  onboardingCompleted: false,
};

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

function relativeToRoot(path: string, root: string | null): string {
  if (!root) return path;
  const normalizedRoot = root.replace(/[\\/]+$/, "").toLowerCase();
  if (path.toLowerCase().startsWith(normalizedRoot)) {
    return path.slice(normalizedRoot.length).replace(/^[\\/]+/, "");
  }
  return path;
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

function fromMarkerSeverity(severity: monaco.MarkerSeverity): number {
  switch (severity) {
    case monaco.MarkerSeverity.Error:
      return 1;
    case monaco.MarkerSeverity.Warning:
      return 2;
    case monaco.MarkerSeverity.Info:
      return 3;
    default:
      return 4;
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
  const rootRef = useRef<string | null>(null);
  const currentPathRef = useRef<string | null>(null);
  const openTabsRef = useRef<string[]>([]);
  const dirsRef = useRef<Record<string, FileEntry[]>>({});
  const dirtyPathsRef = useRef<Set<string>>(new Set());
  const externalReloadRef = useRef<Set<string>>(new Set());
  const dragEntryRef = useRef<FileEntry | null>(null);
  const buildOutputBufferRef = useRef("");
  const buildOutputTimerRef = useRef<number | null>(null);
  const titlebarDragTimerRef = useRef<number | null>(null);
  const allowCloseRef = useRef(false);
  const lspRestartTimerRef = useRef<number | null>(null);
  const lspRestartingRef = useRef(false);
  const lspCrashTimesRef = useRef<number[]>([]);
  const scheduleRestartRef = useRef<(reason: string) => void>(() => undefined);

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
  const [buildProblems, setBuildProblems] = useState<ProblemItem[]>([]);
  const [building, setBuilding] = useState(false);
  const [workspaceTrusted, setWorkspaceTrusted] = useState(true);
  const [status, setStatus] = useState("就绪");
  const [lspStatus, setLspStatus] = useState("LSP 未连接");
  const [toolchain, setToolchain] = useState<ToolchainInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [treeMenu, setTreeMenu] = useState<TreeContextMenu | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState<{
    title: string;
    value: string;
    confirm: (value: string) => void;
  } | null>(null);
  const [textPromptValue, setTextPromptValue] = useState("");
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
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("commands");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [symbolResults, setSymbolResults] = useState<
    Array<SymbolInformation | WorkspaceSymbol>
  >([]);
  const [isMaximized, setIsMaximized] = useState(false);
  const [windowFocused, setWindowFocused] = useState(true);

  useEffect(() => {
    void invoke("apply_window_chrome_command").catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow
      .isMaximized()
      .then((maximized) => {
        if (active) setIsMaximized(maximized);
      })
      .catch(() => undefined);
    void appWindow
      .onResized(async () => {
        try {
          const maximized = await appWindow.isMaximized();
          if (active) setIsMaximized(maximized);
        } catch {
          // ignore window state errors
        }
      })
      .then((unlisten) => {
        if (active) unlistenResize = unlisten;
        else unlisten();
      });
    void appWindow
      .onFocusChanged(({ payload }) => {
        if (active) setWindowFocused(payload);
      })
      .then((unlisten) => {
        if (active) unlistenFocus = unlisten;
        else unlisten();
      });
    return () => {
      active = false;
      unlistenResize?.();
      unlistenFocus?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (allowCloseRef.current || dirtyPathsRef.current.size === 0) return;
        event.preventDefault();
        const close = await confirmDialog(
          "有未保存的文件，确定关闭 DevCpp++ 吗？",
          {
            title: "未保存的文件",
            kind: "warning",
            okLabel: "关闭",
            cancelLabel: "取消",
          },
        );
        if (close) {
          allowCloseRef.current = true;
          await getCurrentWindow().close();
        }
      })
      .then((dispose) => {
        if (active) unlisten = dispose;
        else dispose();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const current = currentPath?.split(/[\\/]/).pop();
    const workspace = root?.split(/[\\/]/).filter(Boolean).pop();
    const title = current
      ? current + " — DevCpp++"
      : workspace
        ? workspace + " — DevCpp++"
        : "DevCpp++";
    void getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [currentPath, root]);

  useEffect(() => {
    rootRef.current = root;
  }, [root]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    dirsRef.current = dirs;
  }, [dirs]);

  useEffect(() => {
    dirtyPathsRef.current = dirtyPaths;
  }, [dirtyPaths]);

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
          version: 1,
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

  const openSearchResult = useCallback(
    async (match: SearchMatch) => {
      await openFile(match.path);
      editorRef.current?.setPosition({
        lineNumber: match.line,
        column: match.character,
      });
      editorRef.current?.revealPositionInCenter({
        lineNumber: match.line,
        column: match.character,
      });
    },
    [openFile],
  );

  const openWorkspaceSymbol = useCallback(
    async (symbol: SymbolInformation | WorkspaceSymbol) => {
      const location = symbol.location;
      if (!location || !("uri" in location)) return;
      const path = uriToPath(location.uri);
      await openFile(path);
      if ("range" in location) {
        editorRef.current?.setPosition({
          lineNumber: location.range.start.line + 1,
          column: location.range.start.character + 1,
        });
        editorRef.current?.revealPositionInCenter({
          lineNumber: location.range.start.line + 1,
          column: location.range.start.character + 1,
        });
      }
    },
    [openFile],
  );

  const runWorkspaceSearch = useCallback(async () => {
    if (!root || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const matches = await invoke<SearchMatch[]>("search_workspace", {
        root,
        query: searchQuery,
        maxResults: 200,
      });
      setSearchResults(matches);
      setStatus(`搜索到 ${matches.length} 个结果`);
    } catch (error) {
      setOutput(String(error));
      setStatus("搜索失败");
    } finally {
      setSearching(false);
    }
  }, [root, searchQuery]);

  const closeTab = useCallback(
    async (path: string): Promise<boolean> => {
      const key = normalizePath(path);
      if (dirtyPaths.has(key)) {
        const close = await confirmDialog("文件未保存，确定关闭？", {
          title: "未保存的文件",
          kind: "warning",
          okLabel: "关闭",
          cancelLabel: "取消",
        });
        if (!close) return false;
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
      return true;
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
          source: "clangd" as const,
        })),
      ]);
    },
    [],
  );

  const applyLspWorkspaceEdit = useCallback(
    async (edit: WorkspaceEdit): Promise<boolean> => {
      const groups = new Map<string, TextEdit[]>();
      if (edit.changes) {
        for (const [uri, edits] of Object.entries(edit.changes)) {
          groups.set(uri, edits);
        }
      }
      if (edit.documentChanges) {
        for (const change of edit.documentChanges) {
          const documentEdit = change as {
            textDocument?: { uri: string };
            edits?: TextEdit[];
          };
          if (!documentEdit.textDocument || !documentEdit.edits) {
            throw new Error("暂不支持 clangd 返回的资源文件操作");
          }
          groups.set(documentEdit.textDocument.uri, documentEdit.edits);
        }
      }

      const touched: OpenedDoc[] = [];
      try {
        for (const [uri, edits] of groups) {
          const doc = await ensureDocumentByPath(uriToPath(uri));
          if (!doc) throw new Error(`无法打开编辑目标: ${uri}`);
          const operations: monaco.editor.IIdentifiedSingleEditOperation[] =
            edits
              .map((textEdit) => ({
                range: toMonacoRange(textEdit.range),
                text: textEdit.newText,
                forceMoveMarkers: true,
              }))
              .sort(
                (a, b) =>
                  b.range.startLineNumber - a.range.startLineNumber ||
                  b.range.startColumn - a.range.startColumn,
              );
          doc.model.pushEditOperations([], operations, () => null);
          touched.push(doc);
        }

        const dirtyKeys = new Set(touched.map((doc) => normalizePath(doc.path)));
        for (const doc of touched) {
          await invoke("save_text_file", {
            path: doc.path,
            content: doc.model.getValue(),
            encoding: doc.encoding,
          });
          lspRef.current?.didSave(doc.uri);
          dirtyKeys.add(normalizePath(doc.path));
        }
        setDirtyPaths((previous) => {
          const next = new Set(previous);
          for (const key of dirtyKeys) next.delete(key);
          return next;
        });

        for (const doc of touched) {
          const key = normalizePath(doc.path);
          const isOpen = openTabsRef.current.some(
            (tab) => normalizePath(tab) === key,
          );
          if (!isOpen && editorRef.current?.getModel() !== doc.model) {
            lspRef.current?.didClose(doc.uri);
            doc.model.dispose();
            docsRef.current.delete(key);
          }
        }
        return true;
      } catch (error) {
        setOutput(String(error));
        setStatus("应用编辑失败");
        return false;
      }
    },
    [ensureDocumentByPath],
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

    const contentSubscription = editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (!model) return;
      const path = uriToPath(model.uri.toString());
      const key = normalizePath(path);
      const doc = docsRef.current.get(key);
      if (!doc) return;

      if (!externalReloadRef.current.has(key)) {
        setDirtyPaths((previous) => {
          const next = new Set(previous);
          next.add(key);
          return next;
        });
      }

      if (!isLspLanguage(doc.language)) return;
      const lsp = lspRef.current;
      if (!lsp) return;
      doc.version += 1;
      // Full-document sync is used here deliberately: it is robust across
      // multi-cursor edits, CRLF normalization and restart/re-open cycles.
      lsp.didChangeFull(
        doc.uri,
        doc.version,
        model.getValue(monaco.editor.EndOfLinePreference.LF),
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

    const signatures = monaco.languages.registerSignatureHelpProvider("cpp", {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp: async (model, position) => {
        const lsp = lspRef.current;
        if (!lsp) return null;
        try {
          const result = await lsp.signatureHelp(
            model.uri.toString(),
            position.lineNumber - 1,
            position.column - 1,
          );
          if (!result) return null;
          const signatureHelp: monaco.languages.SignatureHelp = {
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
            signatures: result.signatures.map((signature) => ({
              label: signature.label,
              documentation:
                typeof signature.documentation === "string"
                  ? signature.documentation
                  : signature.documentation?.value,
              parameters:
                signature.parameters?.map((parameter) => ({
                  label: parameter.label,
                  documentation:
                    typeof parameter.documentation === "string"
                      ? parameter.documentation
                      : parameter.documentation?.value,
                })) ?? [],
            })),
          };
          return { value: signatureHelp, dispose: () => undefined };
        } catch (error) {
          console.warn("[lsp] signature help failed", error);
          return null;
        }
      },
    });

    const highlights = monaco.languages.registerDocumentHighlightProvider(
      "cpp",
      {
        provideDocumentHighlights: async (model, position) => {
          const lsp = lspRef.current;
          if (!lsp) return [];
          try {
            const result = await lsp.documentHighlights(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
            );
            return result.map((highlight) => ({
              range: toMonacoRange(highlight.range),
              kind:
                highlight.kind === 3
                  ? monaco.languages.DocumentHighlightKind.Write
                  : highlight.kind === 2
                    ? monaco.languages.DocumentHighlightKind.Read
                    : monaco.languages.DocumentHighlightKind.Text,
            }));
          } catch (error) {
            console.warn("[lsp] document highlights failed", error);
            return [];
          }
        },
      },
    );

    const rename = monaco.languages.registerRenameProvider("cpp", {
      provideRenameEdits: async (model, position, newName) => {
        const lsp = lspRef.current;
        if (!lsp) throw new Error("clangd 未连接");
        const edit = await lsp.rename(
          model.uri.toString(),
          position.lineNumber - 1,
          position.column - 1,
          newName,
        );
        if (!edit) throw new Error("clangd 没有返回重命名编辑");
        const applied = await applyLspWorkspaceEdit(edit);
        if (!applied) throw new Error("应用重命名编辑失败");
        return { edits: [] };
      },
    });

    const codeActions = monaco.languages.registerCodeActionProvider("cpp", {
      provideCodeActions: async (model, range, context) => {
        const lsp = lspRef.current;
        if (!lsp) return { actions: [], dispose: () => undefined };
        const diagnostics: Diagnostic[] = context.markers.map((marker) => ({
          range: {
            start: {
              line: marker.startLineNumber - 1,
              character: marker.startColumn - 1,
            },
            end: {
              line: marker.endLineNumber - 1,
              character: marker.endColumn - 1,
            },
          },
          severity: fromMarkerSeverity(marker.severity),
          message: marker.message,
          source: marker.source,
        }));
        try {
          const result = await lsp.codeActions(
            model.uri.toString(),
            {
              start: {
                line: range.startLineNumber - 1,
                character: range.startColumn - 1,
              },
              end: {
                line: range.endLineNumber - 1,
                character: range.endColumn - 1,
              },
            },
            diagnostics,
          );
          return {
            actions: result.map((item) => {
              if ("command" in item && typeof item.command === "string") {
                const commandItem = item as {
                  title: string;
                  command: string;
                  arguments?: unknown[];
                };
                return {
                  title: commandItem.title,
                  command: {
                    id: "devcpp.applyCodeAction",
                    title: commandItem.title,
                    arguments: [commandItem],
                  },
                };
              }
              const action = item as CodeAction;
              return {
                title: action.title,
                isPreferred: action.isPreferred,
                disabled: action.disabled?.reason,
                command: {
                  id: "devcpp.applyCodeAction",
                  title: action.title,
                  arguments: [action],
                },
              };
            }),
            dispose: () => undefined,
          };
        } catch (error) {
          console.warn("[lsp] code actions failed", error);
          return { actions: [], dispose: () => undefined };
        }
      },
    });

    const applyCodeAction = editor.addAction({
      id: "devcpp.applyCodeAction",
      label: "应用代码操作",
      run: async (_editor, ...args) => {
        const lsp = lspRef.current;
        if (!lsp) return;
        const item = args[0] as
          | CodeAction
          | { title: string; command: string; arguments?: unknown[] };
        try {
          if ("edit" in item && item.edit) {
            await applyLspWorkspaceEdit(item.edit);
            return;
          }
          if ("command" in item) {
            const command =
              typeof item.command === "string"
                ? {
                    command: item.command,
                    arguments: (
                      item as {
                        title: string;
                        command: string;
                        arguments?: unknown[];
                      }
                    ).arguments,
                  }
                : item.command;
            if (!command) return;
            const result = await lsp.executeCommand(
              command.command,
              command.arguments,
            );
            if (
              result &&
              typeof result === "object" &&
              ("changes" in result || "documentChanges" in result)
            ) {
              await applyLspWorkspaceEdit(result as WorkspaceEdit);
            }
          }
        } catch (error) {
          setOutput(String(error));
          setStatus("执行代码操作失败");
        }
      },
    });

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
      signatures.dispose();
      highlights.dispose();
      rename.dispose();
      codeActions.dispose();
      applyCodeAction.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [ensureDocumentByPath, applyLspWorkspaceEdit]);

  const applyEditorSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    editorRef.current?.updateOptions({
      fontSize: next.editor.fontSize,
      tabSize: next.editor.tabSize,
      minimap: { enabled: next.editor.minimap, renderCharacters: false, maxColumn: 80 },
      wordWrap: next.editor.wordWrap ? "on" : "off",
    });
  }, []);

  useEffect(() => {
    void invoke<ToolchainInfo>("detect_toolchain")
      .then((detected) => setToolchain(detected))
      .catch((error) => console.warn("[toolchain] detect failed", error));
  }, []);

  useEffect(() => {
    void invoke<AppSettings>("load_settings")
      .then((loaded) => {
        setSettingsDraft(loaded);
        applyEditorSettings(loaded);
      })
      .catch((error) => {
        console.warn("[settings] load failed", error);
      });
  }, [applyEditorSettings]);

  useEffect(() => {
    let refreshTimer: number | undefined;
    const pending = listen<FileChangeEvent>("file:changed", (event) => {
      const currentRoot = rootRef.current;
      if (!currentRoot) return;
      const key = normalizePath(event.payload.path);
      const rootKey = normalizePath(currentRoot);
      if (key !== rootKey && !key.startsWith(`${rootKey}\\`)) return;

      const doc = docsRef.current.get(key);
      if (doc) {
        if (event.payload.kind === "remove") {
          setStatus(`文件已被外部删除: ${event.payload.path}`);
        } else {
          void invoke<FileData>("read_text_file", {
            path: event.payload.path,
          })
            .then((data) => {
              if (dirtyPathsRef.current.has(key)) {
                setStatus("检测到外部修改；本地文件未保存，已保留当前内容");
                return;
              }
              if (data.content !== doc.model.getValue()) {
                externalReloadRef.current.add(key);
                doc.model.setValue(data.content);
                doc.model.setEOL(
                  data.eol === "crlf"
                    ? monaco.editor.EndOfLineSequence.CRLF
                    : monaco.editor.EndOfLineSequence.LF,
                );
                doc.encoding = data.encoding;
                doc.eol = data.eol;
                queueMicrotask(() => externalReloadRef.current.delete(key));
                setStatus(`已重新加载外部修改: ${event.payload.path}`);
              }
            })
            .catch((error) => console.warn("[watcher] reload failed", error));
        }
      }

      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const activeRoot = rootRef.current;
        if (!activeRoot) return;
        void (async () => {
          try {
            setEntries(
              await invoke<FileEntry[]>("list_dir", { path: activeRoot }),
            );
            const loaded = Object.keys(dirsRef.current);
            const refreshed = await Promise.all(
              loaded.map(async (dir) => [
                dir,
                await invoke<FileEntry[]>("list_dir", { path: dir }),
              ] as const),
            );
            const nextDirs = { ...dirsRef.current };
            for (const [dir, children] of refreshed) {
              nextDirs[dir] = children;
            }
            setDirs(nextDirs);
            setWorkspaceFiles(
              await invoke<FileEntry[]>("list_files", { root: activeRoot }),
            );
          } catch (error) {
            console.warn("[watcher] refresh failed", error);
          }
        })();
      }, 250);
    });
    return () => {
      window.clearTimeout(refreshTimer);
      void pending.then((unlisten) => unlisten());
    };
  }, []);

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
    if (!treeMenu) return;
    const closeMenu = () => setTreeMenu(null);
    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [treeMenu]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery, paletteOpen, paletteMode]);

  useEffect(() => {
    if (!paletteOpen || paletteMode !== "symbols") return;
    const timer = window.setTimeout(() => {
      const lsp = lspRef.current;
      if (!lsp) return;
      void lsp
        .workspaceSymbols(paletteQuery)
        .then((symbols) => setSymbolResults(symbols.slice(0, 100)))
        .catch((error) => console.warn("[lsp] workspace symbols failed", error));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [paletteOpen, paletteMode, paletteQuery]);

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
      lspRef.current?.didSave(doc.uri);
      setStatus("已保存");
      return true;
    } catch (error) {
      setOutput(String(error));
      setStatus("保存失败");
      return false;
    }
  }, [currentPath]);

  const saveAllDocuments = useCallback(async (): Promise<boolean> => {
    const dirty = Array.from(dirtyPaths);
    for (const key of dirty) {
      const doc = docsRef.current.get(key);
      if (!doc) continue;
      try {
        await invoke("save_text_file", {
          path: doc.path,
          content: doc.model.getValue(),
          encoding: doc.encoding,
        });
        lspRef.current?.didSave(doc.uri);
      } catch (error) {
        setOutput(String(error));
        setStatus("保存失败，已取消操作");
        return false;
      }
    }
    setDirtyPaths(new Set());
    return true;
  }, [dirtyPaths]);

  const formatCurrent = useCallback(async () => {
    if (!currentPath) return;
    await editorRef.current
      ?.getAction("editor.action.formatDocument")
      ?.run();
    setStatus("已格式化");
  }, [currentPath]);

  const persistSettings = useCallback(async () => {
    try {
      const saved = await invoke<AppSettings>("save_settings", {
        settings: settingsDraft,
      });
      setSettingsDraft(saved);
      applyEditorSettings(saved);
      setStatus("设置已保存");
    } catch (error) {
      setOutput(String(error));
      setStatus("保存设置失败");
    }
  }, [settingsDraft, applyEditorSettings]);

  const trustWorkspace = useCallback(async () => {
    if (!root) return;
    const next: AppSettings = {
      ...settings,
      trustedWorkspaces: [
        ...settings.trustedWorkspaces.filter(
          (path) => normalizePath(path) !== normalizePath(root),
        ),
        root,
      ],
    };
    try {
      const saved = await invoke<AppSettings>("save_settings", {
        settings: next,
      });
      setSettings(saved);
      setSettingsDraft(saved);
      setWorkspaceTrusted(true);
      setStatus("工作区已信任，可以构建和运行");
    } catch (error) {
      setOutput(String(error));
      setStatus("保存工作区信任状态失败");
    }
  }, [root, settings]);

  const completeOnboarding = useCallback(async () => {
    if (settings.onboardingCompleted) return;
    const next = { ...settings, onboardingCompleted: true };
    try {
      const saved = await invoke<AppSettings>("save_settings", {
        settings: next,
      });
      setSettings(saved);
      setSettingsDraft(saved);
    } catch (error) {
      console.warn("[settings] save onboarding failed", error);
    }
  }, [settings]);

  const buildAndRun = useCallback(async () => {
    if (!root || !currentPath || building) return;
    if (!workspaceTrusted) {
      setOutput(
        "当前工作区处于受限模式。请先点击编辑区上方的“信任并继续”，再构建或运行。",
      );
      setStatus("工作区未信任");
      setPanelTab("output");
      setPanelVisible(true);
      return;
    }
    const saved = await saveCurrent();
    if (!saved) return;
    setBuildProblems([]);
    setOutput("");
    setStatus("编译中...");
    setBuilding(true);
    try {
      const result = await invoke<BuildResult>("build_and_run_stream", {
        root,
        file: currentPath,
        stdin: stdinText,
        cxxFlags: settings.build.cxxFlags,
        staticRuntime: settings.build.staticRuntime,
        externalConsole: settings.build.externalConsole,
      });
      if (buildOutputTimerRef.current !== null) {
        window.clearTimeout(buildOutputTimerRef.current);
        buildOutputTimerRef.current = null;
      }
      buildOutputBufferRef.current = "";
      const diagnostics: ProblemItem[] = (result.diagnostics ?? []).map(
        (diagnostic) => ({
          uri: monaco.Uri.file(diagnostic.path).toString(),
          path: diagnostic.path,
          message: diagnostic.message,
          severity:
            diagnostic.severity === "error"
              ? 1
              : diagnostic.severity === "warning"
                ? 2
                : 3,
          line: diagnostic.line,
          character: diagnostic.character,
          source: "build",
        }),
      );
      setBuildProblems(diagnostics);
      setOutput(result.output || "(无输出)");
      setStatus(
        result.cancelled
          ? "构建已取消"
          : result.success
            ? `运行结束 · 退出码 ${result.exitCode} · ${result.durationMs} ms`
            : `构建失败 · 退出码 ${result.exitCode}`,
      );
      if (!result.success || diagnostics.length > 0) {
        setPanelTab("problems");
        setPanelVisible(true);
      }
    } catch (error) {
      setOutput(String(error));
      setStatus("构建失败");
    } finally {
      setBuilding(false);
    }
  }, [
    root,
    currentPath,
    building,
    workspaceTrusted,
    saveCurrent,
    stdinText,
    settings.build,
  ]);

  const cancelBuild = useCallback(async () => {
    try {
      await invoke("cancel_build");
      setStatus("正在取消构建...");
    } catch (error) {
      setOutput(String(error));
    }
  }, []);

  useEffect(() => {
    const pending = listen<BuildEvent>("build:event", (event) => {
      const payload = event.payload;
      if (payload.kind === "started") {
        if (buildOutputTimerRef.current !== null) {
          window.clearTimeout(buildOutputTimerRef.current);
          buildOutputTimerRef.current = null;
        }
        buildOutputBufferRef.current = "";
        setOutput("");
        return;
      }
      if (payload.kind !== "output" || !payload.text) return;
      buildOutputBufferRef.current += payload.text;
      if (buildOutputTimerRef.current !== null) return;
      buildOutputTimerRef.current = window.setTimeout(() => {
        const chunk = buildOutputBufferRef.current;
        buildOutputBufferRef.current = "";
        buildOutputTimerRef.current = null;
        if (chunk) setOutput((previous) => previous + chunk);
      }, 50);
    });
    return () => {
      if (buildOutputTimerRef.current !== null) {
        window.clearTimeout(buildOutputTimerRef.current);
        buildOutputTimerRef.current = null;
      }
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const openCommandPalette = useCallback(() => {
    setMenuOpen(null);
    setPaletteMode("commands");
    setPaletteQuery("");
    setPaletteIndex(0);
    setPaletteOpen(true);
  }, []);

  const openQuickOpen = useCallback(() => {
    setMenuOpen(null);
    setPaletteMode("files");
    setPaletteQuery("");
    setPaletteIndex(0);
    setPaletteOpen(true);
  }, []);

  const openWorkspaceSymbols = useCallback(() => {
    setMenuOpen(null);
    setPaletteMode("symbols");
    setPaletteQuery("");
    setPaletteIndex(0);
    setSymbolResults([]);
    setPaletteOpen(true);
  }, []);

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
        openCommandPalette();
        return;
      }
      if (ctrl && event.shiftKey && key === "f") {
        event.preventDefault();
        setSidebarView("search");
        setSidebarVisible(true);
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
        openQuickOpen();
        return;
      }
      if (ctrl && key === "t") {
        event.preventDefault();
        openWorkspaceSymbols();
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
        void closeTab(currentPath);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buildAndRun, saveCurrent, currentPath, closeTab, openCommandPalette, openQuickOpen, openWorkspaceSymbols]);

  const connectLsp = useCallback(
    async (workspaceRoot: string, clangdVersion?: string) => {
      lspRef.current?.dispose();
      lspRef.current = null;
      const info = await invoke<LspInfo>("start_lsp", {
        root: workspaceRoot,
      });
      const client = await LspClient.connect(info, workspaceRoot);
      client.onDiagnostics(handleDiagnostics);
      lspRef.current = client;
      // A restarted clangd starts with no open documents. Replay the
      // currently open buffers so diagnostics keep working after recovery.
      for (const doc of docsRef.current.values()) {
        if (isLspLanguage(doc.language)) {
          doc.version = 1;
          client.didOpen(
            doc.uri,
            doc.language,
            doc.model.getValue(monaco.editor.EndOfLinePreference.LF),
          );
        }
      }
      setLspStatus(
        `clangd ${shortVersion(
          clangdVersion ?? toolchain?.clangdVersion,
          "已连接",
        )}`,
      );
      return client;
    },
    [handleDiagnostics, toolchain?.clangdVersion],
  );

  const scheduleLspRestart = useCallback(
    (reason: string) => {
      if (!rootRef.current || lspRestartingRef.current) return;
      const now = Date.now();
      const recent = lspCrashTimesRef.current.filter(
        (time) => now - time < 60_000,
      );
      recent.push(now);
      lspCrashTimesRef.current = recent;
      if (recent.length > 3) {
        setLspStatus("clangd 多次退出，自动重启已暂停");
        setOutput(
          `${reason}

clangd 在 60 秒内连续退出超过 3 次，已停止自动重启。请检查 clangd 日志或手动重启。`,
        );
        return;
      }
      const delay = Math.min(500 * 2 ** (recent.length - 1), 8000);
      setLspStatus(
        `clangd 已退出，${delay} ms 后重试（${recent.length}/3）`,
      );
      setOutput(`${reason}

${delay} ms 后自动重启 clangd...`);
      lspRestartingRef.current = true;
      lspRestartTimerRef.current = window.setTimeout(async () => {
        lspRestartTimerRef.current = null;
        lspRestartingRef.current = false;
        const activeRoot = rootRef.current;
        if (!activeRoot) return;
        try {
          await connectLsp(activeRoot);
          setStatus("clangd 已自动恢复");
        } catch (error) {
          setOutput(String(error));
          scheduleRestartRef.current(reason);
        }
      }, delay);
    },
    [connectLsp],
  );

  useEffect(() => {
    scheduleRestartRef.current = scheduleLspRestart;
  }, [scheduleLspRestart]);

  useEffect(() => {
    return () => {
      if (lspRestartTimerRef.current !== null) {
        window.clearTimeout(lspRestartTimerRef.current);
        lspRestartTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const pending = listen<LspStopped>("lsp:stopped", (event) => {
      if (event.payload.intentional) {
        lspCrashTimesRef.current = [];
        lspRestartingRef.current = false;
        return;
      }
      scheduleLspRestart(event.payload.reason);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [scheduleLspRestart]);

  const openWorkspace = useCallback(
    async (selected: string) => {
      if (dirtyPaths.size > 0) {
        const shouldSave = await confirmDialog(
          "有未保存的文件。是否保存并切换工作区？",
          {
            title: "未保存的文件",
            kind: "warning",
            okLabel: "保存并切换",
            cancelLabel: "取消",
          },
        );
        if (!shouldSave) return;
        if (!(await saveAllDocuments())) return;
      }
      if (lspRestartTimerRef.current !== null) {
        window.clearTimeout(lspRestartTimerRef.current);
        lspRestartTimerRef.current = null;
      }
      lspRestartingRef.current = false;
      lspCrashTimesRef.current = [];
      void invoke("unwatch_workspace").catch(() => undefined);
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
      const trusted = settings.trustedWorkspaces.some(
        (path) => normalizePath(path) === normalizePath(selected),
      );
      setWorkspaceTrusted(trusted);
      if (!settings.onboardingCompleted) {
        void completeOnboarding();
      }
      rememberRecent(selected);
      setCurrentPath(null);
      setOpenTabs([]);
      setDirtyPaths(new Set());
      setProblems([]);
      setBuildProblems([]);
      setDirs({});
      setExpanded(new Set());
      setWorkspaceFiles([]);
      setSearchQuery("");
      setSearchResults([]);
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
        setWorkspaceFiles(
          await invoke<FileEntry[]>("list_files", { root: selected }),
        );
        void invoke("watch_workspace", { root: selected }).catch((error) =>
          console.warn("[watcher] start failed", error),
        );
        const detected = await invoke<ToolchainInfo>("detect_toolchain");
        setToolchain(detected);
        setStatus(
          `工作区已打开 · ${workspace.sources} 个 C++ 源文件`,
        );

        try {
          await connectLsp(selected, detected.clangdVersion);
        } catch (error) {
          setLspStatus("clangd 不可用");
          setOutput(
            `${String(error)}

提示：设置 DEVCPP_CLANGD 或把 clangd.exe 放到 tools/clangd/bin/。`,
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
    [
      connectLsp,
      dirtyPaths,
      openFile,
      rememberRecent,
      saveAllDocuments,
      settings.trustedWorkspaces,
      settings.onboardingCompleted,
      completeOnboarding,
    ],
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

  const reloadWorkspaceData = useCallback(async () => {
    if (!root) return;
    try {
      setEntries(await invoke<FileEntry[]>("list_dir", { path: root }));
      const loaded = Object.keys(dirsRef.current);
      const refreshed = await Promise.all(
        loaded.map(async (dir) => [
          dir,
          await invoke<FileEntry[]>("list_dir", { path: dir }),
        ] as const),
      );
      const nextDirs = { ...dirsRef.current };
      for (const [dir, children] of refreshed) {
        nextDirs[dir] = children;
      }
      setDirs(nextDirs);
      setWorkspaceFiles(
        await invoke<FileEntry[]>("list_files", { root }),
      );
    } catch (error) {
      setOutput(String(error));
    }
  }, [root]);

  const closeDocsUnder = useCallback(
    async (prefix: string): Promise<boolean> => {
      const prefixKey = normalizePath(prefix);
      const matching = Array.from(docsRef.current.values()).filter((doc) => {
        const key = normalizePath(doc.path);
        return key === prefixKey || key.startsWith(`${prefixKey}\\`);
      });
      for (const doc of matching) await closeTab(doc.path);
      return !Array.from(docsRef.current.values()).some((doc) => {
        const key = normalizePath(doc.path);
        return key === prefixKey || key.startsWith(`${prefixKey}\\`);
      });
    },
    [closeTab],
  );

  const askText = useCallback(
    (title: string, initial: string, confirm: (value: string) => void) => {
      setTextPromptValue(initial);
      setTextPrompt({ title, value: initial, confirm });
    },
    [],
  );

  const createEntry = useCallback(
    async (kind: "file" | "directory", base: string) => {
      if (!root) return;
      const suggested = kind === "file" ? "main.cpp" : "src";
      askText(
        kind === "file" ? "新建文件" : "新建文件夹",
        suggested,
        (raw) => {
          const name = raw.trim();
          if (!name) return;
          if (name.includes("..") || /^[\\/]/.test(name)) {
            setStatus("名称不能包含 .. 或绝对路径");
            return;
          }
          const separator = base.includes("\\") ? "\\" : "/";
          const target = `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
          void (async () => {
            try {
              await invoke(
                kind === "file" ? "create_file" : "create_directory",
                { root, path: target },
              );
              setExpanded((previous) => {
                const next = new Set(previous);
                next.add(base);
                return next;
              });
              await reloadWorkspaceData();
              if (kind === "file") await openFile(target);
              setStatus(kind === "file" ? "文件已创建" : "文件夹已创建");
            } catch (error) {
              setOutput(String(error));
              setStatus(
                kind === "file" ? "创建文件失败" : "创建文件夹失败",
              );
            }
          })();
        },
      );
    },
    [askText, openFile, reloadWorkspaceData, root],
  );

  const renameEntry = useCallback(
    async (entry: FileEntry) => {
      if (!root) return;
      const oldName = entry.name;
      askText("重命名", oldName, (raw) => {
        const newName = raw.trim();
        if (!newName || newName === oldName) return;
        if (newName.includes("..") || /[\\/]/.test(newName)) {
          setStatus("名称不能包含路径分隔符");
          return;
        }
        const separator = entry.path.includes("\\") ? "\\" : "/";
        const parent = entry.path.slice(
          0,
          Math.max(
            entry.path.lastIndexOf("\\"),
            entry.path.lastIndexOf("/"),
          ),
        );
        const target = `${parent}${separator}${newName}`;
        const wasCurrent =
          currentPath !== null &&
          (normalizePath(currentPath) === normalizePath(entry.path) ||
            normalizePath(currentPath).startsWith(
              `${normalizePath(entry.path)}\\`,
            ));
        void (async () => {
          if (!(await closeDocsUnder(entry.path))) return;
          try {
            await invoke("rename_path", {
              root,
              from: entry.path,
              to: target,
            });
            await reloadWorkspaceData();
            if (wasCurrent && !entry.isDir) await openFile(target);
            setStatus("重命名成功");
          } catch (error) {
            setOutput(String(error));
            setStatus("重命名失败");
          }
        })();
      });
    },
    [askText, closeDocsUnder, currentPath, openFile, reloadWorkspaceData, root],
  );

  const moveEntry = useCallback(
    async (entry: FileEntry, targetDir: string) => {
      if (!root) return;
      const sourceKey = normalizePath(entry.path);
      const targetDirKey = normalizePath(targetDir);
      const parent = entry.path.slice(
        0,
        Math.max(entry.path.lastIndexOf("\\"), entry.path.lastIndexOf("/")),
      );
      if (normalizePath(parent) === targetDirKey) {
        setStatus("文件已在该目录");
        return;
      }
      if (
        entry.isDir &&
        (targetDirKey === sourceKey ||
          targetDirKey.startsWith(`${sourceKey}\\`))
      ) {
        setStatus("不能把文件夹移动到自身或其子目录");
        return;
      }
      const separator = targetDir.includes("\\") ? "\\" : "/";
      const target = `${targetDir.replace(/[\\/]+$/, "")}${separator}${entry.name}`;
      if (normalizePath(target) === sourceKey) return;

      const wasCurrent =
        currentPath !== null &&
        (normalizePath(currentPath) === sourceKey ||
          normalizePath(currentPath).startsWith(`${sourceKey}\\`));
      const wasExpandedDir = entry.isDir && expanded.has(entry.path);

      if (!(await closeDocsUnder(entry.path))) return;
      try {
        await invoke("rename_path", {
          root,
          from: entry.path,
          to: target,
        });
        setExpanded((previous) => {
          const next = new Set<string>();
          for (const path of previous) {
            const key = normalizePath(path);
            if (key === sourceKey || key.startsWith(`${sourceKey}\\`)) {
              continue;
            }
            next.add(path);
          }
          next.add(targetDir);
          if (wasExpandedDir) next.add(target);
          return next;
        });
        await reloadWorkspaceData();
        if (wasCurrent && !entry.isDir) await openFile(target);
        setStatus(`已移动到 ${targetDir}`);
      } catch (error) {
        setOutput(String(error));
        setStatus("移动失败");
      }
    },
    [
      closeDocsUnder,
      currentPath,
      expanded,
      openFile,
      reloadWorkspaceData,
      root,
    ],
  );

  const deleteEntry = useCallback(
    async (entry: FileEntry) => {
      if (!root) return;
      if (
        !(await confirmDialog(`将“${entry.name}”移入回收站？`, {
          title: "删除",
          kind: "warning",
          okLabel: "移入回收站",
          cancelLabel: "取消",
        }))
      ) {
        return;
      }
      if (!(await closeDocsUnder(entry.path))) return;
      try {
        await invoke("delete_path", {
          root,
          path: entry.path,
          permanent: false,
        });
        await reloadWorkspaceData();
        if (
          currentPath !== null &&
          (normalizePath(currentPath) === normalizePath(entry.path) ||
            normalizePath(currentPath).startsWith(
              `${normalizePath(entry.path)}\\`,
            ))
        ) {
          setCurrentPath(null);
          editorRef.current?.setModel(null);
        }
        setStatus("已移入回收站");
      } catch (error) {
        setOutput(String(error));
        setStatus("删除失败");
      }
    },
    [closeDocsUnder, currentPath, reloadWorkspaceData, root],
  );

  const runEditorAction = useCallback((action: string) => {
    editorRef.current?.trigger("menu", action, null);
  }, []);

  const restartLsp = useCallback(async () => {
    if (!root) return;
    if (lspRestartTimerRef.current !== null) {
      window.clearTimeout(lspRestartTimerRef.current);
      lspRestartTimerRef.current = null;
    }
    lspRestartingRef.current = false;
    lspCrashTimesRef.current = [];
    setLspStatus("clangd 重启中...");
    lspRef.current?.dispose();
    lspRef.current = null;
    try {
      await invoke("stop_lsp");
      await connectLsp(root, toolchain?.clangdVersion);
      setStatus("clangd 已重启");
    } catch (error) {
      setLspStatus("clangd 不可用");
      setOutput(String(error));
    }
  }, [root, toolchain?.clangdVersion, connectLsp]);

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
      id: "file.newFile",
      label: "文件: 新建文件",
      run: () => {
        if (root) void createEntry("file", root);
      },
    },
    {
      id: "file.newFolder",
      label: "文件: 新建文件夹",
      run: () => {
        if (root) void createEntry("directory", root);
      },
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
      id: "file.quickOpen",
      label: "文件: 快速打开...",
      keybinding: "Ctrl+P",
      run: openQuickOpen,
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
        if (currentPath) void closeTab(currentPath);
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
      id: "refactor.rename",
      label: "重构: 重命名符号",
      keybinding: "F2",
      run: () => runEditorAction("editor.action.rename"),
    },
    {
      id: "refactor.quickFix",
      label: "重构: 快速修复",
      keybinding: "Ctrl+.",
      run: () => runEditorAction("editor.action.quickFix"),
    },
    {
      id: "view.workspaceSymbols",
      label: "转到: 工作区符号",
      keybinding: "Ctrl+T",
      run: openWorkspaceSymbols,
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
      keybinding: "Ctrl+Shift+F",
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
      run: openCommandPalette,
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
      id: "lsp.restart",
      label: "LSP: 重启 clangd",
      run: () => void restartLsp(),
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
        "file.newFile",
        "file.newFolder",
        "file.quickOpen",
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
        "view.workspaceSymbols",
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
      id: "refactor",
      label: "重构",
      items: ["refactor.rename", "refactor.quickFix"],
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
  const filteredFiles =
    paletteMode === "files"
      ? workspaceFiles
          .filter((file) =>
            normalizedPaletteQuery
              ? file.path.toLowerCase().includes(normalizedPaletteQuery)
              : true,
          )
          .slice(0, 100)
      : [];
  const filteredSymbols =
    paletteMode === "symbols" ? symbolResults : [];
  const paletteItemCount =
    paletteMode === "files"
      ? filteredFiles.length
      : paletteMode === "symbols"
        ? filteredSymbols.length
        : filteredCommands.length;

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
            className={`tree-row${isActive ? " active" : ""}${
              dropTarget === item.path ? " drop-target" : ""
            }`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={item.path}
            draggable
            onDragStart={(event) => {
              dragEntryRef.current = item;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.path);
              setDropTarget(null);
            }}
            onDragEnd={() => {
              dragEntryRef.current = null;
              setDropTarget(null);
            }}
            onDragOver={(event) => {
              if (!item.isDir || !dragEntryRef.current) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              setDropTarget(item.path);
            }}
            onDragLeave={() => {
              if (dropTarget === item.path) setDropTarget(null);
            }}
            onDrop={(event) => {
              if (!item.isDir) return;
              event.preventDefault();
              event.stopPropagation();
              const source = dragEntryRef.current;
              dragEntryRef.current = null;
              setDropTarget(null);
              if (source) void moveEntry(source, item.path);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setTreeMenu({
                path: item.path,
                isDir: item.isDir,
                x: event.clientX,
                y: event.clientY,
              });
            }}
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

  const allProblems = [...problems, ...buildProblems];
  const renderProblemList = (): ReactNode =>
    allProblems.length === 0 ? (
      <div className="empty">暂无问题</div>
    ) : (
      allProblems.map((problem) => (
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
            <span className="problem-source">{problem.source}</span>
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
            <span className="sidebar-count">{searchResults.length}</span>
          </div>
          <div className="sidebar-body">
            <div className="search-box">
              <input
                className="search-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runWorkspaceSearch();
                }}
                placeholder="在工作区中搜索"
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-button"
                title="搜索"
                disabled={!root || searching}
                onClick={() => void runWorkspaceSearch()}
              >
                <Search size={15} />
              </button>
            </div>
            {searching ? (
              <div className="empty">搜索中...</div>
            ) : searchResults.length > 0 ? (
              <div className="search-results">
                {searchResults.map((match, index) => (
                  <button
                    type="button"
                    className="search-result"
                    key={`${match.path}:${match.line}:${match.character}:${index}`}
                    title={`${match.path}:${match.line}:${match.character}`}
                    onClick={() => void openSearchResult(match)}
                  >
                    <span className="search-result-file">
                      {relativeToRoot(match.path, root)}
                      <span className="search-result-loc">
                        :{match.line}:{match.character}
                      </span>
                    </span>
                    <span className="search-result-preview">
                      {match.preview}
                    </span>
                  </button>
                ))}
              </div>
            ) : searchQuery.trim() ? (
              <div className="empty">没有匹配结果</div>
            ) : (
              <div className="empty">
                输入关键词后按 Enter；支持中文与大小写不敏感匹配。
              </div>
            )}
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
              disabled={!currentPath || building || !workspaceTrusted}
              onClick={() => void buildAndRun()}
            >
              <Play size={15} /> {building ? "构建中..." : "编译并运行"}
              <kbd>F11</kbd>
            </button>
            {building ? (
              <button
                type="button"
                className="side-button danger"
                onClick={() => void cancelBuild()}
              >
                <X size={15} /> 取消构建
              </button>
            ) : null}
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
            <button
              type="button"
              className="icon-button"
              title="保存设置"
              onClick={() => void persistSettings()}
            >
              <Save size={15} />
            </button>
          </div>
          <div className="sidebar-body settings-view">
            <div className="settings-title">编辑器</div>
            <label className="setting-row">
              <span className="setting-label">字体大小</span>
              <input
                className="setting-input"
                type="number"
                min={10}
                max={32}
                value={settingsDraft.editor.fontSize}
                onChange={(event) =>
                  setSettingsDraft((previous) => ({
                    ...previous,
                    editor: {
                      ...previous.editor,
                      fontSize: Number(event.target.value),
                    },
                  }))
                }
              />
            </label>
            <label className="setting-row">
              <span className="setting-label">Tab 宽度</span>
              <input
                className="setting-input"
                type="number"
                min={1}
                max={8}
                value={settingsDraft.editor.tabSize}
                onChange={(event) =>
                  setSettingsDraft((previous) => ({
                    ...previous,
                    editor: {
                      ...previous.editor,
                      tabSize: Number(event.target.value),
                    },
                  }))
                }
              />
            </label>
            <label className="setting-row">
              <span className="setting-label">Minimap</span>
              <input
                type="checkbox"
                checked={settingsDraft.editor.minimap}
                onChange={(event) =>
                  setSettingsDraft((previous) => ({
                    ...previous,
                    editor: {
                      ...previous.editor,
                      minimap: event.target.checked,
                    },
                  }))
                }
              />
            </label>
            <label className="setting-row">
              <span className="setting-label">自动换行</span>
              <input
                type="checkbox"
                checked={settingsDraft.editor.wordWrap}
                onChange={(event) =>
                  setSettingsDraft((previous) => ({
                    ...previous,
                    editor: {
                      ...previous.editor,
                      wordWrap: event.target.checked,
                    },
                  }))
                }
              />
            </label>
            <div className="settings-title">构建</div>
            <label className="setting-field">
              <span className="setting-label">g++ 参数</span>
              <textarea
                className="setting-textarea"
                value={settingsDraft.build.cxxFlags.join(" ")}
                onChange={(event) =>
                  setSettingsDraft((previous) => ({
                    ...previous,
                    build: {
                      ...previous.build,
                      cxxFlags: event.target.value
                        .split(/\s+/)
                        .filter(Boolean),
                    },
                  }))
                }
                spellCheck={false}
              />
            </label>
            <label className="setting-row">
              <span className="setting-label">静态运行库</span>
              <input
                type="checkbox"
                checked={settingsDraft.build.staticRuntime}
                onChange={(event) =>
                  setSettingsDraft((previous) => ({
                    ...previous,
                    build: {
                      ...previous.build,
                      staticRuntime: event.target.checked,
                    },
                  }))
                }
              />
            </label>
            <label className="setting-row">
              <span className="setting-label">外部控制台</span>
              <input
                type="checkbox"
                checked={settingsDraft.build.externalConsole}
                onChange={(event) =>
                  setSettingsDraft((previous) => ({
                    ...previous,
                    build: {
                      ...previous.build,
                      externalConsole: event.target.checked,
                    },
                  }))
                }
              />
            </label>
            <div className="side-note">
              外部控制台适合需要交互输入的程序；关闭时使用输出面板和 stdin 文本框。
            </div>
            <button
              type="button"
              className="side-button primary"
              onClick={() => void persistSettings()}
            >
              <Save size={15} /> 保存设置
            </button>
            <button
              type="button"
              className="side-button"
              disabled={!root}
              onClick={() => void restartLsp()}
            >
              <RefreshCw size={15} /> 重启 clangd
            </button>
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
              设置保存到用户配置目录。运行
              <code>scripts/fetch-toolchain.ps1</code>
              下载 clangd/CMake/Ninja，或设置 DEVCPP_* 环境变量。
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
              title="新建文件"
              disabled={!root}
              onClick={() => {
                if (root) void createEntry("file", root);
              }}
            >
              <FilePlus size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="新建文件夹"
              disabled={!root}
              onClick={() => {
                if (root) void createEntry("directory", root);
              }}
            >
              <FolderPlus size={15} />
            </button>
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
            <div
              className={`root-path${
                dropTarget === root ? " drop-target" : ""
              }`}
              title={`${root}（拖到此处移动到工作区根目录）`}
              onDragOver={(event) => {
                if (!dragEntryRef.current) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget(root);
              }}
              onDragLeave={() => {
                if (dropTarget === root) setDropTarget(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = dragEntryRef.current;
                dragEntryRef.current = null;
                setDropTarget(null);
                if (source) void moveEntry(source, root);
              }}
            >
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

  const problemCount = allProblems.length;
  const errorCount = allProblems.filter((problem) => problem.severity === 1).length;
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
  const minimizeWindow = useCallback(() => {
    void getCurrentWindow().minimize().catch(() => undefined);
  }, []);

  const toggleMaximizeWindow = useCallback(async () => {
    const appWindow = getCurrentWindow();
    try {
      if (isMaximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
      setIsMaximized(await appWindow.isMaximized());
    } catch {
      // ignore window state errors
    }
  }, [isMaximized]);

  const closeWindow = useCallback(() => {
    void getCurrentWindow().close().catch(() => undefined);
  }, []);

  const clearTitlebarDragTimer = useCallback(() => {
    if (titlebarDragTimerRef.current !== null) {
      window.clearTimeout(titlebarDragTimerRef.current);
      titlebarDragTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (titlebarDragTimerRef.current !== null) {
        window.clearTimeout(titlebarDragTimerRef.current);
      }
    };
  }, []);

  const handleTitlebarMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("button, a, input, select, textarea, label")) return;
      clearTitlebarDragTimer();
      titlebarDragTimerRef.current = window.setTimeout(() => {
        titlebarDragTimerRef.current = null;
        void getCurrentWindow()
          .startDragging()
          .catch((error) => setStatus(`拖动窗口失败: ${String(error)}`));
      }, 180);
    },
    [clearTitlebarDragTimer],
  );

  const handleTitlebarDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("button, a, input, select, textarea, label")) return;
      clearTitlebarDragTimer();
      void toggleMaximizeWindow();
    },
    [clearTitlebarDragTimer, toggleMaximizeWindow],
  );

  const beginResize = useCallback((direction: ResizeDirection) => {
    void getCurrentWindow()
      .startResizeDragging(direction)
      .catch(() => undefined);
  }, []);

  const breadcrumbParts = breadcrumbPath
    .split(/[\\/]/)
    .filter(Boolean);

  return (
    <div className={`app${isMaximized ? " maximized" : ""}`}>
      <header
        className={`titlebar${windowFocused ? " focused" : ""}`}
        onMouseDown={handleTitlebarMouseDown}
        onMouseUp={clearTitlebarDragTimer}
        onDoubleClick={handleTitlebarDoubleClick}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="titlebar-brand" title="DevCpp++">
          <img
            className="titlebar-logo"
            src="/logo.svg"
            alt=""
            draggable={false}
          />
          <span className="titlebar-title">DevCpp++</span>
        </div>
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
                          {command.label.replace(/^[^:]+:s*/, "")}
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
          onClick={openCommandPalette}
        >
          <Search size={13} />
          <span>搜索或运行命令</span>
          <span className="command-center-hint">Ctrl+Shift+P</span>
        </button>
        <div className="titlebar-drag-fill" />
        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            title="最小化"
            aria-label="最小化"
            onClick={minimizeWindow}
          >
            <span className="window-glyph minimize" />
          </button>
          <button
            type="button"
            className="window-control"
            title={isMaximized ? "还原" : "最大化"}
            aria-label={isMaximized ? "还原" : "最大化"}
            onClick={() => void toggleMaximizeWindow()}
          >
            <span
              className={`window-glyph ${
                isMaximized ? "restore" : "maximize"
              }`}
            />
          </button>
          <button
            type="button"
            className="window-control close"
            title="关闭"
            aria-label="关闭"
            onClick={closeWindow}
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {!isMaximized
        ? RESIZE_HANDLES.map((handle) => (
            <div
              key={handle.direction}
              className={`resize-handle ${handle.className}`}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                beginResize(handle.direction);
              }}
            />
          ))
        : null}

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
                        void closeTab(path);
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

          {root && !workspaceTrusted ? (
            <div className="trust-banner">
              <ShieldAlert size={16} className="trust-icon" />
              <div className="trust-copy">
                <strong>受限模式</strong>
                <span>
                  此工作区尚未信任。构建和运行已禁用，编辑与浏览仍可用。
                </span>
              </div>
              <button
                type="button"
                className="trust-button"
                onClick={() => void trustWorkspace()}
              >
                信任并继续
              </button>
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
                {!root && !settings.onboardingCompleted ? (
                  <div className="onboarding-card">
                    <div className="onboarding-title">首次使用 · 环境检查</div>
                    <div className="onboarding-grid">
                      {[
                        ["g++", toolchain?.gxxVersion],
                        ["clangd", toolchain?.clangdVersion],
                        ["CMake", toolchain?.cmakeVersion],
                        ["Ninja", toolchain?.ninjaVersion],
                      ].map(([label, version]) => (
                        <div className="onboarding-row" key={label}>
                          <span>{label}</span>
                          <span className={version ? "ok" : "missing"}>
                            {version
                              ? shortVersion(version, "已检测")
                              : "未检测到"}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="onboarding-hint">
                      缺少 clangd / CMake / Ninja 时，可运行
                      <code>scripts/fetch-toolchain.ps1</code>
                      下载到 tools/，或安装 LLVM、CMake、Ninja。
                    </div>
                    <button
                      type="button"
                      className="onboarding-skip"
                      onClick={() => void completeOnboarding()}
                    >
                      跳过引导
                    </button>
                  </div>
                ) : null}
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

      {textPrompt ? (
        <div
          className="palette-backdrop"
          onMouseDown={() => setTextPrompt(null)}
        >
          <div
            className="text-prompt"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="text-prompt-title">{textPrompt.title}</div>
            <input
              className="text-prompt-input"
              autoFocus
              value={textPromptValue}
              onChange={(event) => setTextPromptValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setTextPrompt(null);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const confirm = textPrompt.confirm;
                  const value = textPromptValue;
                  setTextPrompt(null);
                  confirm(value);
                }
              }}
            />
            <div className="text-prompt-actions">
              <button
                type="button"
                className="side-button"
                onClick={() => setTextPrompt(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="side-button primary"
                onClick={() => {
                  const confirm = textPrompt.confirm;
                  const value = textPromptValue;
                  setTextPrompt(null);
                  confirm(value);
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {treeMenu ? (
        <div
          className="context-menu"
          style={{
            left: Math.min(treeMenu.x, window.innerWidth - 190),
            top: Math.min(treeMenu.y, window.innerHeight - 190),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="context-item"
            onClick={() => {
              const base = treeMenu.isDir
                ? treeMenu.path
                : treeMenu.path.replace(/[\\/][^\\/]+$/, "");
              setTreeMenu(null);
              void createEntry("file", base);
            }}
          >
            <FilePlus size={14} /> 新建文件
          </button>
          <button
            type="button"
            className="context-item"
            onClick={() => {
              const base = treeMenu.isDir
                ? treeMenu.path
                : treeMenu.path.replace(/[\\/][^\\/]+$/, "");
              setTreeMenu(null);
              void createEntry("directory", base);
            }}
          >
            <FolderPlus size={14} /> 新建文件夹
          </button>
          <div className="context-separator" />
          <button
            type="button"
            className="context-item"
            onClick={() => {
              const entry: FileEntry = {
                name: treeMenu.path.split(/[\\/]/).pop() ?? treeMenu.path,
                path: treeMenu.path,
                isDir: treeMenu.isDir,
              };
              setTreeMenu(null);
              void renameEntry(entry);
            }}
          >
            <Pencil size={14} /> 重命名
          </button>
          <button
            type="button"
            className="context-item danger"
            onClick={() => {
              const entry: FileEntry = {
                name: treeMenu.path.split(/[\\/]/).pop() ?? treeMenu.path,
                path: treeMenu.path,
                isDir: treeMenu.isDir,
              };
              setTreeMenu(null);
              void deleteEntry(entry);
            }}
          >
            <Trash2 size={14} /> 移入回收站
          </button>
        </div>
      ) : null}

      {paletteOpen ? (
        <div
          className="palette-backdrop"
          onMouseDown={() => setPaletteOpen(false)}
        >
          <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
            <div className="palette-input-row">
              {paletteMode === "files" ? <Files size={15} /> : <Command size={15} />}
              <input
                autoFocus
                value={paletteQuery}
                onChange={(event) => setPaletteQuery(event.target.value)}
                placeholder={
                  paletteMode === "files"
                    ? "按文件名搜索..."
                    : paletteMode === "symbols"
                      ? "搜索工作区符号..."
                      : "输入命令..."
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPaletteOpen(false);
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setPaletteIndex((index) =>
                      Math.min(index + 1, Math.max(0, paletteItemCount - 1)),
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
                    if (paletteMode === "files") {
                      const file = filteredFiles[paletteIndex];
                      if (file) {
                        setPaletteOpen(false);
                        void openFile(file.path);
                      }
                    } else if (paletteMode === "symbols") {
                      const symbol = filteredSymbols[paletteIndex];
                      if (symbol) {
                        setPaletteOpen(false);
                        void openWorkspaceSymbol(symbol);
                      }
                    } else {
                      const command = filteredCommands[paletteIndex];
                      if (command) runCommand(command.id);
                    }
                  }
                }}
              />
            </div>
            <div className="palette-list">
              {paletteItemCount === 0 ? (
                <div className="empty">
                  {paletteMode === "files"
                    ? "没有匹配的文件"
                    : paletteMode === "symbols"
                      ? "没有匹配的符号"
                      : "没有匹配的命令"}
                </div>
              ) : paletteMode === "files" ? (
                filteredFiles.map((file, index) => (
                  <button
                    type="button"
                    key={file.path}
                    className={`palette-item${
                      index === paletteIndex ? " active" : ""
                    }`}
                    onMouseEnter={() => setPaletteIndex(index)}
                    onClick={() => {
                      setPaletteOpen(false);
                      void openFile(file.path);
                    }}
                  >
                    <span className="palette-file">
                      {fileIcon(file.name)}
                      <span>{relativeToRoot(file.path, root)}</span>
                    </span>
                  </button>
                ))
              ) : paletteMode === "symbols" ? (
                filteredSymbols.map((symbol, index) => (
                  <button
                    type="button"
                    key={`${symbol.name}:${index}`}
                    className={`palette-item${
                      index === paletteIndex ? " active" : ""
                    }`}
                    onMouseEnter={() => setPaletteIndex(index)}
                    onClick={() => {
                      setPaletteOpen(false);
                      void openWorkspaceSymbol(symbol);
                    }}
                  >
                    <span className="palette-file">
                      <span>{symbol.name}</span>
                      {symbol.containerName ? (
                        <span className="palette-keybinding">
                          {symbol.containerName}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))
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
