use std::path::{Path, PathBuf};

use crate::{resolve_upload_filename, safe_filename, StorageError};

pub const REL_CHIP_OUTPUTS: &str = "chip_outputs";

pub fn is_slot_rel(rel: &str) -> bool {
    rel.starts_with(REL_CHIP_OUTPUTS) && rel.as_bytes().get(REL_CHIP_OUTPUTS.len()) == Some(&b'/')
}

/// Sibling of `current.*` so a failed run cannot truncate the last success.
pub fn staging_rel(final_rel: &str, run_id: &str) -> Result<String, StorageError> {
    let run_id = safe_filename(run_id);
    if run_id.is_empty() {
        return Err(StorageError::Invalid("staging run id required".into()));
    }
    Ok(format!("{final_rel}.{run_id}.tmp"))
}

pub fn write_rel(final_rel: &str, run_id: &str) -> Result<String, StorageError> {
    if is_slot_rel(final_rel) {
        staging_rel(final_rel, run_id)
    } else {
        Ok(final_rel.to_string())
    }
}

/// Atomically replace `dest` on Unix. Do not unlink `dest` first.
pub fn publish(staging: &Path, dest: &Path) -> Result<(), StorageError> {
    std::fs::rename(staging, dest)?;
    Ok(())
}

/// Removes leftover `*.tmp` under `chip_outputs/{workspace}/{chip}/`.
pub fn sweep_tmp(chip_outputs: &Path) {
    let Ok(workspaces) = std::fs::read_dir(chip_outputs) else {
        return;
    };
    for workspace in workspaces.flatten() {
        let Ok(file_type) = workspace.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(chips) = std::fs::read_dir(workspace.path()) else {
            continue;
        };
        for chip in chips.flatten() {
            let Ok(file_type) = chip.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(chip.path()) else {
                continue;
            };
            for file in files.flatten() {
                let name = file.file_name();
                if name.to_string_lossy().ends_with(".tmp") {
                    let _ = std::fs::remove_file(file.path());
                }
            }
        }
    }
}

pub struct StagingFile {
    path: PathBuf,
    keep: bool,
}

impl StagingFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for StagingFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub fn stored_rel(
    workspace_id: &str,
    chip_id: &str,
    filename: &str,
) -> Result<String, StorageError> {
    let filename = safe_filename(filename);
    if filename.is_empty() {
        return Err(StorageError::Invalid(
            "chip output filename required".into(),
        ));
    }
    Ok(format!(
        "{REL_CHIP_OUTPUTS}/{workspace_id}/{chip_id}/{filename}"
    ))
}

pub fn extract_ext(delimiter: &str) -> &'static str {
    match delimiter {
        "tab" | "\\t" | "\t" => "tsv",
        "," => "csv",
        _ => "txt",
    }
}

pub fn display_filename(chip_name: &str, kind: &str, delimiter: &str) -> String {
    match kind {
        "extract" => {
            let ext = extract_ext(delimiter);
            resolve_upload_filename(&format!("out.{ext}"), Some(chip_name))
        }
        "transform" | "script" => resolve_upload_filename("result.parquet", Some(chip_name)),
        _ => safe_filename(chip_name),
    }
}

pub fn slot_file_name(kind: &str, delimiter: &str) -> String {
    match kind {
        "extract" => format!("current.{}", extract_ext(delimiter)),
        "transform" | "script" => "current.parquet".into(),
        other => format!("current.{other}"),
    }
}

pub fn standalone_export_filename(requested: Option<&str>, table: &str, delimiter: &str) -> String {
    let ext = extract_ext(delimiter);
    let fallback = format!("{}.{}", safe_filename(&table.replace('.', "_")), ext);
    resolve_upload_filename(&fallback, requested)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_filename_uses_chip_name() {
        assert_eq!(
            display_filename("매출 추출", "extract", ","),
            "매출 추출.csv"
        );
        assert_eq!(
            display_filename("Clean sales", "transform", ","),
            "Clean sales.parquet"
        );
        assert_eq!(display_filename("logic", "script", ","), "logic.parquet");
        assert_eq!(
            display_filename("transform-SYS.DR$UDEF_PREFERENCE.csv", "transform", ","),
            "transform-SYS.DR$UDEF_PREFERENCE.csv"
        );
    }

    #[test]
    fn standalone_export_respects_requested_name() {
        assert_eq!(
            standalone_export_filename(Some("sales"), "public.users", ","),
            "sales.csv"
        );
        assert_eq!(
            standalone_export_filename(None, "public.users", "tab"),
            "public_users.tsv"
        );
    }

    #[test]
    fn failed_staging_keeps_current() {
        let root = std::env::temp_dir().join(format!("bintl-slot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let dest = root.join("current.csv");
        std::fs::write(&dest, b"good").unwrap();
        assert_eq!(
            staging_rel("chip_outputs/ws/c/current.csv", "run-1").unwrap(),
            "chip_outputs/ws/c/current.csv.run-1.tmp"
        );
        assert_eq!(
            write_rel("extract_runs/databases/id/out.csv", "run-1").unwrap(),
            "extract_runs/databases/id/out.csv"
        );
        let staging_path = root.join("current.csv.run-1.tmp");
        let staging = StagingFile::new(staging_path.clone());
        std::fs::write(staging.path(), b"partial").unwrap();
        drop(staging);
        assert_eq!(std::fs::read(&dest).unwrap(), b"good");
        assert!(!staging_path.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn publish_replaces_current() {
        let root = std::env::temp_dir().join(format!("bintl-slot-pub-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let dest = root.join("current.parquet");
        std::fs::write(&dest, b"old").unwrap();
        let staging_path = root.join("current.parquet.run.tmp");
        let mut staging = StagingFile::new(staging_path.clone());
        std::fs::write(staging.path(), b"new").unwrap();
        publish(staging.path(), &dest).unwrap();
        staging.keep();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(!staging_path.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sweep_tmp_leaves_current() {
        let root = std::env::temp_dir().join(format!("bintl-slot-sweep-{}", uuid::Uuid::new_v4()));
        let chip = root.join("ws").join("chip");
        std::fs::create_dir_all(&chip).unwrap();
        std::fs::write(chip.join("current.csv"), b"good").unwrap();
        std::fs::write(chip.join("current.csv.run.tmp"), b"partial").unwrap();
        sweep_tmp(&root);
        assert_eq!(std::fs::read(chip.join("current.csv")).unwrap(), b"good");
        assert!(!chip.join("current.csv.run.tmp").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
