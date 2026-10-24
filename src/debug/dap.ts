export interface DapInfo {
  port: number;
  token: string;
  gdbPath: string;
}

export interface DapSource {
  name?: string;
  path?: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DapResponse {
  seq: number;
  type: "response";
  request_seq: number;
  command: string;
  success: boolean;
  message?: string;
  body?: Record<string, unknown>;
}

export interface DapEvent {
  seq: number;
  type: "event";
  event: string;
  body?: Record<string, unknown>;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
};

export class DapClient {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Set<(event: DapEvent) => void>();
  private disposed = false;

  private constructor(private readonly ws: WebSocket) {}

  static async connect(info: DapInfo): Promise<DapClient> {
    const url = `ws://127.0.0.1:${info.port}/dap?token=${encodeURIComponent(
      info.token,
    )}`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("连接 gdb DAP 超时"));
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
          reject(new Error("无法连接 gdb DAP WebSocket"));
        },
        { once: true },
      );
    });
    const client = new DapClient(ws);
    ws.addEventListener("message", (event) => client.handleMessage(event.data));
    ws.addEventListener("close", () => client.rejectAll("调试连接已关闭"));
    return client;
  }

  request<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("调试连接已关闭"));
    const seq = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`调试请求超时: ${command}`));
      }, 15_000);
      this.pending.set(seq, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.ws.send(
        JSON.stringify({ seq, type: "request", command, arguments: args }),
      );
    });
  }

  onEvent(handler: (event: DapEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll("调试连接已关闭");
    this.ws.close();
    this.eventHandlers.clear();
  }

  private handleMessage(raw: unknown): void {
    let message: DapResponse | DapEvent;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.pending.delete(message.request_seq);
      if (message.success) {
        pending.resolve(message.body ?? {});
      } else {
        pending.reject(
          new Error(message.message || `调试请求失败: ${message.command}`),
        );
      }
      return;
    }
    if (message.type === "event") {
      for (const handler of this.eventHandlers) handler(message);
    }
  }

  private rejectAll(reason: string): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

export function waitForDapEvent(
  client: DapClient,
  eventName: string,
  timeoutMs = 10_000,
): Promise<DapEvent> {
  let dispose: () => void = () => undefined;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      dispose();
      reject(new Error(`等待调试事件超时: ${eventName}`));
    }, timeoutMs);
    dispose = client.onEvent((event) => {
      if (event.event !== eventName) return;
      window.clearTimeout(timer);
      dispose();
      resolve(event);
    });
  });
}
