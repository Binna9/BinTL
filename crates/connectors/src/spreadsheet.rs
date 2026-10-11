use std::path::Path;

use calamine::{open_workbook_auto, Reader};
use serde::Serialize;

use crate::extract::{with_sequence, with_sequence_header, COLON_PIPE};
use crate::ConnectError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SheetInfo {
    pub index: usize,
    pub name: String,
}

pub fn spreadsheet_format(path: &Path) -> Result<&'static str, ConnectError> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("xls") => Ok("xls"),
        Some("xlsx") => Ok("xlsx"),
        _ => Err(ConnectError::Invalid(
            "spreadsheet must have an .xls or .xlsx extension".into(),
        )),
    }
}

pub fn list_sheets(path: &Path) -> Result<Vec<SheetInfo>, ConnectError> {
    spreadsheet_format(path)?;
    let workbook =
        open_workbook_auto(path).map_err(|error| ConnectError::Spreadsheet(error.to_string()))?;
    Ok(workbook
        .sheet_names()
        .iter()
        .enumerate()
        .map(|(index, name)| SheetInfo {
            index,
            name: name.clone(),
        })
        .collect())
}

pub fn export_sheet_to_csv(
    path: &Path,
    sheet_name: &str,
    delimiter: u8,
    header: bool,
    add_sequence: bool,
) -> Result<Vec<u8>, ConnectError> {
    let range_rows = sheet_rows(path, sheet_name)?;
    let mut writer = csv::WriterBuilder::new()
        .delimiter(delimiter)
        .from_writer(Vec::new());
    for (index, cells) in range_rows.into_iter().enumerate() {
        write_csv_record(&mut writer, index, cells, header, add_sequence)?;
    }
    writer
        .into_inner()
        .map_err(|error| ConnectError::Io(error.into_error()))
}

pub fn export_sheet_colon_pipe(
    path: &Path,
    sheet_name: &str,
    header: bool,
    add_sequence: bool,
) -> Result<Vec<u8>, ConnectError> {
    let rows = sheet_rows(path, sheet_name)?;
    let mut out = Vec::new();
    for (index, cells) in rows.into_iter().enumerate() {
        let cells = sequenced_cells(index, cells, header, add_sequence);
        push_colon_pipe_record(&mut out, &cells)?;
    }
    Ok(out)
}

fn sheet_rows(path: &Path, sheet_name: &str) -> Result<Vec<Vec<String>>, ConnectError> {
    spreadsheet_format(path)?;
    let mut workbook =
        open_workbook_auto(path).map_err(|error| ConnectError::Spreadsheet(error.to_string()))?;
    if !workbook.sheet_names().iter().any(|name| name == sheet_name) {
        return Err(ConnectError::Invalid(format!(
            "sheet `{sheet_name}` not found"
        )));
    }
    let range = workbook
        .worksheet_range(sheet_name)
        .map_err(|error| ConnectError::Spreadsheet(error.to_string()))?;
    Ok(range
        .rows()
        .map(|row| row.iter().map(ToString::to_string).collect())
        .collect())
}

fn sequenced_cells(
    index: usize,
    cells: Vec<String>,
    header: bool,
    add_sequence: bool,
) -> Vec<String> {
    if header && index == 0 {
        with_sequence_header(add_sequence, cells)
    } else {
        let seq = if header {
            index as u64
        } else {
            index as u64 + 1
        };
        with_sequence(add_sequence, seq, cells)
    }
}

fn write_csv_record(
    writer: &mut csv::Writer<Vec<u8>>,
    index: usize,
    cells: Vec<String>,
    header: bool,
    add_sequence: bool,
) -> Result<(), ConnectError> {
    writer.write_record(&sequenced_cells(index, cells, header, add_sequence))?;
    Ok(())
}

fn push_colon_pipe_record(out: &mut Vec<u8>, cells: &[String]) -> Result<(), ConnectError> {
    for (index, cell) in cells.iter().enumerate() {
        if cell.contains(COLON_PIPE) || cell.contains('\n') || cell.contains('\r') {
            return Err(ConnectError::Invalid(
                "`:||` cannot be used when a cell contains that delimiter or a line break".into(),
            ));
        }
        if index > 0 {
            out.extend_from_slice(COLON_PIPE.as_bytes());
        }
        out.extend_from_slice(cell.as_bytes());
    }
    out.push(b'\n');
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    use super::*;

    fn test_workbook() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "bintl-spreadsheet-{}-{nonce}.xlsx",
            std::process::id()
        ));
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default();
        let parts = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>alpha</t></is></c><c r="B2"><v>1</v></c></row>
  </sheetData>
</worksheet>"#,
            ),
        ];
        for (name, contents) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn accepts_supported_extensions_case_insensitively() {
        assert_eq!(spreadsheet_format(Path::new("book.xls")).unwrap(), "xls");
        assert_eq!(spreadsheet_format(Path::new("book.XLSX")).unwrap(), "xlsx");
        assert!(spreadsheet_format(Path::new("book.csv")).is_err());
    }

    #[test]
    fn reads_and_exports_an_xlsx_sheet() {
        let path = test_workbook();
        let sheets = list_sheets(&path).unwrap();
        assert_eq!(
            sheets,
            vec![SheetInfo {
                index: 0,
                name: "Sales".into(),
            }]
        );
        let csv = export_sheet_to_csv(&path, "Sales", b',', true, false).unwrap();
        assert_eq!(String::from_utf8(csv).unwrap(), "name,value\nalpha,1\n");
        let sequenced = export_sheet_to_csv(&path, "Sales", b',', true, true).unwrap();
        assert_eq!(
            String::from_utf8(sequenced).unwrap(),
            "#,name,value\n1,alpha,1\n"
        );
        let piped = export_sheet_to_csv(&path, "Sales", b'|', true, false).unwrap();
        assert_eq!(String::from_utf8(piped).unwrap(), "name|value\nalpha|1\n");
        let colon_pipe = export_sheet_colon_pipe(&path, "Sales", true, false).unwrap();
        assert_eq!(
            String::from_utf8(colon_pipe).unwrap(),
            "name:||value\nalpha:||1\n"
        );
        std::fs::remove_file(path).unwrap();
    }
}
