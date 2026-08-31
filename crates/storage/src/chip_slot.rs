use crate::{resolve_upload_filename, safe_filename, StorageError};

pub const REL_CHIP_OUTPUTS: &str = "chip_outputs";

pub fn stored_rel(workspace_id: &str, chip_id: &str, filename: &str) -> Result<String, StorageError> {
    let filename = safe_filename(filename);
    if filename.is_empty() {
        return Err(StorageError::Invalid("chip output filename required".into()));
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
        "transform" => resolve_upload_filename("result.parquet", Some(chip_name)),
        _ => safe_filename(chip_name),
    }
}

pub fn slot_file_name(kind: &str, delimiter: &str) -> String {
    match kind {
        "extract" => format!("current.{}", extract_ext(delimiter)),
        "transform" => "current.parquet".into(),
        other => format!("current.{other}"),
    }
}

pub fn standalone_export_filename(
    requested: Option<&str>,
    table: &str,
    delimiter: &str,
) -> String {
    let ext = extract_ext(delimiter);
    let fallback = format!(
        "{}.{}",
        safe_filename(&table.replace('.', "_")),
        ext
    );
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
}
