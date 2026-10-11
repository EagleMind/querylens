fn main() {
    // The headless CLI (`--no-default-features`) has no Tauri context to generate.
    if std::env::var_os("CARGO_FEATURE_GUI").is_some() {
        tauri_build::build()
    }
}
