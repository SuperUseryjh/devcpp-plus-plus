export type EditorLanguage = "cpp" | "c" | "cmake" | "plaintext";

export function languageForPath(path: string): EditorLanguage {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "cmakelists.txt" || name.endsWith(".cmake")) {
    return "cmake";
  }
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1) : "";
  if (extension === "c") return "c";
  if (
    [
      "cpp",
      "cc",
      "cxx",
      "c++",
      "h",
      "hpp",
      "hh",
      "hxx",
      "h++",
      "ipp",
      "inl",
    ].includes(extension)
  ) {
    return "cpp";
  }
  return "plaintext";
}

export function isLspLanguage(language: EditorLanguage): boolean {
  return language === "cpp" || language === "c";
}
