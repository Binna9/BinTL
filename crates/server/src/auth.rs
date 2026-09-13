use axum::extract::Request;
use axum::http::header::COOKIE;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use storage::UserRow;

use crate::access::CurrentUser;
use crate::error::AppError;
use crate::state::AppState;

type HmacSha256 = Hmac<Sha256>;

const COOKIE_NAME: &str = "session";
pub const SESSION_TTL_SECS: u64 = 7 * 24 * 60 * 60;

fn payload(user_id: &str, issued_at: i64) -> String {
    format!("{user_id}.{issued_at}")
}

pub fn sign(secret: &str, user_id: &str) -> String {
    sign_at(secret, user_id, chrono::Utc::now().timestamp())
}

fn sign_at(secret: &str, user_id: &str, issued_at: i64) -> String {
    let payload = payload(user_id, issued_at);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(payload.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());
    format!("{payload}.{sig}")
}

pub fn verify(secret: &str, cookie: &str) -> Option<String> {
    verify_at(secret, cookie, chrono::Utc::now().timestamp())
}

fn verify_at(secret: &str, cookie: &str, now: i64) -> Option<String> {
    let (payload, sig) = cookie.rsplit_once('.')?;
    let (user_id, issued_raw) = payload.rsplit_once('.')?;
    let issued_at = issued_raw.parse::<i64>().ok()?;
    if issued_at > now || now.saturating_sub(issued_at) > SESSION_TTL_SECS as i64 {
        return None;
    }
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    if expected.len() != sig.len() {
        return None;
    }
    let Ok(got) = hex::decode(sig) else {
        return None;
    };
    let Ok(exp) = hex::decode(&expected) else {
        return None;
    };
    if got.len() != exp.len() || !constant_eq(&got, &exp) {
        return None;
    }
    Some(user_id.to_string())
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

pub fn session_cookie(secret: &str, user_id: &str) -> String {
    let value = sign(secret, user_id);
    format!(
        "{COOKIE_NAME}={value}; HttpOnly; Path=/; SameSite=Lax; Max-Age={SESSION_TTL_SECS}"
    )
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

async fn load_session_user(state: &AppState, cookie_header: &str) -> Result<UserRow, AppError> {
    if state.config.skip_auth {
        return state
            .store
            .ensure_bootstrap()
            .await
            .map_err(AppError::from);
    }
    let token = cookie_value(cookie_header, COOKIE_NAME).ok_or_else(AppError::unauthorized)?;
    let user_id =
        verify(&state.config.session_secret, &token).ok_or_else(AppError::unauthorized)?;
    let user = state
        .store
        .get_user(&user_id)
        .await?
        .ok_or_else(AppError::unauthorized)?;
    if user.active == 0 {
        return Err(AppError::unauthorized());
    }
    Ok(user)
}

pub async fn require_auth(state: AppState, mut request: Request, next: Next) -> Response {
    let cookie_header = request
        .headers()
        .get(COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    match load_session_user(&state, &cookie_header).await {
        Ok(user) => {
            request.extensions_mut().insert(CurrentUser(user));
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_cookie_expires_and_rejects_old_payload() {
        let secret = "test-session-secret";
        let user_id = "00000000-0000-0000-0000-0000000000aa";
        let now = 1_700_000_000;
        let fresh = sign_at(secret, user_id, now);
        assert_eq!(verify_at(secret, &fresh, now), Some(user_id.into()));
        assert_eq!(
            verify_at(secret, &fresh, now + SESSION_TTL_SECS as i64),
            Some(user_id.into())
        );
        assert!(verify_at(secret, &fresh, now + SESSION_TTL_SECS as i64 + 1).is_none());
        assert!(verify_at(secret, &fresh, now - 1).is_none());
        assert!(verify_at("other", &fresh, now).is_none());
        assert!(verify_at(secret, user_id, now).is_none());
    }
}
