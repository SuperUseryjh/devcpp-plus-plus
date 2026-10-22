fn main() {
    #[cfg(windows)]
    {
        // 同一份清单同时链接进 bin 和 unit-test 二进制：
        // - cargo test 的 test harness 也依赖 Common Controls v6（TaskDialogIndirect）
        // - tauri-build 只处理 bin，因此关闭它自带的清单，避免资源重复
        let manifest = std::fs::canonicalize("app.manifest")
            .expect("app.manifest must exist in src-tauri");
        println!("cargo:rerun-if-changed=app.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest.display()
        );
        println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");

        let attributes = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        );
        tauri_build::try_build(attributes).expect("failed to run tauri build script");
    }

    #[cfg(not(windows))]
    tauri_build::build()
}
