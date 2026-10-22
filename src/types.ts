export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileData {
  path: string;
  content: string;
  encoding: string;
  eol: "lf" | "crlf" | string;
}

export interface WorkspaceInfo {
  root: string;
  compileCommandsDir: string | null;
  sources: number;
}

export interface ToolchainInfo {
  gxx?: string;
  gdb?: string;
  clangd?: string;
  cmake?: string;
  ninja?: string;
  gxxVersion?: string;
  clangdVersion?: string;
  cmakeVersion?: string;
  ninjaVersion?: string;
}

export interface LspInfo {
  port: number;
  token: string;
  clangdPath: string;
  gxxPath: string;
}

export interface BuildResult {
  success: boolean;
  output: string;
  exitCode: number;
  executable?: string;
  durationMs: number;
}
