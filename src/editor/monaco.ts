import * as monaco from "monaco-editor";
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";

// Monaco 0.57 的 package root 已经注册了 C/C++ 等基础语言；
// 这里只配置 editor worker，并补一个轻量 CMake 语法高亮。
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

monaco.languages.register({
  id: "cmake",
  extensions: [".cmake"],
  filenames: ["CMakeLists.txt"],
  aliases: ["CMake", "cmake"],
});

monaco.languages.setLanguageConfiguration("cmake", {
  comments: { lineComment: "#" },
  brackets: [
    ["(", ")"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
  ],
});

monaco.languages.setMonarchTokensProvider("cmake", {
  keywords: [
    "cmake_minimum_required",
    "project",
    "add_executable",
    "add_library",
    "add_subdirectory",
    "target_link_libraries",
    "target_include_directories",
    "target_compile_features",
    "target_compile_options",
    "target_compile_definitions",
    "set",
    "unset",
    "if",
    "elseif",
    "else",
    "endif",
    "foreach",
    "endforeach",
    "while",
    "endwhile",
    "function",
    "endfunction",
    "macro",
    "endmacro",
    "include",
    "find_package",
    "install",
    "message",
    "option",
    "file",
    "list",
    "string",
    "math",
    "return",
    "break",
    "continue",
    "enable_testing",
    "add_test",
  ],
  constants: ["ON", "OFF", "TRUE", "FALSE", "YES", "NO", "DEBUG", "RELEASE"],
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/\$\{[^}]*\}/, "variable"],
      [/\b[A-Za-z_][A-Za-z0-9_]*\b/, {
        cases: {
          "@keywords": "keyword",
          "@constants": "constant",
          "@default": "identifier",
        },
      }],
      [/\b\d+(\.\d+)?\b/, "number"],
      [/[()[\]]/, "@brackets"],
    ],
  },
});

export { monaco };
