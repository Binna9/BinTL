use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest.join("../../ui/dist");
    if !dist.join("index.html").exists() {
        let _ = fs::create_dir_all(&dist);
        let _ = fs::write(
            dist.join("index.html"),
            "<!doctype html><title>BinTL</title><p>UI not built. Run <code>just ui</code>.</p>\n",
        );
    }
    println!("cargo:rerun-if-changed=../../ui/dist");
}
