use crate::state::{ApiError, AppState};
use axum::{
    async_trait,
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts},
};
use chrono::{Duration, Utc};
use common::{AppError, AppResult, UserRole};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: Uuid,
    pub email: String,
    pub role: UserRole,
    pub exp: usize,
    pub iat: usize,
}

pub fn create_jwt(
    user_id: Uuid,
    email: &str,
    role: UserRole,
    secret: &str,
    expiration_hours: i64,
) -> AppResult<String> {
    let now = Utc::now();
    let exp = now + Duration::hours(expiration_hours);

    let claims = JwtClaims {
        sub: user_id,
        email: email.to_string(),
        role,
        iat: usize::try_from(now.timestamp()).unwrap_or(0),
        exp: usize::try_from(exp.timestamp()).unwrap_or(0),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("JWT encode failed: {e}")))
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub role: UserRole,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header_val = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                ApiError(AppError::Unauthorized(
                    "missing Authorization header".to_string(),
                ))
            })?;

        let token = header_val.strip_prefix("Bearer ").ok_or_else(|| {
            ApiError(AppError::Unauthorized(
                "invalid Bearer token format".to_string(),
            ))
        })?;

        let data = decode::<JwtClaims>(
            token,
            &DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|_| {
            ApiError(AppError::Unauthorized(
                "invalid or expired JWT token".to_string(),
            ))
        })?;

        Ok(Self {
            user_id: data.claims.sub,
            role: data.claims.role,
        })
    }
}

#[derive(Debug, Clone)]
pub struct AdminUser(pub AuthUser);

#[async_trait]
impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth = AuthUser::from_request_parts(parts, state).await?;
        if auth.role != UserRole::Admin {
            return Err(ApiError(AppError::Forbidden(
                "admin privileges required".to_string(),
            )));
        }
        Ok(Self(auth))
    }
}
