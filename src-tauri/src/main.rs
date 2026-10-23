// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--external-runner") {
        std::process::exit(devcpp_plus_plus_lib::run_external_runner(&args[2..]));
    }
    devcpp_plus_plus_lib::run()
}
