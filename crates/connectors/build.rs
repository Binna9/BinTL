fn main() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let homebrew = std::env::var("HOMEBREW_PREFIX").unwrap_or_else(|_| "/opt/homebrew".into());
    let lib = format!("{homebrew}/lib");
    if std::path::Path::new(&lib).exists() {
        println!("cargo:rustc-link-search=native={lib}");
    }
    if std::path::Path::new("/usr/local/lib").exists() {
        println!("cargo:rustc-link-search=native=/usr/local/lib");
    }
}
