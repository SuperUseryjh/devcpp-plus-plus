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

export interface BuildDiagnostic {
  path: string;
  line: number;
  character: number;
  severity: string;
  message: string;
}

export interface BuildResult {
  success: boolean;
  output: string;
  exitCode: number;
  executable?: string;
  durationMs: number;
  diagnostics: BuildDiagnostic[];
  cancelled: boolean;
}

export interface BuildEvent {
  kind: "started" | "output" | "finished";
  stream?: "stdout" | "stderr";
  text?: string;
}

export interface LspStopped {
  intentional: boolean;
  reason: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  character: number;
  preview: string;
}

export interface FileChangeEvent {
  path: string;
  kind: "create" | "modify" | "remove" | "other";
}

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  minimap: boolean;
  wordWrap: boolean;
}

export interface BuildSettings {
  cxxFlags: string[];
  staticRuntime: boolean;
  externalConsole: boolean;
}

export interface AppSettings {
  schemaVersion: number;
  editor: EditorSettings;
  build: BuildSettings;
  trustedWorkspaces: string[];
  onboardingCompleted: boolean;
}
