use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use sha2::{Digest, Sha256};

use crate::StorageError;

pub fn key_from_secret(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

pub fn encrypt(key: &[u8; 32], plaintext: &str) -> Result<String, StorageError> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|e| StorageError::Invalid(e.to_string()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| StorageError::Invalid(e.to_string()))?;
    Ok(format!("{}{}", hex::encode(nonce_bytes), hex::encode(ct)))
}

pub fn decrypt(key: &[u8; 32], packed: &str) -> Result<String, StorageError> {
    if packed.len() < 24 {
        return Err(StorageError::Invalid("bad password_cipher".into()));
    }
    let nonce_bytes = hex::decode(&packed[..24])
        .map_err(|_| StorageError::Invalid("bad password_cipher".into()))?;
    let ct = hex::decode(&packed[24..])
        .map_err(|_| StorageError::Invalid("bad password_cipher".into()))?;
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);
    let pt = cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|_| StorageError::Invalid("cannot decrypt password (session_secret mismatch?)".into()))?;
    String::from_utf8(pt).map_err(|_| StorageError::Invalid("password not utf-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = key_from_secret("change-me");
        let packed = encrypt(&key, "hunter2").unwrap();
        assert_eq!(decrypt(&key, &packed).unwrap(), "hunter2");
        assert!(decrypt(&key_from_secret("other"), &packed).is_err());
    }
}
