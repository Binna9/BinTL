use std::path::PathBuf;

use super::{StorageError, Store, REL_USER_IMAGES};

pub const DEFAULT_USER_IMAGE_REL: &str = "user_images/default-image";
const DEFAULT_USER_IMAGE_PNG: &[u8] = include_bytes!("../assets/default-image.png");
const MAX_AVATAR_BYTES: usize = 512_000;

pub async fn ensure_default_user_image(data_dir: &std::path::Path) -> Result<(), StorageError> {
    let dest = data_dir.join(REL_USER_IMAGES).join("default-image");
    tokio::fs::write(dest, DEFAULT_USER_IMAGE_PNG).await?;
    Ok(())
}

pub fn decode_image_data_url(value: &str) -> Result<(Vec<u8>, &'static str), StorageError> {
    let (meta, data) = value
        .split_once(',')
        .ok_or_else(|| StorageError::Invalid("invalid profile image".into()))?;
    let ext = if meta.contains("image/png") {
        "png"
    } else if meta.contains("image/webp") {
        "webp"
    } else if meta.contains("image/jpeg") || meta.contains("image/jpg") {
        "jpg"
    } else {
        return Err(StorageError::Invalid("invalid profile image".into()));
    };
    let bytes = decode_base64(data)?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES {
        return Err(StorageError::Invalid("invalid profile image".into()));
    }
    Ok((bytes, ext))
}

impl Store {
    pub fn user_avatar_url(user_id: &str, updated_at: &str) -> String {
        format!("/api/users/{user_id}/avatar?v={updated_at}")
    }

    pub fn avatar_disk_path(&self, stored: Option<&str>) -> PathBuf {
        match stored {
            Some(path) if path.starts_with("user_images/") => self.resolve(path),
            _ => self.resolve(DEFAULT_USER_IMAGE_REL),
        }
    }

    pub async fn save_user_avatar_data_url(
        &self,
        user_id: &str,
        data_url: &str,
    ) -> Result<String, StorageError> {
        let user_id = user_id.trim();
        if user_id.is_empty() || user_id.contains('/') || user_id.contains('\\') {
            return Err(StorageError::Invalid("invalid user id".into()));
        }
        let (bytes, ext) = decode_image_data_url(data_url)?;
        let dir_rel = format!("{REL_USER_IMAGES}/{user_id}");
        let dir = self.resolve(&dir_rel);
        tokio::fs::create_dir_all(&dir).await?;
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_file() {
                tokio::fs::remove_file(entry.path()).await?;
            }
        }
        let rel = format!("{dir_rel}/avatar.{ext}");
        tokio::fs::write(self.resolve(&rel), bytes).await?;
        Ok(rel)
    }

    pub async fn read_avatar_bytes(&self, stored: Option<&str>) -> Result<(Vec<u8>, &'static str), StorageError> {
        if let Some(data_url) = stored.filter(|value| value.starts_with("data:image/")) {
            let (bytes, ext) = decode_image_data_url(data_url)?;
            return Ok((bytes, mime_for_ext(ext)));
        }
        let path = self.avatar_disk_path(stored);
        match tokio::fs::read(&path).await {
            Ok(bytes) if !bytes.is_empty() => Ok((bytes, mime_for_path(&path))),
            _ => Ok((
                tokio::fs::read(self.resolve(DEFAULT_USER_IMAGE_REL))
                    .await
                    .unwrap_or_else(|_| DEFAULT_USER_IMAGE_PNG.to_vec()),
                "image/png",
            )),
        }
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => "image/png",
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, StorageError> {
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == b'=' {
            break;
        }
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(StorageError::Invalid("invalid profile image".into())),
        } as u32;
        buf = (buf << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buf >> bits) as u8);
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::decode_image_data_url;

    #[test]
    fn decodes_png_data_url() {
        let (bytes, ext) = decode_image_data_url(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        )
        .unwrap();
        assert_eq!(ext, "png");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}
