import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc/browser";
import type { LspInfo } from "../types";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: number;
  textEdit?:
    | TextEdit
    | { insert: Range; replace: Range; newText: string };
  sortText?: string;
  filterText?: string;
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  deprecated?: boolean;
}

export interface CompletionList {
  isIncomplete?: boolean;
  items: CompletionItem[];
}

export interface Hover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: Range;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetSelectionRange: Range;
  targetRange?: Range;
  originSelectionRange?: Range;
}

class WebSocketReader extends AbstractMessageReader implements MessageReader {
  private cleanups: Array<() => void> = [];

  constructor(private readonly ws: WebSocket) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    const onMessage = (event: MessageEvent) => {
      try {
        callback(JSON.parse(String(event.data)) as Message);
      } catch (error) {
        this.fireError(error);
      }
    };
    const onClose = () => this.fireClose();
    const onError = () => this.fireClose();

    this.ws.addEventListener("message", onMessage);
    this.ws.addEventListener("close", onClose);
    this.ws.addEventListener("error", onError);
    this.cleanups = [
      () => this.ws.removeEventListener("message", onMessage),
      () => this.ws.removeEventListener("close", onClose),
      () => this.ws.removeEventListener("error", onError),
    ];
    return {
      dispose: () => {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
      },
    };
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    super.dispose();
  }
}

class WebSocketWriter extends AbstractMessageWriter implements MessageWriter {
  constructor(private readonly ws: WebSocket) {
    super();
  }

  write(message: Message): Promise<void> {
    try {
      if (this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("LSP WebSocket 已关闭");
      }
      this.ws.send(JSON.stringify(message));
      return Promise.resolve();
    } catch (error) {
      this.fireError(error, message);
      return Promise.reject(error);
    }
  }

  end(): void {
    // LspClient.dispose() owns the WebSocket close.
  }
}

export type DiagnosticsHandler = (uri: string, diagnostics: Diagnostic[]) => void;

export class LspClient {
  private readonly diagnosticsHandlers = new Set<DiagnosticsHandler>();
  private disposed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly connection: MessageConnection,
    private readonly rootUri: string,
    private readonly workspaceName: string,
  ) {}

  static async connect(info: LspInfo, root: string): Promise<LspClient> {
    const url = `ws://127.0.0.1:${info.port}/lsp?token=${encodeURIComponent(
      info.token,
    )}`;
    const ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("连接 clangd LSP 超时"));
      }, 10_000);
      ws.addEventListener(
        "open",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          window.clearTimeout(timer);
          reject(new Error("无法连接 clangd LSP WebSocket"));
        },
        { once: true },
      );
    });

    const reader = new WebSocketReader(ws);
    const writer = new WebSocketWriter(ws);
    const connection = createMessageConnection(reader, writer, {
      error: (message: string) => console.error("[lsp]", message),
      warn: (message: string) => console.warn("[lsp]", message),
      info: (message: string) => console.info("[lsp]", message),
      log: (message: string) => console.log("[lsp]", message),
    });

    const rootUri = fileUri(root);
    const workspaceName =
      root.split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
    const client = new LspClient(ws, connection, rootUri, workspaceName);
    client.registerServerHandlers();
    connection.listen();
    await client.initialize();
    return client;
  }

  private registerServerHandlers(): void {
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics?: Diagnostic[] }) => {
        const diagnostics = params.diagnostics ?? [];
        for (const handler of this.diagnosticsHandlers) {
          handler(params.uri, diagnostics);
        }
      },
    );

    this.connection.onNotification(
      "window/showMessage",
      (params: { type?: number; message?: string }) => {
        console.log("[clangd]", params.message ?? params);
      },
    );

    this.connection.onNotification(
      "window/logMessage",
      (params: { message?: string }) => {
        console.log("[clangd]", params.message ?? params);
      },
    );

    this.connection.onNotification(
      "textDocument/clangd.fileStatus",
      (params: unknown) => {
        console.log("[clangd]", params);
      },
    );

    this.connection.onRequest("workspace/configuration", () => [{}]);
    this.connection.onRequest(
      "workspace/workspaceFolders",
      () => [{ uri: this.rootUri, name: this.workspaceName }],
    );
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("client/unregisterCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("window/showMessageRequest", () => null);
    this.connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "P0 暂不支持 workspace/applyEdit",
    }));
  }

  private async initialize(): Promise<void> {
    const result = await this.connection.sendRequest<{
      capabilities?: unknown;
    }>("initialize", {
      processId: null,
      clientInfo: { name: "DevCpp++", version: "0.1.0" },
      rootUri: this.rootUri,
      workspaceFolders: [
        { uri: this.rootUri, name: this.workspaceName },
      ],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: {
          applyEdit: true,
          workspaceEdit: { documentChanges: true },
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceFolders: { supported: true, changeNotifications: true },
          configuration: false,
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            didSave: true,
          },
          completion: {
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: {
                properties: [
                  "documentation",
                  "detail",
                  "additionalTextEdits",
                ],
              },
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true },
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["quickfix", "refactor", "source"],
              },
            },
          },
          formatting: {},
          signatureHelp: {},
        },
      },
      initializationOptions: { clangdFileStatus: true },
    });

    console.log("[lsp] initialize result", result);
    await this.connection.sendNotification("initialized", {});
  }

  onDiagnostics(handler: DiagnosticsHandler): Disposable {
    this.diagnosticsHandlers.add(handler);
    return {
      dispose: () => this.diagnosticsHandlers.delete(handler),
    };
  }

  didOpen(uri: string, languageId: string, text: string): void {
    void this.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didChange(
    uri: string,
    version: number,
    changes: Array<{ range: Range; rangeLength?: number; text: string }>,
  ): void {
    void this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: changes,
    });
  }

  didClose(uri: string): void {
    void this.connection.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  async completion(
    uri: string,
    line: number,
    character: number,
  ): Promise<CompletionList | CompletionItem[]> {
    const result = await this.connection.sendRequest<
      CompletionList | CompletionItem[] | null
    >("textDocument/completion", {
      textDocument: { uri },
      position: { line, character },
    });
    return result ?? [];
  }

  async hover(
    uri: string,
    line: number,
    character: number,
  ): Promise<Hover | null> {
    return this.connection.sendRequest<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async definition(
    uri: string,
    line: number,
    character: number,
  ): Promise<
    Location | LocationLink | Array<Location | LocationLink> | null
  > {
    return this.connection.sendRequest<
      Location | LocationLink | Array<Location | LocationLink> | null
    >("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.diagnosticsHandlers.clear();
    try {
      this.connection.dispose();
    } catch {
      // ignore
    }
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

export function fileUri(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (/^\/[a-zA-Z]:/.test(normalized)) {
    normalized = `/${normalized[1].toUpperCase()}${normalized.slice(2)}`;
  }
  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/");
  return `file://${encoded}`;
}

export function uriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    return path.replace(/\//g, "\\");
  } catch {
    return uri;
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
