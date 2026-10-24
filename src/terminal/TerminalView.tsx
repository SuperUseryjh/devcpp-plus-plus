import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalView({ root }: { root: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "Consolas, 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#aeafad",
        selectionBackground: "#264f78",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const fitAndResize = () => {
      try {
        fit.fit();
        void invoke("resize_terminal", {
          rows: term.rows,
          cols: term.cols,
        }).catch(() => undefined);
      } catch {
        // The host may not have a layout size during startup.
      }
    };
    fitAndResize();
    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(host);
    const dataSubscription = term.onData((data) => {
      void invoke("write_terminal", { data }).catch(() => undefined);
    });
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<string>("terminal:data", (event) => term.write(event.payload)),
      listen("terminal:exit", () => {
        term.write("\r\n[终端已退出]\r\n");
      }),
    ]).then((dispose) => {
      if (disposed) {
        for (const item of dispose) item();
      } else {
        unlisteners.push(...dispose);
      }
    });
    void invoke("start_terminal", { root })
      .then(() => {
        fitAndResize();
        term.focus();
      })
      .catch((error) => {
        term.write(`\r\n[启动终端失败] ${String(error)}\r\n`);
      });
    return () => {
      disposed = true;
      dataSubscription.dispose();
      resizeObserver.disconnect();
      for (const unlisten of unlisteners) unlisten();
      void invoke("stop_terminal").catch(() => undefined);
      term.dispose();
    };
  }, [root]);

  return <div className="terminal-host" ref={hostRef} />;
}
