import * as monaco from "monaco-editor";
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";

// Monaco 0.57 的 package root 已经注册了 C++ 等基础语言；
// 这里只配置 editor worker，后续再按需裁剪语言包。
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

export { monaco };
