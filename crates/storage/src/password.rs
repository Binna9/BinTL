use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

use crate::StorageError;

pub fn hash_password(password: &str) -> Result<String, StorageError> {
    let password = password.trim();
    if password.is_empty() {
        return Err(StorageError::Invalid("password required".into()));
    }
    if password.len() < 4 {
        return Err(StorageError::Invalid("password must be at least 4 characters".into()));
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| StorageError::Invalid(format!("password hash failed: {error}")))
}

pub fn verify_password(password: &str, password_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(password_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}
