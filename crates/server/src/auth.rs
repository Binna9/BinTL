use axum::extract::Request;
use axum::extract::State;
use axum::middleware::Next;
use axum::response::Response;
use hmac::{Hmac, Mac};
use axum::http::header::COOKIE;
use sha2::Sha256;

use crate::error::AppError;
use crate::state::AppState;

type HmacSha256 = Hmac<Sha256>;

const COOKIE_NAME: &str = "session";

pub fn sign(secret: &str, username: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(username.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());
    format!("{username}.{sig}")
}

pub fn verify(secret: &str, cookie: &str) -> Option<String> {
    let (username, sig) = cookie.rsplit_once('.')?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(username.as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    if expected.len() != sig.len() {
        return None;
    }
    // constant-ish compare via hmac verify on decoded bytes
    let Ok(got) = hex::decode(sig) else {
        return None;
    };
    let Ok(exp) = hex::decode(&expected) else {
        return None;
    };
    if got.len() != exp.len() || !constant_eq(&got, &exp) {
        return None;
    }
    Some(username.to_string())
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

pub fn session_cookie(secret: &str, username: &str) -> String {
    let value = sign(secret, username);
    format!("{COOKIE_NAME}={value}; HttpOnly; Path=/; SameSite=Lax")
}

pub fn clear_cookie() -> String {
    format!("{COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0")
}

fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        if k.trim() == name {
            Some(v.trim().to_string())
        } else {
            None
        }
    })
}

pub async fn require_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    if state.config.skip_auth {
        return Ok(next.run(request).await);
    }
    let header = request
        .headers()
        .get(COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = cookie_value(header, COOKIE_NAME).ok_or_else(AppError::unauthorized)?;
    verify(&state.config.session_secret, &token).ok_or_else(AppError::unauthorized)?;
    Ok(next.run(request).await)
}
