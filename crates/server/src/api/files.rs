use super::*;

pub(super) async fn upload_file(
    State(state): State<AppState>,
    user: CurrentUser,
    mut multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    let mut requested_name: Option<String> = None;
    let mut workspace_id: Option<String> = None;
    let mut payload: Option<(String, Vec<u8>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad(e.to_string()))?
    {
        match field.name() {
            Some("filename") => {
                requested_name = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::bad(e.to_string()))?,
                );
            }
            Some("workspace_id") => {
                workspace_id = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::bad(e.to_string()))?,
                );
            }
            Some("file") => {
                let original = field.file_name().unwrap_or("upload.bin").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::bad(e.to_string()))?;
                payload = Some((original, data.to_vec()));
            }
            _ => {}
        }
    }
    let (original, data) =
        payload.ok_or_else(|| AppError::bad("multipart field `file` required"))?;
    require_csv_filename(&original)?;
    let filename = storage::resolve_upload_filename(&original, requested_name.as_deref());
    require_csv_filename(&filename)?;
    let delimiter_raw = sniff_delimiter(&data).unwrap_or_else(|| ",".into());
    let delimiter = parse_delimiter(&delimiter_raw)?;
    validate_csv(&data, delimiter)?;
    let workspace_id = access::write_workspace(&state.store, &user, workspace_id).await?;
    let meta = state
        .store
        .save_upload(
            &filename,
            &data,
            Some(&delimiter_raw),
            Some(true),
            &workspace_id,
        )
        .await?;
    Ok(Json(json!({
        "id": meta.id,
        "filename": meta.filename,
        "size": meta.size,
        "stored_path": meta.stored_path,
    })))
}

pub(super) async fn stage_spreadsheet(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let mut payload: Option<(String, Vec<u8>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::bad(error.to_string()))?
    {
        if field.name() == Some("file") {
            let original_filename = field
                .file_name()
                .ok_or_else(|| AppError::bad("uploaded spreadsheet needs a filename"))?
                .to_string();
            let bytes = field
                .bytes()
                .await
                .map_err(|error| AppError::bad(error.to_string()))?;
            payload = Some((original_filename, bytes.to_vec()));
        }
    }
    let (original_filename, bytes) =
        payload.ok_or_else(|| AppError::bad("multipart field `file` required"))?;
    let format = spreadsheet_format(FsPath::new(&original_filename))?.to_string();
    let staged = state
        .store
        .stage_spreadsheet(&original_filename, &bytes)
        .await?;
    let path = staged.path.clone();
    let sheets = match tokio::task::spawn_blocking(move || list_sheets(&path)).await {
        Ok(Ok(sheets)) => sheets,
        Ok(Err(error)) => {
            let _ = state.store.delete_stage(&staged.id).await;
            return Err(error.into());
        }
        Err(error) => {
            let _ = state.store.delete_stage(&staged.id).await;
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("spreadsheet task failed: {error}"),
            ));
        }
    };
    if sheets.is_empty() {
        let _ = state.store.delete_stage(&staged.id).await;
        return Err(AppError::bad("spreadsheet contains no worksheets"));
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "staging_id": staged.id,
            "original_filename": staged.original_filename,
            "format": format,
            "sheets": sheets,
        })),
    ))
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CommitSheet {
    pub(super) name: String,
    pub(super) filename: String,
}

struct CommitSpreadsheetBody {
    staging_id: String,
    sheets: Vec<CommitSheet>,
    #[serde(default)]
    delimiter: Option<String>,
    #[serde(default)]
    header: Option<bool>,
    #[serde(default)]
    add_sequence: Option<bool>,
    #[serde(default)]
    workspace_id: Option<String>,
}

pub(super) async fn commit_spreadsheet(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CommitSpreadsheetBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.sheets.is_empty() {
        return Err(AppError::bad("at least one sheet must be selected"));
    }
    let staged = state.store.staged_file(&body.staging_id).await?;
    let selected = normalize_commit_sheets(body.sheets)?;
    let delimiter_raw = body.delimiter.unwrap_or_else(|| ",".into());
    let delimiter = parse_delimiter(&delimiter_raw)?;
    let header = body.header.unwrap_or(true);
    let add_sequence = body.add_sequence.unwrap_or(false);
    let path = staged.path.clone();
    let exports = tokio::task::spawn_blocking(
        move || -> Result<Vec<(String, Vec<u8>)>, connectors::ConnectError> {
            let available: HashSet<String> = list_sheets(&path)?
                .into_iter()
                .map(|sheet| sheet.name)
                .collect();
            let mut exports = Vec::with_capacity(selected.len());
            for sheet in selected {
                if !available.contains(&sheet.name) {
                    return Err(connectors::ConnectError::Invalid(format!(
                        "sheet `{}` not found",
                        sheet.name
                    )));
                }
                let csv = export_sheet_to_csv(&path, &sheet.name, delimiter, header, add_sequence)?;
                exports.push((sheet.filename, csv));
            }
            Ok(exports)
        },
    )
    .await
    .map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("spreadsheet task failed: {error}"),
        )
    })??;

    for (_, bytes) in &exports {
        validate_csv(bytes, delimiter)?;
    }
    state.store.delete_stage(&staged.id).await?;
    let workspace_id = access::write_workspace(&state.store, &user, body.workspace_id).await?;
    let mut files = Vec::with_capacity(exports.len());
    for (filename, bytes) in exports {
        files.push(
            state
                .store
                .save_upload(
                    &filename,
                    &bytes,
                    Some(delimiter_raw.as_str()),
                    Some(header),
                    &workspace_id,
                )
                .await?,
        );
    }
    Ok((StatusCode::CREATED, Json(json!({ "files": files }))))
}

pub(super) async fn cancel_stage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    state.store.delete_stage(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) fn normalize_commit_sheets(
    sheets: Vec<CommitSheet>,
) -> Result<Vec<CommitSheet>, AppError> {
    let mut names = HashSet::new();
    let mut normalized = Vec::with_capacity(sheets.len());
    for sheet in sheets {
        let name = sheet.name.trim();
        if name.is_empty() {
            return Err(AppError::bad("sheet name required"));
        }
        if !names.insert(name.to_string()) {
            return Err(AppError::bad(format!(
                "sheet `{name}` selected more than once"
            )));
        }
        if sheet.filename.trim().is_empty() {
            return Err(AppError::bad("csv filename required"));
        }
        let filename =
            storage::resolve_upload_filename(&format!("{name}.csv"), Some(sheet.filename.trim()));
        require_csv_filename(&filename)?;
        normalized.push(CommitSheet {
            name: name.to_string(),
            filename,
        });
    }
    Ok(normalized)
}

pub(super) fn require_csv_filename(filename: &str) -> Result<(), AppError> {
    let is_csv = FsPath::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"));
    if !is_csv {
        return Err(AppError::bad("only .csv files are accepted"));
    }
    Ok(())
}

pub(super) fn validate_csv(bytes: &[u8], delimiter: u8) -> Result<(), AppError> {
    if bytes.is_empty() {
        return Err(AppError::bad("csv must not be empty"));
    }
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(false)
        .from_reader(bytes);
    let mut expected_width = None;
    let mut row_count = 0usize;
    for record in reader.records() {
        let record = record.map_err(|error| AppError::bad(format!("invalid csv: {error}")))?;
        if record.is_empty() {
            return Err(AppError::bad("csv rows must not be empty"));
        }
        match expected_width {
            Some(width) if width != record.len() => {
                return Err(AppError::bad("csv rows must have a consistent width"));
            }
            None => expected_width = Some(record.len()),
            _ => {}
        }
        row_count += 1;
    }
    if row_count == 0 {
        return Err(AppError::bad("csv must contain at least one row"));
    }
    Ok(())
}

pub(super) async fn list_files(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    let files = state
        .store
        .list_uploads(Some(&user.scope(q.workspace_id)))
        .await?;
    Ok(Json(json!({ "files": files })))
}

pub(super) async fn delete_file(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    access::require_dataset(&state.store, &user, &id).await?;
    state.store.delete_upload(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) async fn preview_file(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    access::require_dataset(&state.store, &user, &id).await?;
    let meta = state.store.get_upload(&id).await?;
    let path = state.store.upload_path(&id).await?;
    let dataset = state.store.get_dataset(&id).await?;
    let stored_delimiter = dataset
        .as_ref()
        .and_then(|row| row.delimiter.clone())
        .filter(|value| !value.trim().is_empty());
    let has_header = dataset
        .as_ref()
        .and_then(|row| row.has_header)
        .map(|value| value != 0)
        .unwrap_or(true);
    let sample = tokio::fs::read(&path)
        .await
        .map_err(|error| AppError::bad(format!("file read failed: {error}")))?;
    let delimiter_raw = stored_delimiter
        .clone()
        .or_else(|| sniff_delimiter(&sample))
        .unwrap_or_else(|| ",".into());
    let delimiter = parse_delimiter(&delimiter_raw)?;
    let limit = query.limit.unwrap_or(200).clamp(1, 1000) as usize;
    let preview = tokio::task::spawn_blocking(move || {
        read_upload_preview(&path, delimiter, has_header, limit)
    })
    .await
    .map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("file preview failed: {error}"),
        )
    })??;
    if stored_delimiter.is_none() {
        if let Ok(columns_json) = serde_json::to_string(&preview.columns) {
            let _ = state
                .store
                .update_dataset_inspect(
                    &id,
                    &columns_json,
                    Some(preview.row_count as i64),
                    Some(&delimiter_raw),
                    Some(has_header),
                    Some(meta.size as i64),
                )
                .await;
        }
    }
    Ok(Json(json!({
        "id": meta.id,
        "filename": meta.filename,
        "stored_path": meta.stored_path,
        "delimiter": delimiter_raw,
        "has_header": has_header,
        "columns": preview.columns,
        "rows": preview.rows,
        "row_count": preview.row_count,
        "truncated": preview.truncated,
    })))
}

struct UploadPreview {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    row_count: u64,
    truncated: bool,
}

pub(super) fn read_upload_preview(
    path: &FsPath,
    delimiter: u8,
    has_header: bool,
    limit: usize,
) -> Result<UploadPreview, AppError> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(has_header)
        .flexible(true)
        .from_path(path)
        .map_err(|error| AppError::bad(format!("invalid csv: {error}")))?;
    let mut columns: Vec<String> = if has_header {
        reader
            .headers()
            .map_err(|error| AppError::bad(format!("invalid csv: {error}")))?
            .iter()
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    let mut rows = Vec::new();
    let mut row_count = 0u64;
    for record in reader.records() {
        let record = record.map_err(|error| AppError::bad(format!("invalid csv: {error}")))?;
        row_count += 1;
        if columns.is_empty() {
            columns = (0..record.len())
                .map(|index| format!("{}", index + 1))
                .collect();
        }
        if rows.len() < limit {
            rows.push(record.iter().map(str::to_string).collect());
        }
    }
    if columns.is_empty() {
        return Err(AppError::bad("csv must contain at least one row"));
    }
    Ok(UploadPreview {
        columns,
        rows,
        row_count,
        truncated: row_count as usize > limit,
    })
}
